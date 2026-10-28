/**
 * Client-Side WebAssembly FFmpeg Transcoder Engine
 * Runs 100% in the browser (including on static GitHub Pages deployments where /api/transcode is unavailable).
 * Uses single-threaded @ffmpeg/core UMD inside an inline Blob Web Worker so it requires ZERO
 * Cross-Origin-Isolation (COOP/COEP/SharedArrayBuffer) headers and produces ZERO extra asset chunks.
 * Converts unsupported video codecs (HEVC/H.265, MPEG-4 Part 2/DivX/XviD, MPEG-2) and containers
 * (.mkv, .avi, .ts, .flv, .mov, .mp4) into universal H.264 (avc1) + AAC MP4 with faststart.
 */

import { Channel, setCachedClientVodDuration } from './playlistParser';
import { buildPublicCorsProxyUrls, getHttpsSafeMediaUrls } from './proxyHelper';

export interface ClientTranscodeResult {
  blobUrl: string;
  durationSec: number | null;
  segmentStartSec: number;
  segmentDurationSec: number;
  sourceUrl: string;
  hasMoreSegments: boolean;
}

const FFMPEG_CORE_JS_CDN =
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js';
const FFMPEG_CORE_WASM_CDN =
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm';

const WORKER_CODE = `
let ffmpegCore = null;
let initPromise = null;
let currentLogs = [];

async function ensureLoaded(coreJsUrl, wasmUrl) {
  if (ffmpegCore) return ffmpegCore;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    importScripts(coreJsUrl);
    const factory = self.createFFmpegCore;
    if (typeof factory !== 'function') {
      throw new Error('createFFmpegCore not found in worker scope');
    }
    const core = await factory({
      mainScriptUrlOrBlob: coreJsUrl,
      locateFile: (path, prefix) => {
        if (path.endsWith('.wasm')) return wasmUrl;
        return prefix + path;
      },
    });
    core.setLogger((data) => {
      if (data && data.message) {
        currentLogs.push(String(data.message));
      }
    });
    ffmpegCore = core;
    return core;
  })();
  return initPromise;
}

function parseDurationFromLogs(logs) {
  const joined = logs.join('\\n');
  const match = joined.match(/Duration:\\s*(\\d{2,3}):(\\d{2}):(\\d{2}(?:\\.\\d+)?)/i);
  if (!match) return null;
  const hrs = parseFloat(match[1]);
  const mins = parseFloat(match[2]);
  const secs = parseFloat(match[3]);
  const total = hrs * 3600 + mins * 60 + secs;
  return Number.isFinite(total) && total > 0 ? total : null;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  const { id, type } = msg;
  if (type === 'warmup') {
    try {
      await ensureLoaded(msg.coreJsUrl, msg.wasmUrl);
      self.postMessage({ id, ok: true });
    } catch (err) {
      self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
    }
    return;
  }

  if (type === 'transcode') {
    const {
      coreJsUrl,
      wasmUrl,
      inputData,
      inputExt,
      seekSec,
      durationSec,
    } = msg;

    try {
      const core = await ensureLoaded(coreJsUrl, wasmUrl);
      currentLogs = [];

      const safeExt = (inputExt || '.mp4').startsWith('.') ? inputExt : '.' + inputExt;
      const inName = 'input' + safeExt;
      const outName = 'output.mp4';

      try { core.FS.unlink(inName); } catch (e) {}
      try { core.FS.unlink(outName); } catch (e) {}

      core.FS.writeFile(inName, new Uint8Array(inputData));

      const args = ['-hide_banner', '-y'];
      if (seekSec && seekSec > 0.5) {
        args.push('-ss', String(Math.floor(seekSec)));
      }
      args.push(
        '-err_detect', 'ignore_err',
        '-fflags', '+genpts+igndts+discardcorrupt',
        '-i', inName
      );
      if (durationSec && durationSec > 0) {
        args.push('-t', String(Math.floor(durationSec)));
      }
      args.push(
        '-map', '0:v:0?',
        '-map', '0:a:0?',
        '-sn',
        '-dn',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-profile:v', 'baseline',
        '-level', '3.1',
        '-pix_fmt', 'yuv420p',
        '-vf', "scale='min(854,iw)':-2",
        '-r', '24',
        '-g', '48',
        '-b:v', '750k',
        '-maxrate', '950k',
        '-bufsize', '1800k',
        '-c:a', 'aac',
        '-ac', '2',
        '-ar', '44100',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outName
      );

      try {
        core.exec(...args);
      } finally {
        try { core.reset(); } catch (e) {}
      }

      const detectedDuration = parseDurationFromLogs(currentLogs);
      let outputBytes = null;
      try {
        outputBytes = core.FS.readFile(outName);
      } catch (e) {
        outputBytes = null;
      }

      try { core.FS.unlink(inName); } catch (e) {}
      try { core.FS.unlink(outName); } catch (e) {}

      if (!outputBytes || outputBytes.byteLength < 1024) {
        throw new Error('FFmpeg WASM produced empty output (' + currentLogs.slice(-6).join(' | ') + ')');
      }

      const bufferCopy = outputBytes.buffer.slice(
        outputBytes.byteOffset,
        outputBytes.byteOffset + outputBytes.byteLength
      );

      self.postMessage(
        {
          id,
          ok: true,
          outputBuffer: bufferCopy,
          detectedDuration,
        },
        [bufferCopy]
      );
    } catch (err) {
      self.postMessage({
        id,
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }
};
`;

let sharedWorker: Worker | null = null;
let sharedWorkerBlobUrl: string | null = null;
let rpcCounter = 0;
const pendingRpc = new Map<
  number,
  {
    resolve: (val: any) => void;
    reject: (err: Error) => void;
  }
>();

function getOrCreateFfmpegWorker(): Worker {
  if (sharedWorker) return sharedWorker;
  const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
  sharedWorkerBlobUrl = URL.createObjectURL(blob);
  const worker = new Worker(sharedWorkerBlobUrl);
  worker.onmessage = (e: MessageEvent) => {
    const data = e.data || {};
    const { id, ok } = data;
    const handler = pendingRpc.get(id);
    if (!handler) return;
    pendingRpc.delete(id);
    if (ok) {
      handler.resolve(data);
    } else {
      handler.reject(new Error(data.error || 'FFmpeg worker error'));
    }
  };
  worker.onerror = (err) => {
    for (const [, handler] of pendingRpc.entries()) {
      handler.reject(new Error(err.message || 'FFmpeg worker crashed'));
    }
    pendingRpc.clear();
  };
  sharedWorker = worker;
  return worker;
}

/**
 * Pre-warms the WebAssembly FFmpeg worker in the background so it is immediately ready if needed.
 */
export function warmupClientFfmpeg(): void {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return;
  try {
    const worker = getOrCreateFfmpegWorker();
    const id = ++rpcCounter;
    pendingRpc.set(id, {
      resolve: () => {},
      reject: () => {},
    });
    worker.postMessage({
      id,
      type: 'warmup',
      coreJsUrl: FFMPEG_CORE_JS_CDN,
      wasmUrl: FFMPEG_CORE_WASM_CDN,
    });
  } catch {
    // ignore warmup failure
  }
}

function detectInputExtension(url: string): string {
  const clean = url.split('?')[0].split('#')[0].toLowerCase();
  if (clean.endsWith('.mkv')) return '.mkv';
  if (clean.endsWith('.avi')) return '.avi';
  if (clean.endsWith('.ts') || clean.endsWith('.m2ts') || clean.endsWith('.mts')) return '.ts';
  if (clean.endsWith('.flv')) return '.flv';
  if (clean.endsWith('.mov')) return '.mov';
  if (clean.endsWith('.webm')) return '.webm';
  if (clean.endsWith('.mpg') || clean.endsWith('.mpeg')) return '.mpg';
  if (clean.endsWith('.wmv')) return '.wmv';
  if (clean.endsWith('.m4v')) return '.m4v';
  if (/[?&](?:extension|output)=ts\b/i.test(url)) return '.ts';
  return '.mp4';
}

interface FetchChunkResult {
  bytes: Uint8Array;
  sourceUrl: string;
  totalSize: number | null;
  usedByteOffset: boolean;
}

/**
 * Downloads a bounded chunk of media bytes (default ~10 MB) from the target stream
 * using direct HTTPS, HTTPS upgrade, or CORS proxy fallback.
 */
async function fetchMediaBytesForFfmpeg(
  candidateUrls: string[],
  startByteOffset = 0,
  maxBytes = 10 * 1024 * 1024,
  signal?: AbortSignal
): Promise<FetchChunkResult> {
  const fetchUrls: string[] = [];
  const pushUnique = (u?: string) => {
    if (u && /^https?:\/\//i.test(u) && !fetchUrls.includes(u)) {
      fetchUrls.push(u);
    }
  };

  for (const raw of candidateUrls) {
    // 1. Direct or HTTPS-upgraded URL
    for (const safe of getHttpsSafeMediaUrls(raw, false)) {
      pushUnique(safe);
    }
    // 2. Public CORS proxies
    for (const cors of buildPublicCorsProxyUrls(raw)) {
      pushUnique(cors);
    }
  }

  let lastError: Error | null = null;

  for (const url of fetchUrls) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutId = window.setTimeout(() => controller.abort(), 7000);

    try {
      const headers: Record<string, string> = {};
      const endByte = startByteOffset + maxBytes - 1;
      const isCorsProxyWithoutRange =
        url.includes('allorigins.win') || url.includes('codetabs.com');

      if (!isCorsProxyWithoutRange) {
        headers['Range'] = `bytes=${startByteOffset}-${endByte}`;
      }

      const res = await fetch(url, {
        method: 'GET',
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        signal: controller.signal,
      });

      if (!res.ok && res.status !== 206) {
        continue;
      }

      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html') || ct.includes('application/json')) {
        continue;
      }

      let totalSize: number | null = null;
      const contentRange = res.headers.get('content-range');
      if (contentRange) {
        const m = contentRange.match(/\/(\d+)/);
        if (m) totalSize = parseInt(m[1], 10);
      } else {
        const cl = res.headers.get('content-length');
        if (cl && res.status === 200 && startByteOffset === 0) {
          const parsedCl = parseInt(cl, 10);
          if (Number.isFinite(parsedCl) && parsedCl > 0) {
            totalSize = parsedCl;
          }
        }
      }

      const usedByteOffset = startByteOffset > 0 && res.status === 206;

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;

        while (received < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            chunks.push(value);
            received += value.byteLength;
            if (received >= maxBytes) {
              try {
                await reader.cancel();
              } catch {
                // ignore
              }
              break;
            }
          }
        }

        if (received < 32 * 1024) {
          continue;
        }

        const merged = new Uint8Array(Math.min(received, maxBytes));
        let offset = 0;
        for (const chunk of chunks) {
          const sliceLen = Math.min(chunk.byteLength, merged.byteLength - offset);
          if (sliceLen <= 0) break;
          merged.set(chunk.subarray(0, sliceLen), offset);
          offset += sliceLen;
        }

        return {
          bytes: merged,
          sourceUrl: url,
          totalSize,
          usedByteOffset,
        };
      } else {
        const ab = await res.arrayBuffer();
        if (ab.byteLength < 32 * 1024) {
          continue;
        }
        const sliced = new Uint8Array(ab.slice(0, maxBytes));
        return {
          bytes: sliced,
          sourceUrl: url,
          totalSize,
          usedByteOffset,
        };
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      window.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  throw lastError || new Error('Unable to fetch stream bytes for client-side FFmpeg');
}

/**
 * Aligns a raw MPEG-TS buffer to the first valid 188-byte sync byte (0x47)
 * when a Range request started mid-stream.
 */
function alignMpegTsSyncByte(bytes: Uint8Array): Uint8Array {
  for (let i = 0; i < Math.min(bytes.byteLength - 376, 564); i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47 && bytes[i + 376] === 0x47) {
      return i === 0 ? bytes : bytes.subarray(i);
    }
  }
  return bytes;
}

/**
 * Transcodes a segment of the given channel/candidate URLs in the browser using WebAssembly FFmpeg
 * and returns a playable `blob:` MP4 URL with H.264 video and AAC audio.
 */
export async function transcodeChannelClientSide(
  channel: Channel,
  candidateUrls: string[],
  seekSec = 0,
  segmentDurationSec = 28,
  knownTotalDurationSec?: number | null,
  signal?: AbortSignal
): Promise<ClientTranscodeResult> {
  const allCandidates = Array.from(
    new Set([channel.url, ...candidateUrls].filter(Boolean))
  );
  const primaryExt = detectInputExtension(allCandidates[0] || channel.url);
  const isTsStream = primaryExt === '.ts';

  // Calculate byte budget:
  // If seeking inside a container that keeps its header at byte 0 (.mp4/.mkv/.avi/.mov),
  // scale the download size slightly if seeking within the first few minutes so FFmpeg has the bytes covering seekSec.
  const baseChunkBytes =
    seekSec > 15 && !isTsStream
      ? Math.min(12 * 1024 * 1024, (4 + Math.ceil(seekSec / 20)) * 1024 * 1024)
      : Math.floor(3.5 * 1024 * 1024);

  const fetched = await fetchMediaBytesForFfmpeg(
    allCandidates,
    0,
    baseChunkBytes,
    signal
  );

  let inputBytes = fetched.bytes;
  let internalSeekSec = seekSec;

  // If this is a headerless MPEG-TS (.ts) file and the user sought forward with known total size & duration,
  // we can fetch directly at the proportional byte offset!
  if (
    isTsStream &&
    seekSec > 10 &&
    fetched.totalSize &&
    fetched.totalSize > baseChunkBytes &&
    knownTotalDurationSec &&
    knownTotalDurationSec > seekSec
  ) {
    const ratio = Math.min(0.95, Math.max(0, seekSec / knownTotalDurationSec));
    const targetByteOffset = Math.floor(fetched.totalSize * ratio);
    if (targetByteOffset > 256 * 1024) {
      try {
        const offsetFetched = await fetchMediaBytesForFfmpeg(
          [fetched.sourceUrl, ...allCandidates],
          targetByteOffset,
          8 * 1024 * 1024,
          signal
        );
        if (offsetFetched.usedByteOffset) {
          inputBytes = alignMpegTsSyncByte(offsetFetched.bytes);
          internalSeekSec = 0;
        }
      } catch {
        // Fall back to byte-0 buffer
      }
    }
  }

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const worker = getOrCreateFfmpegWorker();
  const rpcId = ++rpcCounter;

  const inputBufferCopy = inputBytes.buffer.slice(
    inputBytes.byteOffset,
    inputBytes.byteOffset + inputBytes.byteLength
  );

  const workerResult = await new Promise<{
    outputBuffer: ArrayBuffer;
    detectedDuration: number | null;
  }>((resolve, reject) => {
    const onAbort = () => {
      pendingRpc.delete(rpcId);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    pendingRpc.set(rpcId, {
      resolve: (data) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(data);
      },
      reject: (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      },
    });

    worker.postMessage(
      {
        id: rpcId,
        type: 'transcode',
        coreJsUrl: FFMPEG_CORE_JS_CDN,
        wasmUrl: FFMPEG_CORE_WASM_CDN,
        inputData: inputBufferCopy,
        inputExt: detectInputExtension(fetched.sourceUrl || allCandidates[0]),
        seekSec: internalSeekSec,
        durationSec: segmentDurationSec,
      },
      [inputBufferCopy]
    );
  });

  const finalDuration =
    workerResult.detectedDuration || knownTotalDurationSec || null;
  if (finalDuration && finalDuration > 0) {
    for (const u of allCandidates) {
      setCachedClientVodDuration(u, finalDuration);
    }
  }

  const mp4Blob = new Blob([workerResult.outputBuffer], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(mp4Blob);

  const hasMoreSegments =
    !finalDuration || seekSec + segmentDurationSec < finalDuration - 2;

  return {
    blobUrl,
    durationSec: finalDuration,
    segmentStartSec: seekSec,
    segmentDurationSec,
    sourceUrl: fetched.sourceUrl,
    hasMoreSegments,
  };
}
