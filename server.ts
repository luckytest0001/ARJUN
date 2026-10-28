import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import { Readable } from 'stream';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

// Allow IPTV and VOD servers that use self-signed or incomplete SSL certificate chains
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const FFMPEG_BIN = fs.existsSync('/usr/bin/ffmpeg')
  ? '/usr/bin/ffmpeg'
  : ffmpegStatic || 'ffmpeg';

let activeLocalPort = Number(process.env.DEFAULT_APP_PORT) || 3000;

interface XtreamServerParams {
  server: string;
  username: string;
  password: string;
  streamId: string;
  streamType: 'live' | 'movie' | 'series';
  extension?: string;
  queryParams?: string;
}

interface CachedStreamInfo {
  finalUrl: string;
  usedUa: string;
  usedReferer?: string;
  cookieHeader?: string;
  macAddress?: string;
  authHeader?: string;
  detectedMime?: string;
  isM3u8?: boolean;
  duration?: number;
  updatedAt: number;
}

interface CachedStalkerSession {
  token: string;
  portalEndpoint: string;
  cookieHeader: string;
  updatedAt: number;
}

const resolvedStreamCache = new Map<string, CachedStreamInfo>();
const stalkerSessionCache = new Map<string, CachedStalkerSession>();

function getCachedStreamInfo(rawUrl: string): CachedStreamInfo | undefined {
  const { url } = sanitizeAndNormalizeUrl(rawUrl);
  const entry = resolvedStreamCache.get(url) || resolvedStreamCache.get(rawUrl.trim());
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > 30 * 60 * 1000) {
    resolvedStreamCache.delete(url);
    return undefined;
  }
  return entry;
}

function updateCachedStreamInfo(rawUrl: string, patch: Partial<CachedStreamInfo>): void {
  const { url } = sanitizeAndNormalizeUrl(rawUrl);
  const existing = resolvedStreamCache.get(url) || {
    finalUrl: url,
    usedUa: DEFAULT_BROWSER_UA,
    updatedAt: Date.now(),
  };
  const updated: CachedStreamInfo = {
    ...existing,
    ...patch,
    updatedAt: Date.now(),
  };
  resolvedStreamCache.set(url, updated);
  if (patch.finalUrl && patch.finalUrl !== url) {
    resolvedStreamCache.set(patch.finalUrl, updated);
  }
}

/**
 * Builds a numeric-IP loopback URL (http://127.0.0.1:PORT/api/proxy?...) so that
 * ffmpeg-static never performs glibc NSS DNS resolution (which segfaults in newer containers)
 * or direct TLS handshakes, while delegating HTTP Range requests, cookies, MAC/Xtream auth, and redirects to /api/proxy.
 */
function buildLocalProxyUrl(
  targetUrl: string,
  ua?: string,
  ref?: string,
  cookies?: string,
  mac?: string,
  auth?: string
): string {
  let cleanTarget = targetUrl;
  try {
    if (cleanTarget.includes('/api/proxy?') || cleanTarget.includes('/api/proxy/stream?')) {
      const parsed = new URL(cleanTarget, `http://127.0.0.1:${activeLocalPort}`);
      const innerUrl = parsed.searchParams.get('url');
      if (innerUrl) {
        cleanTarget = innerUrl;
        if (!ua) ua = parsed.searchParams.get('ua') || parsed.searchParams.get('userAgent') || undefined;
        if (!ref) ref = parsed.searchParams.get('ref') || parsed.searchParams.get('referer') || undefined;
        if (!cookies) cookies = parsed.searchParams.get('cookie') || parsed.searchParams.get('cookies') || undefined;
        if (!mac) mac = parsed.searchParams.get('mac') || parsed.searchParams.get('macAddress') || undefined;
        if (!auth) auth = parsed.searchParams.get('auth') || parsed.searchParams.get('authToken') || undefined;
      }
    }
  } catch {
    // ignore
  }

  let u = `http://127.0.0.1:${activeLocalPort}/api/proxy?url=${encodeURIComponent(cleanTarget)}`;
  if (ua) u += `&ua=${encodeURIComponent(ua)}`;
  if (ref) u += `&ref=${encodeURIComponent(ref)}`;
  if (cookies) u += `&cookie=${encodeURIComponent(cookies)}`;
  if (mac) u += `&mac=${encodeURIComponent(mac)}`;
  if (auth) u += `&auth=${encodeURIComponent(auth)}`;
  return u;
}

/**
 * Extracts VOD duration in seconds directly from an MP4/MOV 'mvhd' atom if present in the buffer.
 */
function parseMp4MvhdDuration(buf: Buffer | null): number | null {
  if (!buf || buf.length < 36) return null;
  const idx = buf.indexOf(Buffer.from('mvhd', 'ascii'));
  if (idx === -1 || idx + 24 > buf.length) return null;
  try {
    const version = buf.readUInt8(idx + 4);
    if (version === 0 && idx + 24 <= buf.length) {
      const timescale = buf.readUInt32BE(idx + 16);
      const duration = buf.readUInt32BE(idx + 20);
      if (timescale > 0 && duration > 0 && duration !== 0xffffffff) {
        const sec = duration / timescale;
        if (Number.isFinite(sec) && sec > 1 && sec < 86400) return sec;
      }
    } else if (version === 1 && idx + 36 <= buf.length) {
      const timescale = buf.readUInt32BE(idx + 24);
      const duration = Number(buf.readBigUInt64BE(idx + 28));
      if (timescale > 0 && duration > 0) {
        const sec = duration / timescale;
        if (Number.isFinite(sec) && sec > 1 && sec < 86400) return sec;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Extracts VOD duration in seconds from FFmpeg stderr ("Duration: HH:MM:SS.xx").
 */
function parseFfmpegDurationFromStderr(text: string): number | null {
  const m =
    text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i) ||
    text.match(/DURATION\s*:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const hrs = Number(m[1]);
  const mins = Number(m[2]);
  const secs = Number(m[3]);
  const total = hrs * 3600 + mins * 60 + secs;
  if (Number.isFinite(total) && total > 1 && total < 86400) {
    return total;
  }
  return null;
}

const DEFAULT_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const VLC_UA = 'VLC/3.0.20 LibVLC/3.0.20';
const SMARTERS_UA = 'IPTVSmartersPlayer';
const TIVIMATE_UA = 'TiviMate/4.7.0 (Linux; Android 12)';
const MAG_STB_UA =
  'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
const LAVF_UA = 'Lavf/60.16.100';

const SERVER_RESERVED_PATH_SEGMENTS = new Set([
  'live',
  'movie',
  'series',
  'play',
  'stalker_portal',
  'c',
  'server',
  'hls',
  'stream',
  'streams',
  'api',
  'download',
  'file',
  'details',
  'uc',
  'open',
  'vod',
  'tv',
  'channels',
  'ch',
  'portal.php',
  'load.php',
  'get.php',
  'player_api.php',
]);

function safeDecode(val: string): string {
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

function normalizeServerMacAddress(rawMac?: string): string | undefined {
  if (!rawMac) return undefined;
  const decoded = safeDecode(rawMac)
    .trim()
    .replace(/^["']+|["']+$/g, '');
  const colonOrDashMatch = decoded.match(
    /\b([0-9a-fA-F]{2})(?:[:-]([0-9a-fA-F]{2})){5}\b/
  );
  if (colonOrDashMatch) {
    return colonOrDashMatch[0].replace(/-/g, ':').toUpperCase();
  }
  const compactHexMatch = decoded.match(/^[0-9a-fA-F]{12}$/);
  if (compactHexMatch) {
    return (
      decoded
        .toUpperCase()
        .match(/.{1,2}/g)
        ?.join(':') || undefined
    );
  }
  return undefined;
}

function buildServerMacCookie(macAddress?: string, existingCookie?: string): string | undefined {
  const normMac = normalizeServerMacAddress(macAddress);
  if (!normMac && !existingCookie) return undefined;
  const parts: string[] = [];
  if (existingCookie) {
    existingCookie.split(';').forEach((c) => {
      const trimmed = c.trim();
      if (trimmed && !parts.includes(trimmed)) parts.push(trimmed);
    });
  }
  if (normMac) {
    if (!parts.some((p) => /^mac\s*=/i.test(p))) {
      parts.unshift(`mac=${normMac}`);
    }
    if (!parts.some((p) => /^stb_lang\s*=/i.test(p))) {
      parts.push('stb_lang=en');
    }
    if (!parts.some((p) => /^timezone\s*=/i.test(p))) {
      parts.push('timezone=GMT');
    }
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function parseXtreamAndMacParamsOnServer(cleanedUrl: string): {
  xtreamParams?: XtreamServerParams;
  macAddress?: string;
  authToken?: string;
  stalkerStreamId?: string;
} {
  let xtreamParams: XtreamServerParams | undefined;
  let macAddress: string | undefined;
  let authToken: string | undefined;
  let stalkerStreamId: string | undefined;

  const macQueryMatch = cleanedUrl.match(
    /[?&;#|](?:mac|deviceMac|stb_mac|mac_address|hw_id)=([^&#|;\s]+)/i
  );
  if (macQueryMatch?.[1]) {
    macAddress = normalizeServerMacAddress(macQueryMatch[1]);
  }
  if (!macAddress) {
    macAddress = normalizeServerMacAddress(safeDecode(cleanedUrl));
  }

  const tokenMatch = cleanedUrl.match(
    /[?&](?:play_token|token|access_token|auth_token|auth|jwt|wmsAuthSign)=([^&#|\s]+)/i
  );
  if (tokenMatch?.[1]) {
    authToken = safeDecode(tokenMatch[1]).trim();
  }

  const stalkerStreamMatch =
    cleanedUrl.match(/[?&](?:stream|ch_id|channelId|ch|channel|id)=(\d+)/i) ||
    cleanedUrl.match(/(?:\/ch\/|\/live\/)(\d+)(?:\.ts|\.m3u8|_|\/|\?|$)/i);
  if (stalkerStreamMatch?.[1]) {
    stalkerStreamId = stalkerStreamMatch[1];
  }

  const explicitXtreamMatch = cleanedUrl.match(
    /^(https?:\/\/[^/?#]+)\/(live|movie|series)\/([^/?#]+)\/([^/?#]+)\/([^/?#.]+)(?:\.([a-zA-Z0-9]{2,5}))?(?:\?([^#]*))?$/i
  );
  if (explicitXtreamMatch) {
    xtreamParams = {
      server: explicitXtreamMatch[1],
      streamType: explicitXtreamMatch[2].toLowerCase() as 'live' | 'movie' | 'series',
      username: safeDecode(explicitXtreamMatch[3]),
      password: safeDecode(explicitXtreamMatch[4]),
      streamId: explicitXtreamMatch[5],
      extension: explicitXtreamMatch[6]?.toLowerCase(),
      queryParams: explicitXtreamMatch[7],
    };
    return { xtreamParams, macAddress, authToken, stalkerStreamId };
  }

  const shortXtreamMatch = cleanedUrl.match(
    /^(https?:\/\/[^/?#]+)\/([^/?#]+)\/([^/?#]+)\/(\d+)(?:\.([a-zA-Z0-9]{2,5}))?(?:\?([^#]*))?$/i
  );
  if (shortXtreamMatch) {
    const s1 = shortXtreamMatch[2].toLowerCase();
    const s2 = shortXtreamMatch[3].toLowerCase();
    if (!SERVER_RESERVED_PATH_SEGMENTS.has(s1) && !SERVER_RESERVED_PATH_SEGMENTS.has(s2)) {
      xtreamParams = {
        server: shortXtreamMatch[1],
        username: safeDecode(shortXtreamMatch[2]),
        password: safeDecode(shortXtreamMatch[3]),
        streamId: shortXtreamMatch[4],
        streamType: 'live',
        extension: shortXtreamMatch[5]?.toLowerCase(),
        queryParams: shortXtreamMatch[6],
      };
      return { xtreamParams, macAddress, authToken, stalkerStreamId };
    }
  }

  try {
    const parsed = new URL(cleanedUrl);
    const qUser =
      parsed.searchParams.get('username') ||
      parsed.searchParams.get('user') ||
      parsed.searchParams.get('login');
    const qPass =
      parsed.searchParams.get('password') ||
      parsed.searchParams.get('pass');
    const qStream =
      parsed.searchParams.get('stream') ||
      parsed.searchParams.get('stream_id') ||
      parsed.searchParams.get('id') ||
      parsed.searchParams.get('ch_id');
    const qExt =
      parsed.searchParams.get('extension') ||
      parsed.searchParams.get('output') ||
      parsed.searchParams.get('type');
    if (qUser && qPass) {
      const pathStreamMatch = parsed.pathname.match(/\/(\d+)(?:\.([a-zA-Z0-9]{2,5}))?$/);
      const streamId = qStream || pathStreamMatch?.[1] || '';
      if (streamId) {
        const lowerPath = parsed.pathname.toLowerCase();
        const streamType: 'live' | 'movie' | 'series' = lowerPath.includes('movie')
          ? 'movie'
          : lowerPath.includes('series')
          ? 'series'
          : 'live';
        xtreamParams = {
          server: parsed.origin,
          username: qUser,
          password: qPass,
          streamId,
          streamType,
          extension: (qExt || pathStreamMatch?.[2] || undefined)?.toLowerCase(),
          queryParams: parsed.search ? parsed.search.slice(1) : undefined,
        };
      }
    }
  } catch {
    // ignore
  }

  return { xtreamParams, macAddress, authToken, stalkerStreamId };
}

function sanitizeAndNormalizeUrl(rawUrl: string): {
  url: string;
  pipeUa?: string;
  pipeReferer?: string;
  pipeCookie?: string;
  pipeMac?: string;
  pipeAuth?: string;
  xtreamParams?: XtreamServerParams;
  stalkerStreamId?: string;
} {
  let cleaned = rawUrl
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");

  // Strip Stalker command prefixes like "ffmpeg http://..." or "ffrt3 http://..."
  cleaned = cleaned
    .replace(/^(?:ffmpeg|ffrt\d*|solution)\s+(?=(?:https?|rtmp|rtsp|udp|mms):\/\/)/i, '')
    .trim();

  let pipeUa: string | undefined;
  let pipeReferer: string | undefined;
  let pipeCookie: string | undefined;
  let pipeMac: string | undefined;
  let pipeAuth: string | undefined;

  const pipeIdx = cleaned.indexOf('|');
  if (pipeIdx !== -1) {
    const headerPart = cleaned.slice(pipeIdx + 1).trim();
    cleaned = cleaned.slice(0, pipeIdx).trim();
    headerPart.split(/[&|]/).forEach((pair) => {
      const eq = pair.indexOf('=');
      if (eq !== -1) {
        const k = pair.slice(0, eq).trim().toLowerCase();
        const rawV = pair
          .slice(eq + 1)
          .trim()
          .replace(/^["']+|["']+$/g, '');
        const v = safeDecode(rawV);
        if (k === 'user-agent' || k === 'useragent' || k === 'http-user-agent') {
          pipeUa = v;
        } else if (
          k === 'referer' ||
          k === 'referrer' ||
          k === 'origin' ||
          k === 'http-referer' ||
          k === 'http-referrer'
        ) {
          pipeReferer = v;
        } else if (k === 'cookie' || k === 'cookies' || k === 'http-cookie') {
          pipeCookie = pipeCookie ? `${pipeCookie}; ${v}` : v;
          const m = normalizeServerMacAddress(v);
          if (m && !pipeMac) pipeMac = m;
        } else if (
          k === 'mac' ||
          k === 'mac-address' ||
          k === 'mac_address' ||
          k === 'stb-mac' ||
          k === 'stb_mac' ||
          k === 'devicemac'
        ) {
          const m = normalizeServerMacAddress(v);
          if (m) pipeMac = m;
        } else if (
          k === 'authorization' ||
          k === 'auth' ||
          k === 'token' ||
          k === 'play_token' ||
          k === 'bearer' ||
          k === 'x-auth-token'
        ) {
          pipeAuth = v;
        }
      }
    });
  }

  cleaned = cleaned.split(/["'<>]/)[0].trim();
  cleaned = cleaned.replace(
    /\.(mp4|mkv|m3u8|ts|webm|avi|mov|m4v|flv|mp3|aac)(?:br|\/p|\/div|\/a|\/span|\/li|\/td|\/pre|\/body|\/html)+$/i,
    '.$1'
  );

  if (cleaned.startsWith('//')) {
    cleaned = `https:${cleaned}`;
  }

  // Google Drive direct download conversion
  const gdriveFileMatch = cleaned.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i);
  const gdriveIdMatch = cleaned.match(
    /drive\.google\.com\/(?:open|uc)\?[^#]*\bid=([a-zA-Z0-9_-]+)/i
  );
  const gdriveId = gdriveFileMatch?.[1] || gdriveIdMatch?.[1];
  if (gdriveId) {
    cleaned = `https://drive.usercontent.google.com/download?id=${gdriveId}&export=download&confirm=t`;
  }

  // Pixeldrain conversion
  const pixeldrainMatch = cleaned.match(/pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)/i);
  if (pixeldrainMatch?.[1]) {
    cleaned = `https://pixeldrain.com/api/file/${pixeldrainMatch[1]}`;
  }

  // Dropbox conversion
  if (/^https?:\/\/(?:www\.)?dropbox\.com\//i.test(cleaned)) {
    cleaned = cleaned
      .replace(/^https?:\/\/(?:www\.)?dropbox\.com\//i, 'https://dl.dropboxusercontent.com/')
      .replace(/[?&]dl=0\b/i, '');
  }

  cleaned = cleaned.replace(/ /g, '%20');

  const parsedAuth = parseXtreamAndMacParamsOnServer(cleaned);
  const resolvedMac = pipeMac || parsedAuth.macAddress;
  const resolvedCookie = buildServerMacCookie(resolvedMac, pipeCookie);

  return {
    url: cleaned,
    pipeUa,
    pipeReferer,
    pipeCookie: resolvedCookie,
    pipeMac: resolvedMac,
    pipeAuth: pipeAuth || parsedAuth.authToken,
    xtreamParams: parsedAuth.xtreamParams,
    stalkerStreamId: parsedAuth.stalkerStreamId,
  };
}

interface UpstreamResult {
  res: Readable;
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  finalUrl: string;
  usedUa: string;
  usedReferer?: string;
  cookieHeader?: string;
  macAddress?: string;
  authHeader?: string;
  destroy: () => void;
}

/**
 * Low-level HTTP/HTTPS request with insecureHTTPParser, modern-first TLS with automatic
 * legacy TLS fallback, transparent gzip/deflate decompression, manual redirect following
 * (up to 8 hops), space encoding in Location headers, and cookie/MAC/auth forwarding across redirects.
 */
function requestSingleAttempt(
  startUrl: string,
  options: {
    userAgent: string;
    referer?: string;
    cookie?: string;
    macAddress?: string;
    authHeader?: string;
    range?: string;
    timeoutMs?: number;
    legacyTls?: boolean;
  }
): Promise<UpstreamResult> {
  return new Promise((resolve, reject) => {
    const cookies: string[] = [];
    const effectiveCookieStr = buildServerMacCookie(options.macAddress, options.cookie);
    if (effectiveCookieStr) {
      effectiveCookieStr.split(';').forEach((c) => {
        const trimmed = c.trim();
        if (trimmed && !cookies.includes(trimmed)) cookies.push(trimmed);
      });
    }
    let settled = false;

    const follow = (targetUrl: string, redirectsLeft: number, useLegacyTls: boolean) => {
      if (settled) return;
      if (redirectsLeft < 0) {
        settled = true;
        reject(new Error('Too many redirects'));
        return;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(targetUrl.replace(/ /g, '%20'));
      } catch (err) {
        settled = true;
        reject(err);
        return;
      }

      const isHttps = parsedUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const reqHeaders: Record<string, string> = {
        'User-Agent': options.userAgent,
        Accept: '*/*',
        'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8,hi;q=0.7',
        Connection: 'keep-alive',
      };

      if (options.macAddress) {
        reqHeaders['X-User-Agent'] = 'Model: MAG250; Link: WiFi';
        reqHeaders['X-MAC'] = options.macAddress;
        reqHeaders['X-Device-Id'] = options.macAddress;
        reqHeaders['X-Device-Id2'] = options.macAddress;
      }
      if (options.authHeader) {
        const trimmedAuth = options.authHeader.trim();
        reqHeaders['Authorization'] = /^(?:Bearer|Basic)\s+/i.test(trimmedAuth)
          ? trimmedAuth
          : `Bearer ${trimmedAuth}`;
      }
      if (options.referer) {
        reqHeaders['Referer'] = options.referer;
        try {
          reqHeaders['Origin'] = new URL(options.referer).origin;
        } catch {
          // ignore invalid referer URL
        }
      }
      if (options.range) {
        reqHeaders['Range'] = options.range;
      }
      if (cookies.length > 0) {
        reqHeaders['Cookie'] = cookies.join('; ');
      }

      const reqOptions: https.RequestOptions = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: reqHeaders,
        insecureHTTPParser: true,
        rejectUnauthorized: false,
        timeout: options.timeoutMs || 16000,
      };

      if (isHttps && useLegacyTls) {
        reqOptions.ciphers = 'DEFAULT:@SECLEVEL=0';
        reqOptions.minVersion = 'TLSv1';
      }

      const timeoutMs = options.timeoutMs || 14000;
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            req.destroy(new Error(`Upstream connection timeout after ${timeoutMs}ms`));
          } catch {
            // ignore
          }
          reject(new Error(`Upstream connection timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const clearTimer = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const req = transport.request(reqOptions, (res) => {
        if (settled) {
          clearTimer();
          res.resume();
          return;
        }

        const setCookie = res.headers['set-cookie'];
        if (Array.isArray(setCookie)) {
          setCookie.forEach((c) => {
            const pair = c.split(';')[0]?.trim();
            if (pair && !cookies.includes(pair)) cookies.push(pair);
          });
        }

        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          clearTimer();
          const rawLocation = String(res.headers.location).trim().replace(/ /g, '%20');
          res.resume();
          try {
            const nextUrl = new URL(rawLocation, parsedUrl).toString();
            follow(nextUrl, redirectsLeft - 1, useLegacyTls);
          } catch (err) {
            settled = true;
            reject(err);
          }
          return;
        }

        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        let outputStream: Readable = res;
        const headersCopy: http.IncomingHttpHeaders = { ...res.headers };

        if (encoding === 'gzip' || encoding === 'x-gzip') {
          const gunzip = zlib.createGunzip();
          res.pipe(gunzip);
          outputStream = gunzip;
          delete headersCopy['content-encoding'];
          delete headersCopy['content-length'];
        } else if (encoding === 'deflate') {
          const inflate = zlib.createInflate();
          res.pipe(inflate);
          outputStream = inflate;
          delete headersCopy['content-encoding'];
          delete headersCopy['content-length'];
        }

        clearTimer();
        settled = true;
        resolve({
          res: outputStream,
          statusCode: status,
          headers: headersCopy,
          finalUrl: parsedUrl.toString(),
          usedUa: options.userAgent,
          usedReferer: options.referer,
          cookieHeader: cookies.length > 0 ? cookies.join('; ') : undefined,
          macAddress: options.macAddress,
          authHeader: options.authHeader,
          destroy: () => {
            clearTimer();
            try {
              outputStream.destroy();
            } catch {
              // ignore
            }
            try {
              res.destroy();
            } catch {
              // ignore
            }
            try {
              req.destroy();
            } catch {
              // ignore
            }
          },
        });
      });

      req.on('timeout', () => {
        clearTimer();
        req.destroy(new Error('Upstream connection timeout'));
      });

      req.on('error', (err: NodeJS.ErrnoException) => {
        clearTimer();
        if (settled) return;
        const msg = String(err?.message || '');
        const code = String(err?.code || '');
        // If modern TLS failed due to legacy SSL cipher/protocol on an older IPTV panel, retry once with legacy TLS
        if (
          isHttps &&
          !useLegacyTls &&
          (code.includes('SSL') ||
            code.includes('TLS') ||
            code === 'EPROTO' ||
            /ssl|tls|cipher|handshake|dh key/i.test(msg))
        ) {
          follow(targetUrl, redirectsLeft, true);
          return;
        }
        settled = true;
        reject(err);
      });

      req.end();
    };

    follow(startUrl, 8, Boolean(options.legacyTls));
  });
}

async function readStreamToString(stream: Readable, maxBytes = 524288): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const ch of stream) {
      const b = Buffer.isBuffer(ch) ? ch : Buffer.from(ch);
      chunks.push(b);
      total += b.length;
      if (total >= maxBytes) break;
    }
  } catch {
    // ignore
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Performs a Stalker / Ministra MAG STB Portal Handshake & Profile Authentication
 * for a given server origin and MAC address, returning the Bearer token and cookies.
 */
async function authenticateStalkerMacPortal(
  targetUrl: string,
  macAddress: string,
  existingCookie?: string
): Promise<CachedStalkerSession | null> {
  let origin: string;
  let basePath = '';
  let directPhpPath: string | null = null;
  try {
    const u = new URL(targetUrl);
    origin = u.origin;
    if (/\.(php|aspx|jsp)\b/i.test(u.pathname)) {
      directPhpPath = u.pathname;
    }
    const cleanPath = u.pathname
      .replace(/\/(?:portal|load|index)\.php$/i, '')
      .replace(/\/c\/?$/i, '')
      .replace(/\/server\/?$/i, '')
      .replace(/\/+$/, '');
    if (cleanPath && cleanPath !== '/') {
      basePath = cleanPath;
    }
  } catch {
    return null;
  }

  const normMac = normalizeServerMacAddress(macAddress);
  if (!normMac) return null;

  const cacheKey = `${origin}${basePath}|${normMac}`;
  const cached = stalkerSessionCache.get(cacheKey);
  if (cached && Date.now() - cached.updatedAt < 20 * 60 * 1000) {
    return cached;
  }

  const baseCookie = buildServerMacCookie(normMac, existingCookie) || `mac=${normMac}; stb_lang=en; timezone=GMT`;
  const candidateEndpoints: string[] = [];

  if (directPhpPath) {
    candidateEndpoints.push(`${origin}${directPhpPath}`);
  }
  if (basePath) {
    candidateEndpoints.push(`${origin}${basePath}/c/portal.php`);
    candidateEndpoints.push(`${origin}${basePath}/portal.php`);
    candidateEndpoints.push(`${origin}${basePath}/server/load.php`);
    candidateEndpoints.push(`${origin}${basePath}/load.php`);
    candidateEndpoints.push(`${origin}${basePath}/c/`);
  }
  candidateEndpoints.push(
    `${origin}/c/portal.php`,
    `${origin}/portal.php`,
    `${origin}/server/load.php`,
    `${origin}/load.php`,
    `${origin}/stalker_portal/c/portal.php`,
    `${origin}/stalker_portal/server/load.php`,
    `${origin}/stalker_portal/portal.php`,
    `${origin}/stalker_portal/load.php`
  );

  const seenEndpoints = new Set<string>();
  const uniqueEndpoints = candidateEndpoints.filter((ep) => {
    if (seenEndpoints.has(ep)) return false;
    seenEndpoints.add(ep);
    return true;
  });

  for (const endpoint of uniqueEndpoints) {
    try {
      const hsUrl = `${endpoint}?type=stb&action=handshake&token=&mac=${encodeURIComponent(normMac)}&JsHttpRequest=1-xml`;
      const hsRes = await requestSingleAttempt(hsUrl, {
        userAgent: MAG_STB_UA,
        referer: `${origin}/c/`,
        cookie: baseCookie,
        macAddress: normMac,
        timeoutMs: 5500,
      });
      const text = await readStreamToString(hsRes.res, 65536);
      hsRes.destroy();

      if (hsRes.statusCode >= 200 && hsRes.statusCode < 300 && text.includes('token')) {
        const parsed = JSON.parse(text) as { js?: { token?: string } };
        const token = parsed?.js?.token?.trim();
        if (token) {
          const mergedCookie = hsRes.cookieHeader || baseCookie;
          // Activate session with get_profile
          try {
            const profUrl = `${endpoint}?type=stb&action=get_profile&hd=1&stb_type=MAG250&JsHttpRequest=1-xml`;
            const profRes = await requestSingleAttempt(profUrl, {
              userAgent: MAG_STB_UA,
              referer: `${origin}/c/`,
              cookie: mergedCookie,
              macAddress: normMac,
              authHeader: `Bearer ${token}`,
              timeoutMs: 4500,
            });
            profRes.destroy();
          } catch {
            // ignore profile errors
          }

          const session: CachedStalkerSession = {
            token,
            portalEndpoint: endpoint,
            cookieHeader: mergedCookie,
            updatedAt: Date.now(),
          };
          stalkerSessionCache.set(cacheKey, session);
          stalkerSessionCache.set(`${origin}|${normMac}`, session);
          return session;
        }
      }
    } catch {
      // try next portal endpoint
    }
  }

  return null;
}

/**
 * Requests a fresh authenticated stream link (with play_token) from a Stalker portal
 * using `action=create_link` when a MAC-protected stream ID is known.
 */
async function createStalkerAuthenticatedStreamLink(
  session: CachedStalkerSession,
  macAddress: string,
  streamId: string,
  origin: string
): Promise<string | null> {
  const cmdsToTry = [
    `ffrt http://localhost/ch/${streamId}`,
    `ffmpeg http://localhost/ch/${streamId}`,
    `http://localhost/ch/${streamId}`,
  ];

  for (const cmd of cmdsToTry) {
    try {
      const linkUrl = `${session.portalEndpoint}?type=itv&action=create_link&cmd=${encodeURIComponent(
        cmd
      )}&series=&forced_storage=0&disable_ad=0&download=0&force_ch_link_check=0&JsHttpRequest=1-xml`;
      const res = await requestSingleAttempt(linkUrl, {
        userAgent: MAG_STB_UA,
        referer: `${origin}/c/`,
        cookie: session.cookieHeader,
        macAddress,
        authHeader: `Bearer ${session.token}`,
        timeoutMs: 5500,
      });
      const body = await readStreamToString(res.res, 65536);
      res.destroy();

      if (res.statusCode >= 200 && res.statusCode < 300 && body.includes('cmd')) {
        const parsed = JSON.parse(body) as { js?: { cmd?: string } };
        const rawCmd = parsed?.js?.cmd?.trim();
        if (rawCmd) {
          const cleanLink = rawCmd
            .replace(/^(?:ffmpeg|ffrt\d*|solution)\s+/i, '')
            .trim();
          if (/^https?:\/\//i.test(cleanLink)) {
            return cleanLink;
          }
        }
      }
    } catch {
      // try next cmd format
    }
  }
  return null;
}

/**
 * Resolves Archive.org /details/<id> or truncated Archive.org /download/<id>/<prefix> URLs,
 * as well as truncated directory filenames using the channel title.
 */
async function tryRecoverOrResolveSpecialVodUrl(
  targetUrl: string,
  channelTitle?: string
): Promise<string[]> {
  const candidates: string[] = [];

  // 1. Archive.org /details/<item> or /download/<item>/<file>
  const archiveMatch = targetUrl.match(
    /^https?:\/\/(?:www\.)?archive\.org\/(?:details|download)\/([^/?#]+)(?:\/([^?#]*))?/i
  );
  if (archiveMatch) {
    const itemId = archiveMatch[1];
    const subPath = archiveMatch[2] ? decodeURIComponent(archiveMatch[2]).trim() : '';
    try {
      const metaAttempt = await requestSingleAttempt(
        `https://archive.org/metadata/${encodeURIComponent(itemId)}`,
        { userAgent: DEFAULT_BROWSER_UA, timeoutMs: 8000 }
      );
      if (metaAttempt.statusCode === 200) {
        const chunks: Buffer[] = [];
        for await (const chunk of metaAttempt.res) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const metaJson = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          files?: Array<{ name?: string; format?: string }>;
        };
        const files = metaJson.files || [];
        const videoFiles = files.filter(
          (f) => f.name && /\.(mp4|mkv|webm|avi|mov|m4v|ts|flv)$/i.test(f.name)
        );

        const cleanTitle = (channelTitle || '').trim().toLowerCase();
        const cleanSub = subPath.toLowerCase();

        // Exact or prefix match on subPath or channelTitle
        const matched =
          videoFiles.find((f) => cleanSub && f.name!.toLowerCase() === cleanSub) ||
          videoFiles.find((f) => cleanSub && f.name!.toLowerCase().startsWith(cleanSub)) ||
          videoFiles.find(
            (f) =>
              cleanTitle &&
              (f.name!.toLowerCase().startsWith(cleanTitle) ||
                f.name!.toLowerCase().includes(cleanTitle))
          ) ||
          videoFiles[0];

        if (matched?.name) {
          const encodedName = matched.name
            .split('/')
            .map((seg) => encodeURIComponent(seg))
            .join('/');
          candidates.push(`https://archive.org/download/${itemId}/${encodedName}`);
        }
      } else {
        metaAttempt.destroy();
      }
    } catch {
      // ignore metadata lookup errors
    }
  }

  // 2. If URL has no media extension (e.g. truncated at space in localStorage) and channelTitle is known
  const hasMediaExt = /\.(mp4|mkv|m3u8|ts|webm|avi|mov|m4v|flv)(\?|$)/i.test(targetUrl);
  if (!hasMediaExt && channelTitle) {
    try {
      const u = new URL(targetUrl);
      const pathParts = u.pathname.split('/');
      const lastSeg = decodeURIComponent(pathParts[pathParts.length - 1] || '').trim();
      const cleanTitle = channelTitle.trim();
      if (
        lastSeg &&
        cleanTitle.toLowerCase().startsWith(lastSeg.toLowerCase()) &&
        cleanTitle.length > lastSeg.length
      ) {
        const baseDir = pathParts.slice(0, -1).join('/');
        const encodedTitle = encodeURIComponent(cleanTitle).replace(/%20/g, '%20');
        candidates.push(`${u.origin}${baseDir}/${encodedTitle}.mp4${u.search}`);
        candidates.push(`${u.origin}${baseDir}/${encodedTitle}.mkv${u.search}`);
      }
    } catch {
      // ignore
    }
  }

  return candidates;
}

/**
 * Builds candidate Xtream Codes stream URLs (e.g., .ts, .m3u8, /live/ prefix)
 * and warms up session cookies via player_api.php if needed.
 */
function buildXtreamCandidateUrls(
  primaryUrl: string,
  xp?: XtreamServerParams
): string[] {
  const list: string[] = [primaryUrl];
  if (!xp) return list;

  const base = xp.server.replace(/\/+$/, '');
  const u = encodeURIComponent(xp.username);
  const p = encodeURIComponent(xp.password);
  const id = encodeURIComponent(xp.streamId);
  const qs = xp.queryParams ? `?${xp.queryParams}` : '';

  const pushUnique = (uStr: string) => {
    if (uStr && !list.includes(uStr)) list.push(uStr);
  };

  if (xp.streamType === 'live') {
    if (xp.extension === 'm3u8') {
      pushUnique(`${base}/live/${u}/${p}/${id}.m3u8${qs}`);
      pushUnique(`${base}/live/${u}/${p}/${id}.ts${qs}`);
      pushUnique(`${base}/${u}/${p}/${id}${qs}`);
      pushUnique(`${base}/live/${u}/${p}/${id}${qs}`);
    } else {
      pushUnique(`${base}/live/${u}/${p}/${id}.ts${qs}`);
      pushUnique(`${base}/live/${u}/${p}/${id}.m3u8${qs}`);
      pushUnique(`${base}/${u}/${p}/${id}${qs}`);
      pushUnique(`${base}/live/${u}/${p}/${id}${qs}`);
    }
  } else {
    const ext = xp.extension || 'mp4';
    pushUnique(`${base}/${xp.streamType}/${u}/${p}/${id}.${ext}${qs}`);
    if (ext !== 'mp4') pushUnique(`${base}/${xp.streamType}/${u}/${p}/${id}.mp4${qs}`);
    if (ext !== 'mkv') pushUnique(`${base}/${xp.streamType}/${u}/${p}/${id}.mkv${qs}`);
  }

  return list;
}

/**
 * Connects to an upstream URL with automatic User-Agent & Referer fallback,
 * Xtream Codes API authentication & URL format fallbacks, Stalker Portal MAC
 * handshake & token acquisition, and truncated/Archive.org URL recovery.
 */
async function connectUpstreamWithFallbacks(
  rawUrl: string,
  options: {
    customUa?: string;
    customReferer?: string;
    customCookie?: string;
    customMac?: string;
    customAuth?: string;
    xtreamParams?: XtreamServerParams;
    channelTitle?: string;
    range?: string;
    timeoutMs?: number;
  }
): Promise<UpstreamResult> {
  const {
    url: normalizedUrl,
    pipeUa,
    pipeReferer,
    pipeCookie,
    pipeMac,
    pipeAuth,
    xtreamParams: parsedXtreamParams,
    stalkerStreamId,
  } = sanitizeAndNormalizeUrl(rawUrl);

  const effectiveUa = options.customUa || pipeUa;
  const effectiveRef = options.customReferer || pipeReferer;
  const effectiveMac =
    normalizeServerMacAddress(options.customMac) ||
    pipeMac ||
    normalizeServerMacAddress(options.customCookie);
  let effectiveCookie = buildServerMacCookie(
    effectiveMac,
    options.customCookie || pipeCookie
  );
  const effectiveXtream = options.xtreamParams || parsedXtreamParams;

  // Build initial Authorization header (if token/auth was provided or Basic auth for Xtream)
  let effectiveAuth = options.customAuth || pipeAuth;
  let xtreamBasicAuth: string | undefined;
  if (effectiveXtream?.username && effectiveXtream?.password) {
    xtreamBasicAuth = `Basic ${Buffer.from(
      `${effectiveXtream.username}:${effectiveXtream.password}`
    ).toString('base64')}`;
  }

  // Fast path for Range seeks and reconnects: if we already resolved this stream URL,
  // try the known-good finalUrl + User-Agent + Referer + Cookie + MAC/Auth immediately first.
  const cached = getCachedStreamInfo(normalizedUrl);
  if (cached && cached.finalUrl) {
    try {
      const fastRes = await requestSingleAttempt(cached.finalUrl, {
        userAgent: cached.usedUa || effectiveUa || DEFAULT_BROWSER_UA,
        referer: cached.usedReferer || effectiveRef,
        cookie: effectiveCookie || cached.cookieHeader,
        macAddress: effectiveMac || cached.macAddress,
        authHeader: effectiveAuth || cached.authHeader,
        range: options.range,
        timeoutMs: 10000,
      });
      const st = fastRes.statusCode || 0;
      if (st >= 200 && st < 300) {
        const ct = String(fastRes.headers['content-type'] || '').toLowerCase();
        if (!ct.includes('text/html')) {
          return fastRes;
        }
      }
      fastRes.destroy();
    } catch {
      // Fall through to full discovery
    }
  }

  let originReferer: string | undefined;
  let originBase: string | undefined;
  try {
    const uObj = new URL(normalizedUrl);
    originBase = uObj.origin;
    originReferer = `${uObj.origin}/`;
  } catch {
    // ignore
  }

  // If a MAC address is present or this is a Stalker portal URL (/play/live.php, /stalker_portal/, /portal.php),
  // perform or retrieve cached Stalker STB Handshake token so the stream request is authenticated.
  let stalkerSession: CachedStalkerSession | null = null;
  const isStalkerPath =
    Boolean(effectiveMac) ||
    /\/(?:play\/live\.php|stalker_portal|portal\.php|server\/load\.php)\b/i.test(normalizedUrl);

  if (effectiveMac && isStalkerPath) {
    stalkerSession = await authenticateStalkerMacPortal(
      normalizedUrl,
      effectiveMac,
      effectiveCookie
    );
    if (stalkerSession) {
      effectiveCookie = buildServerMacCookie(effectiveMac, stalkerSession.cookieHeader);
      if (!effectiveAuth && stalkerSession.token) {
        effectiveAuth = `Bearer ${stalkerSession.token}`;
      }
    }
  }

  // Build candidate URLs to try (Archive.org resolution + Xtream Codes format variants)
  let urlsToTry = buildXtreamCandidateUrls(normalizedUrl, effectiveXtream);
  if (/^https?:\/\/(?:www\.)?archive\.org\/details\//i.test(normalizedUrl)) {
    const recovered = await tryRecoverOrResolveSpecialVodUrl(normalizedUrl, options.channelTitle);
    if (recovered.length > 0) {
      urlsToTry = [...recovered, ...urlsToTry];
    }
  }

  // Pre-resolve authenticated Stalker stream link if stalkerStreamId & session are available
  if (effectiveMac && stalkerSession && stalkerStreamId && originBase) {
    try {
      const freshStalkerUrl = await createStalkerAuthenticatedStreamLink(
        stalkerSession,
        effectiveMac,
        stalkerStreamId,
        originBase
      );
      if (freshStalkerUrl && !urlsToTry.includes(freshStalkerUrl)) {
        urlsToTry.unshift(freshStalkerUrl);
      }
    } catch {
      // ignore
    }
  }

  const rawProfiles: Array<{ ua: string; ref?: string; auth?: string }> = [];
  if (effectiveMac) {
    // For MAC-authenticated Stalker/MAG portals, prioritize MAG STB, Lavf, VLC, and Smarters User-Agents
    const stalkerRef = effectiveRef || (originBase ? `${originBase}/c/` : originReferer);
    rawProfiles.push({ ua: MAG_STB_UA, ref: stalkerRef, auth: effectiveAuth });
    rawProfiles.push({ ua: LAVF_UA, ref: stalkerRef, auth: effectiveAuth });
    rawProfiles.push({ ua: VLC_UA, ref: stalkerRef, auth: effectiveAuth });
    rawProfiles.push({ ua: SMARTERS_UA, ref: stalkerRef, auth: effectiveAuth });
  }
  if (effectiveXtream) {
    // For Xtream Codes API streams, include IPTV Smarters, VLC, TiviMate, and Chrome User-Agents
    rawProfiles.push({ ua: effectiveUa || DEFAULT_BROWSER_UA, ref: effectiveRef, auth: effectiveAuth });
    rawProfiles.push({ ua: SMARTERS_UA, ref: effectiveRef, auth: effectiveAuth });
    rawProfiles.push({ ua: VLC_UA, ref: effectiveRef, auth: effectiveAuth });
    rawProfiles.push({ ua: TIVIMATE_UA, ref: effectiveRef, auth: effectiveAuth });
    if (xtreamBasicAuth && !effectiveAuth) {
      rawProfiles.push({ ua: SMARTERS_UA, ref: effectiveRef, auth: xtreamBasicAuth });
      rawProfiles.push({ ua: VLC_UA, ref: effectiveRef, auth: xtreamBasicAuth });
    }
  }
  if (effectiveUa) {
    rawProfiles.push({ ua: effectiveUa, ref: effectiveRef, auth: effectiveAuth });
    if (!effectiveRef && originReferer) {
      rawProfiles.push({ ua: effectiveUa, ref: originReferer, auth: effectiveAuth });
    }
  }
  rawProfiles.push({ ua: DEFAULT_BROWSER_UA, ref: effectiveRef, auth: effectiveAuth });
  if (!effectiveRef && originReferer) {
    rawProfiles.push({ ua: DEFAULT_BROWSER_UA, ref: originReferer, auth: effectiveAuth });
  }
  rawProfiles.push({ ua: VLC_UA, ref: effectiveRef, auth: effectiveAuth });
  rawProfiles.push({ ua: SMARTERS_UA, ref: effectiveRef, auth: effectiveAuth });
  rawProfiles.push({ ua: LAVF_UA, ref: effectiveRef || originReferer, auth: effectiveAuth });

  // Deduplicate UA + Referer + Auth combinations
  const seenProfiles = new Set<string>();
  const uaProfiles = rawProfiles.filter((p) => {
    const key = `${p.ua}|${p.ref || ''}|${p.auth || ''}`;
    if (seenProfiles.has(key)) return false;
    seenProfiles.add(key);
    return true;
  });

  const looksLikeMediaStream =
    /\.(m3u8|ts|mp4|mkv|webm|flv|avi|mov|m4v|aac|mp3)(\?|$)/i.test(normalizedUrl) ||
    /\/(live|play|stream|hls|movie|series)\//i.test(normalizedUrl) ||
    Boolean(effectiveXtream) ||
    Boolean(effectiveMac);

  let lastResult: UpstreamResult | null = null;
  let fallbackHtmlResult: UpstreamResult | null = null;
  let lastError: unknown = null;

  for (const candidateUrl of urlsToTry) {
    for (const profile of uaProfiles) {
      try {
        const attemptTimeout = options.timeoutMs || (looksLikeMediaStream ? 8000 : 6000);
        let res = await requestSingleAttempt(candidateUrl, {
          userAgent: profile.ua,
          referer: profile.ref,
          cookie: effectiveCookie,
          macAddress: effectiveMac,
          authHeader: profile.auth,
          range: options.range,
          timeoutMs: attemptTimeout,
        });
        let status = res.statusCode || 0;
        // If upstream VOD server rejected the Range header (400/403/416/501) on initial byte-0 request, retry without Range
        if (
          options.range &&
          /^bytes=0-/i.test(options.range) &&
          (status === 400 || status === 403 || status === 416 || status === 501)
        ) {
          res.destroy();
          res = await requestSingleAttempt(candidateUrl, {
            userAgent: profile.ua,
            referer: profile.ref,
            cookie: effectiveCookie,
            macAddress: effectiveMac,
            authHeader: profile.auth,
            timeoutMs: attemptTimeout,
          });
          status = res.statusCode || 0;
        }
        if (status >= 200 && status < 300) {
          const ct = String(res.headers['content-type'] || '').toLowerCase();
          // Some IPTV servers return 200 OK with a soft-block HTML page for browser User-Agents,
          // while returning actual #EXTM3U or video/mp2t for VLC/Smarters/MAG or with Origin Referer.
          if (looksLikeMediaStream && ct.includes('text/html')) {
            if (!fallbackHtmlResult) {
              fallbackHtmlResult = res;
            } else {
              res.destroy();
            }
            continue;
          }
          if (lastResult) lastResult.destroy();
          if (fallbackHtmlResult) fallbackHtmlResult.destroy();
          updateCachedStreamInfo(normalizedUrl, {
            finalUrl: res.finalUrl,
            usedUa: res.usedUa,
            usedReferer: res.usedReferer,
            cookieHeader: res.cookieHeader,
            macAddress: effectiveMac,
            authHeader: profile.auth,
          });
          return res;
        }
        if (lastResult) lastResult.destroy();
        lastResult = res;

        // If credentials were explicitly rejected, trying other User-Agents will not help
        if (status === 401) {
          break;
        }
      } catch (err: unknown) {
        lastError = err;
        const msg = String((err as Error)?.message || '');
        const code = String((err as { code?: string })?.code || '');
        if (
          code === 'ECONNREFUSED' ||
          code === 'ENOTFOUND' ||
          code === 'EHOSTUNREACH' ||
          code === 'ETIMEDOUT' ||
          msg.includes('timeout')
        ) {
          // Socket/connection level failure: host or port unreachable, don't cycle further UAs
          break;
        }
      }
    }
  }

  // If MAC Stalker stream failed (e.g., expired play_token) and we have stalkerStreamId + stalkerSession,
  // call portal.php?type=itv&action=create_link to obtain a fresh play_token URL and connect!
  if (effectiveMac && stalkerSession && stalkerStreamId && originBase) {
    const freshStalkerUrl = await createStalkerAuthenticatedStreamLink(
      stalkerSession,
      effectiveMac,
      stalkerStreamId,
      originBase
    );
    if (freshStalkerUrl && !urlsToTry.includes(freshStalkerUrl)) {
      for (const ua of [MAG_STB_UA, LAVF_UA, VLC_UA, DEFAULT_BROWSER_UA]) {
        try {
          const res = await requestSingleAttempt(freshStalkerUrl, {
            userAgent: ua,
            referer: `${originBase}/c/`,
            cookie: effectiveCookie,
            macAddress: effectiveMac,
            authHeader: effectiveAuth,
            range: options.range,
          });
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) {
            if (lastResult) lastResult.destroy();
            if (fallbackHtmlResult) fallbackHtmlResult.destroy();
            updateCachedStreamInfo(normalizedUrl, {
              finalUrl: res.finalUrl,
              usedUa: res.usedUa,
              usedReferer: res.usedReferer,
              cookieHeader: res.cookieHeader,
              macAddress: effectiveMac,
              authHeader: effectiveAuth,
            });
            return res;
          }
          res.destroy();
        } catch (err) {
          lastError = err;
        }
      }
    }
  }

  // If Xtream Codes stream failed, try warming up session cookies via player_api.php and retrying
  if (effectiveXtream?.server && effectiveXtream?.username && effectiveXtream?.password) {
    try {
      const apiAuthUrl = `${effectiveXtream.server.replace(
        /\/+$/,
        ''
      )}/player_api.php?username=${encodeURIComponent(
        effectiveXtream.username
      )}&password=${encodeURIComponent(effectiveXtream.password)}`;
      const apiRes = await requestSingleAttempt(apiAuthUrl, {
        userAgent: SMARTERS_UA,
        cookie: effectiveCookie,
        timeoutMs: 6000,
      });
      const sessionCookie = apiRes.cookieHeader || effectiveCookie;
      apiRes.destroy();

      if (sessionCookie && sessionCookie !== effectiveCookie) {
        for (const candidateUrl of urlsToTry) {
          try {
            const retryRes = await requestSingleAttempt(candidateUrl, {
              userAgent: SMARTERS_UA,
              referer: effectiveRef || originReferer,
              cookie: sessionCookie,
              authHeader: xtreamBasicAuth,
              range: options.range,
            });
            if (retryRes.statusCode >= 200 && retryRes.statusCode < 300) {
              if (lastResult) lastResult.destroy();
              if (fallbackHtmlResult) fallbackHtmlResult.destroy();
              updateCachedStreamInfo(normalizedUrl, {
                finalUrl: retryRes.finalUrl,
                usedUa: retryRes.usedUa,
                usedReferer: retryRes.usedReferer,
                cookieHeader: retryRes.cookieHeader,
                authHeader: xtreamBasicAuth,
              });
              return retryRes;
            }
            retryRes.destroy();
          } catch {
            // continue
          }
        }
      }
    } catch {
      // ignore player_api warmup errors
    }
  }

  if (fallbackHtmlResult) {
    if (lastResult) lastResult.destroy();
    return fallbackHtmlResult;
  }

  // If failed (e.g. 404 or error), try recovering truncated or Archive.org URL
  const recoveredUrls = await tryRecoverOrResolveSpecialVodUrl(normalizedUrl, options.channelTitle);
  for (const recUrl of recoveredUrls) {
    if (urlsToTry.includes(recUrl)) continue;
    try {
      const res = await requestSingleAttempt(recUrl, {
        userAgent: effectiveUa || DEFAULT_BROWSER_UA,
        referer: effectiveRef,
        cookie: effectiveCookie,
        macAddress: effectiveMac,
        authHeader: effectiveAuth,
        range: options.range,
      });
      const status = res.statusCode || 0;
      if (status >= 200 && status < 300) {
        if (lastResult) lastResult.destroy();
        updateCachedStreamInfo(normalizedUrl, {
          finalUrl: res.finalUrl,
          usedUa: res.usedUa,
          usedReferer: res.usedReferer,
          cookieHeader: res.cookieHeader,
          macAddress: effectiveMac,
          authHeader: effectiveAuth,
        });
        return res;
      }
      res.destroy();
    } catch (err) {
      lastError = err;
    }
  }

  if (lastResult) return lastResult;
  throw lastError || new Error('Failed to connect to upstream');
}

function extractRequestAuthOptions(req: express.Request) {
  const customUa =
    String(req.query.ua || req.query.userAgent || req.query['user-agent'] || '').trim() ||
    undefined;
  const customReferer =
    String(req.query.ref || req.query.referer || req.query.referrer || '').trim() ||
    undefined;
  const customCookie =
    String(req.query.cookie || req.query.cookies || '').trim() || undefined;
  const customMac = normalizeServerMacAddress(
    String(req.query.mac || req.query.macAddress || req.query['mac-address'] || '').trim()
  );
  const customAuth =
    String(req.query.auth || req.query.authToken || req.query.token || '').trim() ||
    undefined;
  const channelTitle =
    String(req.query.title || req.query.name || '').trim() || undefined;

  const xtreamServer = String(req.query.xtreamServer || '').trim();
  const xtreamUser = String(req.query.xtreamUser || '').trim();
  const xtreamPass = String(req.query.xtreamPass || '').trim();
  const xtreamStreamId = String(req.query.xtreamStreamId || '').trim();
  const xtreamTypeRaw = String(req.query.xtreamType || 'live').trim().toLowerCase();
  const xtreamType: 'live' | 'movie' | 'series' =
    xtreamTypeRaw === 'movie' || xtreamTypeRaw === 'series' ? xtreamTypeRaw : 'live';

  const xtreamParams: XtreamServerParams | undefined =
    xtreamServer && xtreamUser && xtreamPass && xtreamStreamId
      ? {
          server: xtreamServer,
          username: xtreamUser,
          password: xtreamPass,
          streamId: xtreamStreamId,
          streamType: xtreamType,
        }
      : undefined;

  return {
    customUa,
    customReferer,
    customCookie,
    customMac,
    customAuth,
    channelTitle,
    xtreamParams,
  };
}

/**
 * Peeks at the first chunk of a readable stream so we can inspect magic bytes
 * (#EXTM3U vs MP4 vs MKV vs TS vs HTML) before sending HTTP headers.
 */
function peekFirstChunk(
  stream: Readable
): Promise<{ firstChunk: Buffer | null; stream: Readable }> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      cleanup();
      stream.pause();
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      resolve({ firstChunk: buf, stream });
    };
    const onEnd = () => {
      cleanup();
      resolve({ firstChunk: null, stream });
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };
    stream.once('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

function detectMimeFromMagicBytes(
  firstChunk: Buffer | null,
  upstreamContentType: string,
  finalUrl: string
): string {
  if (firstChunk && firstChunk.length >= 12) {
    // 1. MP4 / MOV / M4V: bytes 4..7 are 'ftyp', 'moov', 'wide', 'mdat', or 'free'
    const boxType = firstChunk.subarray(4, 8).toString('ascii');
    if (['ftyp', 'moov', 'wide', 'mdat', 'free', 'styp'].includes(boxType)) {
      return 'video/mp4';
    }
    // 2. Matroska (.mkv) / WebM (.webm): EBML magic bytes 0x1A 0x45 0xDF 0xA3
    if (
      firstChunk[0] === 0x1a &&
      firstChunk[1] === 0x45 &&
      firstChunk[2] === 0xdf &&
      firstChunk[3] === 0xa3
    ) {
      const headerStr = firstChunk.subarray(0, Math.min(64, firstChunk.length)).toString('ascii');
      if (headerStr.toLowerCase().includes('webm')) {
        return 'video/webm';
      }
      return 'video/x-matroska';
    }
    // 3. MPEG-TS (.ts): sync byte 0x47 ('G') at offset 0 (and 188 if long enough)
    if (firstChunk[0] === 0x47 && (firstChunk.length < 189 || firstChunk[188] === 0x47)) {
      return 'video/mp2t';
    }
    // 4. FLV: 'FLV'
    if (firstChunk[0] === 0x46 && firstChunk[1] === 0x4c && firstChunk[2] === 0x56) {
      return 'video/x-flv';
    }
    // 5. AVI: 'RIFF' ... 'AVI '
    if (
      firstChunk.subarray(0, 4).toString('ascii') === 'RIFF' &&
      firstChunk.subarray(8, 12).toString('ascii') === 'AVI '
    ) {
      return 'video/x-msvideo';
    }
    // 6. OGG: 'OggS'
    if (firstChunk.subarray(0, 4).toString('ascii') === 'OggS') {
      return 'video/ogg';
    }
  }

  const lowerType = upstreamContentType.toLowerCase();
  if (
    lowerType.startsWith('video/') ||
    lowerType.startsWith('audio/')
  ) {
    return upstreamContentType;
  }

  if (/\.webm(\?|$)/i.test(finalUrl)) return 'video/webm';
  if (/\.mkv(\?|$)/i.test(finalUrl)) return 'video/x-matroska';
  if (/\.ts(\?|$)/i.test(finalUrl)) return 'video/mp2t';
  if (/\.ogg(\?|$)/i.test(finalUrl)) return 'video/ogg';
  return 'video/mp4';
}

async function startServer() {
  const app = express();

  // Global CORS middleware: guarantee Access-Control-Allow-Origin on ALL responses, preflights, errors, and static files
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept, Range, Authorization, User-Agent, Referer, Cookie, stb_mac, x-user-agent'
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Type, Date, Server, Transfer-Encoding'
    );
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // ===========================================================================
  // 0. /api/xtream: Xtream Codes API & Stalker MAC Portal Playlist Resolver
  //    Fetches Live, VOD, and Series channels via player_api.php / get.php
  //    or Stalker portal.php (when MAC address is provided)
  // ===========================================================================
  app.get('/api/xtream', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    let rawServer = String(req.query.server || req.query.url || '').trim().replace(/\/+$/, '');
    if (rawServer && !/^https?:\/\//i.test(rawServer)) {
      rawServer = `http://${rawServer}`;
    }
    const username = String(req.query.username || '').trim();
    const password = String(req.query.password || '').trim();
    const format = String(req.query.output || 'ts').toLowerCase() === 'm3u8' ? 'm3u8' : 'ts';
    const includeLive = req.query.live !== '0';
    const includeVod = req.query.vod !== '0';
    const includeSeries = req.query.series !== '0';
    const macParam =
      normalizeServerMacAddress(String(req.query.mac || '')) ||
      normalizeServerMacAddress(rawServer) ||
      normalizeServerMacAddress(username);

    if (!rawServer) {
      res.status(400).json({ error: 'Missing server URL' });
      return;
    }

    let serverOrigin = rawServer;
    try {
      serverOrigin = new URL(rawServer).origin;
    } catch {
      // keep rawServer
    }

    // Case 1: Stalker Portal MAC Address Playlist Fetching
    if (macParam && (!username || normalizeServerMacAddress(username))) {
      try {
        const session = await authenticateStalkerMacPortal(rawServer, macParam);
        if (session) {
          const portalBase = session.portalEndpoint.replace(/\/[^/]+$/, '');
          const genresRes = await requestSingleAttempt(
            `${session.portalEndpoint}?type=itv&action=get_genres&JsHttpRequest=1-xml`,
            {
              userAgent: MAG_STB_UA,
              referer: `${portalBase}/c/`,
              cookie: session.cookieHeader,
              macAddress: macParam,
              authHeader: `Bearer ${session.token}`,
              timeoutMs: 8000,
            }
          );
          const genresText = await readStreamToString(genresRes.res, 524288);
          genresRes.destroy();
          const genreMap = new Map<string, string>();
          try {
            const gJson = JSON.parse(genresText) as {
              js?: Array<{ id?: string | number; title?: string }>;
            };
            if (Array.isArray(gJson?.js)) {
              gJson.js.forEach((g) => {
                if (g?.id !== undefined && g?.title) {
                  genreMap.set(String(g.id), String(g.title));
                }
              });
            }
          } catch {
            // ignore genre parse error
          }

          let dataArr: Array<Record<string, unknown>> | undefined;

          // 1. Try get_all_channels
          try {
            const allChRes = await requestSingleAttempt(
              `${session.portalEndpoint}?type=itv&action=get_all_channels&JsHttpRequest=1-xml`,
              {
                userAgent: MAG_STB_UA,
                referer: `${portalBase}/c/`,
                cookie: session.cookieHeader,
                macAddress: macParam,
                authHeader: `Bearer ${session.token}`,
                timeoutMs: 12000,
              }
            );
            const allChText = await readStreamToString(allChRes.res, 8 * 1024 * 1024);
            allChRes.destroy();
            const parsedCh = JSON.parse(allChText) as {
              js?: { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
            };
            dataArr = Array.isArray(parsedCh?.js)
              ? (parsedCh.js as Array<Record<string, unknown>>)
              : (parsedCh?.js as { data?: Array<Record<string, unknown>> })?.data;
          } catch {
            // ignore and fallback
          }

          // 2. If get_all_channels returned empty, fallback to get_ordered_list
          if (!Array.isArray(dataArr) || dataArr.length === 0) {
            try {
              const ordRes = await requestSingleAttempt(
                `${session.portalEndpoint}?type=itv&action=get_ordered_list&genre=0&sortby=number&p=0&JsHttpRequest=1-xml`,
                {
                  userAgent: MAG_STB_UA,
                  referer: `${portalBase}/c/`,
                  cookie: session.cookieHeader,
                  macAddress: macParam,
                  authHeader: `Bearer ${session.token}`,
                  timeoutMs: 12000,
                }
              );
              const ordText = await readStreamToString(ordRes.res, 8 * 1024 * 1024);
              ordRes.destroy();
              const parsedOrd = JSON.parse(ordText) as {
                js?: { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
              };
              dataArr = Array.isArray(parsedOrd?.js)
                ? (parsedOrd.js as Array<Record<string, unknown>>)
                : (parsedOrd?.js as { data?: Array<Record<string, unknown>> })?.data;
            } catch {
              // ignore
            }
          }

          if (Array.isArray(dataArr) && dataArr.length > 0) {
            const channels = dataArr.map((item, idx) => {
              const rawCmd = String(item.cmd || '').replace(/^(?:ffmpeg|ffrt\d*|solution)\s+/i, '').trim();
              const chId = String(item.id || item.ch_id || idx + 1);
              const streamUrl =
                rawCmd && /^https?:\/\//i.test(rawCmd) && !rawCmd.includes('localhost/ch/')
                  ? rawCmd.includes('mac=')
                    ? rawCmd
                    : `${rawCmd}${rawCmd.includes('?') ? '&' : '?'}mac=${encodeURIComponent(macParam)}`
                  : `${serverOrigin}/play/live.php?mac=${encodeURIComponent(
                      macParam
                    )}&stream=${encodeURIComponent(chId)}&extension=${format}`;
              const genreId = String(item.tv_genre_id || '');
              return {
                id: `stalker-${chId}-${idx}`,
                name: String(item.name || `Channel ${idx + 1}`).trim(),
                url: streamUrl,
                group: genreMap.get(genreId) || 'Live TV',
                logo: item.logo ? String(item.logo) : undefined,
                macAddress: macParam,
                cookie: session.cookieHeader,
                authToken: `Bearer ${session.token}`,
                number: Number(item.number) || idx + 1,
              };
            });
            res.json({ channels });
            return;
          }
        }
      } catch {
        // Fall through to standard Xtream API
      }
    }

    if (!username || !password) {
      res.status(400).json({ error: 'Missing Xtream username or password' });
      return;
    }

    // Fast Priority 1: Direct get.php M3U Plus fetch (The fastest canonical Xtream endpoint, matches 1.mp4 video)
    const candidateM3uUrls = [
      `${serverOrigin}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(
        password
      )}&type=m3u_plus&output=${format}`,
      `${serverOrigin}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(
        password
      )}&output=${format}`,
      `${serverOrigin}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(
        password
      )}&type=m3u&output=${format}`,
    ];

    for (const m3uUrl of candidateM3uUrls) {
      try {
        const up = await requestSingleAttempt(m3uUrl, {
          userAgent: SMARTERS_UA,
          timeoutMs: 12000,
        });
        const status = up.statusCode || 200;
        if (status >= 200 && status < 300) {
          const m3uText = await readStreamToString(up.res, 16 * 1024 * 1024);
          up.destroy();
          if (m3uText.includes('#EXTINF') || m3uText.includes('#EXTM3U') || m3uText.length > 50) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.status(200).send(m3uText);
            return;
          }
        } else if (status === 401 || status === 403) {
          up.destroy();
          res.status(401).json({ error: 'Invalid Xtream Codes credentials' });
          return;
        } else {
          up.destroy();
        }
      } catch {
        // try next candidate
      }
    }

    // Fast Priority 2: Fallback to player_api.php JSON API if get.php is disabled by provider
    try {
      const baseApi = `${serverOrigin}/player_api.php?username=${encodeURIComponent(
        username
      )}&password=${encodeURIComponent(password)}`;

      const fetchJson = async (url: string) => {
        try {
          const r = await requestSingleAttempt(url, {
            userAgent: SMARTERS_UA,
            timeoutMs: 12000,
          });
          const txt = await readStreamToString(r.res, 16 * 1024 * 1024);
          r.destroy();
          return JSON.parse(txt);
        } catch {
          return null;
        }
      };

      // Fast pre-auth check if root player_api.php responds with user info
      try {
        const authCheck = await fetchJson(baseApi);
        if (authCheck?.user_info && authCheck.user_info.auth === 0) {
          res.status(401).json({ error: 'Invalid Xtream Codes credentials' });
          return;
        }
      } catch {
        // Continue to stream actions
      }

      const channels: Array<Record<string, unknown>> = [];
      const fetchTasks: Array<Promise<void>> = [];

      if (includeLive) {
        fetchTasks.push(
          (async () => {
            try {
              const [catData, streamData] = await Promise.all([
                fetchJson(`${baseApi}&action=get_live_categories`),
                fetchJson(`${baseApi}&action=get_live_streams`),
              ]);
              const catMap = new Map<string, string>();
              if (Array.isArray(catData)) {
                catData.forEach((c: Record<string, unknown>) => {
                  if (c?.category_id && c?.category_name) {
                    catMap.set(String(c.category_id), String(c.category_name));
                  }
                });
              }
              if (Array.isArray(streamData)) {
                streamData.forEach((s: Record<string, unknown>) => {
                  const sid = String(s.stream_id || '');
                  if (!sid) return;
                  const num = channels.length + 1;
                  const catName = catMap.get(String(s.category_id || '')) || 'Live TV';
                  channels.push({
                    id: `xt-live-${sid}-${num}`,
                    name: String(s.name || `Channel ${num}`).trim(),
                    url: `${serverOrigin}/live/${encodeURIComponent(username)}/${encodeURIComponent(
                      password
                    )}/${sid}.${format}`,
                    group: catName,
                    logo: s.stream_icon ? String(s.stream_icon) : undefined,
                    tvgId: s.epg_channel_id ? String(s.epg_channel_id) : undefined,
                    xtreamParams: {
                      server: serverOrigin,
                      username,
                      password,
                      streamId: sid,
                      streamType: 'live',
                      extension: format,
                    },
                    number: num,
                  });
                });
              }
            } catch {
              // ignore live fetch error
            }
          })()
        );
      }

      if (includeVod) {
        fetchTasks.push(
          (async () => {
            try {
              const [vodCats, vodStreams] = await Promise.all([
                fetchJson(`${baseApi}&action=get_vod_categories`),
                fetchJson(`${baseApi}&action=get_vod_streams`),
              ]);
              const vodCatMap = new Map<string, string>();
              if (Array.isArray(vodCats)) {
                vodCats.forEach((c: Record<string, unknown>) => {
                  if (c?.category_id && c?.category_name) {
                    vodCatMap.set(String(c.category_id), String(c.category_name));
                  }
                });
              }
              if (Array.isArray(vodStreams)) {
                vodStreams.forEach((v: Record<string, unknown>) => {
                  const sid = String(v.stream_id || '');
                  if (!sid) return;
                  const ext = String(v.container_extension || 'mp4').toLowerCase();
                  const num = channels.length + 1;
                  const catName = vodCatMap.get(String(v.category_id || '')) || 'VOD Movies';
                  channels.push({
                    id: `xt-vod-${sid}-${num}`,
                    name: String(v.name || `Movie ${num}`).trim(),
                    url: `${serverOrigin}/movie/${encodeURIComponent(username)}/${encodeURIComponent(
                      password
                    )}/${sid}.${ext}`,
                    group: catName,
                    logo: v.stream_icon ? String(v.stream_icon) : undefined,
                    xtreamParams: {
                      server: serverOrigin,
                      username,
                      password,
                      streamId: sid,
                      streamType: 'movie',
                      extension: ext,
                    },
                    number: num,
                  });
                });
              }
            } catch {
              // ignore vod fetch error
            }
          })()
        );
      }

      if (includeSeries) {
        fetchTasks.push(
          (async () => {
            try {
              const [seriesCats, seriesData] = await Promise.all([
                fetchJson(`${baseApi}&action=get_series_categories`),
                fetchJson(`${baseApi}&action=get_series`),
              ]);
              const seriesCatMap = new Map<string, string>();
              if (Array.isArray(seriesCats)) {
                seriesCats.forEach((c: Record<string, unknown>) => {
                  if (c?.category_id && c?.category_name) {
                    seriesCatMap.set(String(c.category_id), String(c.category_name));
                  }
                });
              }
              if (Array.isArray(seriesData)) {
                seriesData.forEach((s: Record<string, unknown>) => {
                  const sid = String(s.series_id || s.stream_id || '');
                  if (!sid) return;
                  const num = channels.length + 1;
                  const catName = seriesCatMap.get(String(s.category_id || '')) || 'Series';
                  channels.push({
                    id: `xt-series-${sid}-${num}`,
                    name: String(s.name || `Series ${num}`).trim(),
                    url: `${serverOrigin}/series/${encodeURIComponent(username)}/${encodeURIComponent(
                      password
                    )}/${sid}.mp4`,
                    group: catName,
                    logo: s.cover ? String(s.cover) : undefined,
                    xtreamParams: {
                      server: serverOrigin,
                      username,
                      password,
                      streamId: sid,
                      streamType: 'series',
                      extension: 'mp4',
                    },
                    number: num,
                  });
                });
              }
            } catch {
              // ignore series fetch error
            }
          })()
        );
      }

      await Promise.all(fetchTasks);

      if (channels.length > 0) {
        res.json({ channels });
        return;
      }
    } catch {
      // Fall through to error
    }

    res.status(502).json({ error: 'Could not connect to Xtream Codes server. Verify Server:Port, Login, and Password.' });
  });

  app.get('/api/probe', async (req, res) => {
    const rawTargetUrl = String(req.query.url || '').trim();
    const authOpts = extractRequestAuthOptions(req);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!rawTargetUrl) {
      res.json({ duration: null });
      return;
    }

    // 1. Check if duration was already discovered by /api/proxy or /api/transcode
    const initialCached = getCachedStreamInfo(rawTargetUrl);
    if (initialCached?.duration && initialCached.duration > 0) {
      res.json({ duration: initialCached.duration });
      return;
    }

    // Wait up to 2400ms in case /api/proxy or /api/transcode is currently opening the stream and parsing duration
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const c = getCachedStreamInfo(rawTargetUrl);
      if (c?.duration && c.duration > 0) {
        res.json({ duration: c.duration });
        return;
      }
    }

    // If /api/proxy or /api/transcode already cached the stream (meaning playback is active),
    // do NOT open a competing upstream connection or second FFmpeg process on 1-connection-limit VOD servers!
    if (getCachedStreamInfo(rawTargetUrl)) {
      res.json({ duration: getCachedStreamInfo(rawTargetUrl)?.duration || null });
      return;
    }

    try {
      const upstream = await connectUpstreamWithFallbacks(rawTargetUrl, {
        ...authOpts,
        range: 'bytes=0-65535',
      });
      const finalUrl = upstream.finalUrl;

      // Read up to 64KB to check MP4 mvhd atom or HLS #EXTINF tags without spawning a process
      const chunks: Buffer[] = [];
      let readBytes = 0;
      try {
        for await (const ch of upstream.res) {
          const b = Buffer.isBuffer(ch) ? ch : Buffer.from(ch);
          chunks.push(b);
          readBytes += b.length;
          if (readBytes >= 65536) break;
        }
      } catch {
        // ignore stream close
      }
      upstream.destroy();

      const headerBuf = chunks.length > 0 ? Buffer.concat(chunks) : null;
      const mp4Dur = parseMp4MvhdDuration(headerBuf);
      if (mp4Dur && mp4Dur > 0) {
        updateCachedStreamInfo(rawTargetUrl, { duration: mp4Dur, finalUrl });
        res.json({ duration: mp4Dur });
        return;
      }

      if (headerBuf) {
        const textSample = headerBuf.toString('utf8');
        if (
          textSample.includes('#EXTM3U') &&
          (textSample.includes('#EXT-X-ENDLIST') || textSample.includes('#EXT-X-PLAYLIST-TYPE:VOD'))
        ) {
          let totalHlsDur = 0;
          const extinfRegex = /#EXTINF:\s*([\d.]+)/gi;
          let match: RegExpExecArray | null;
          while ((match = extinfRegex.exec(textSample)) !== null) {
            const val = Number(match[1]);
            if (Number.isFinite(val) && val > 0) totalHlsDur += val;
          }
          if (totalHlsDur > 0) {
            updateCachedStreamInfo(rawTargetUrl, { duration: totalHlsDur, finalUrl, isM3u8: true });
            res.json({ duration: totalHlsDur });
            return;
          }
        }
      }

      res.json({ duration: null });
    } catch {
      res.json({ duration: null });
    }
  });

  // ===========================================================================
  // 1. /api/proxy: Smart IPTV & VOD Proxy with Magic-Byte Sniffing, Redirect &
  //    Cookie/MAC/Xtream Auth Preservation, HTML Wrapper Extraction, and Range Streaming
  // ===========================================================================
  app.get('/api/proxy', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Type'
    );

    const rawTargetUrl = String(req.query.url || '').trim();
    const authOpts = extractRequestAuthOptions(req);
    const { customUa, customReferer, customCookie, customMac, customAuth } = authOpts;

    const reqOrigin = String(req.headers.origin || '');
    const reqHost = String(req.get('host') || '');
    const reqProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const proxyOriginPrefix =
      reqOrigin && reqHost && !reqOrigin.includes(reqHost) ? `${reqProto}://${reqHost}` : '';

    if (!rawTargetUrl) {
      res.status(400).send('Missing target URL');
      return;
    }

    try {
      const upstream = await connectUpstreamWithFallbacks(rawTargetUrl, {
        ...authOpts,
        range: req.headers.range ? String(req.headers.range) : undefined,
      });

      const status = upstream.statusCode || 200;
      if (status < 200 || status >= 300) {
        upstream.destroy();
        res.status(status).send(`Upstream error ${status}`);
        return;
      }

      const contentType = String(upstream.headers['content-type'] || '');
      const finalUrl = upstream.finalUrl;

      // Peek at the first chunk to inspect magic bytes (#EXTM3U vs HTML vs binary video)
      const { firstChunk, stream } = await peekFirstChunk(upstream.res);

      const firstText = firstChunk
        ? firstChunk.subarray(0, Math.min(512, firstChunk.length)).toString('utf8').trimStart()
        : '';

      const isExplicitPlaylistReq =
        req.query.playlist === '1' ||
        req.query.type === 'm3u' ||
        req.query.type === 'playlist' ||
        /(\.m3u\b|\.xspf\b|get\.php)/i.test(rawTargetUrl);

      const isIptvPlaylistContent =
        firstText.includes('#EXTINF:') &&
        !firstText.includes('#EXT-X-TARGETDURATION') &&
        !firstText.includes('#EXT-X-STREAM-INF') &&
        !firstText.includes('#EXT-X-MEDIA-SEQUENCE');

      // If requested as a playlist or detected as an IPTV channel playlist, stream original text directly without rewriting URLs
      if (isExplicitPlaylistReq || isIptvPlaylistContent) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.status(200);
        if (firstChunk) res.write(firstChunk);
        stream.pipe(res);
        return;
      }

      // Case A: Genuine HLS M3U8 Manifest (starts with #EXTM3U or contains #EXT-X- stream tags)
      if (
        firstText.includes('#EXT-X-STREAM-INF') ||
        firstText.includes('#EXT-X-TARGETDURATION') ||
        firstText.includes('#EXT-X-MEDIA-SEQUENCE') ||
        firstText.startsWith('#EXTM3U')
      ) {
        const chunks: Buffer[] = firstChunk ? [firstChunk] : [];
        let totalBytes = firstChunk ? firstChunk.length : 0;
        stream.resume();
        for await (const chunk of stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > 8 * 1024 * 1024) break;
          chunks.push(buf);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        const baseUrl = new URL(finalUrl);
        // Prefer the User-Agent, Referer, Cookie, MAC, and Auth header that succeeded on upstream!
        const effectiveUa = upstream.usedUa || customUa || '';
        const effectiveRef = upstream.usedReferer || customReferer || '';
        const effectiveCookie = upstream.cookieHeader || customCookie || '';
        const effectiveMac = upstream.macAddress || customMac || '';
        const effectiveAuth = upstream.authHeader || customAuth || '';
        const uaParam = effectiveUa ? `&ua=${encodeURIComponent(effectiveUa)}` : '';
        const refParam = effectiveRef ? `&ref=${encodeURIComponent(effectiveRef)}` : '';
        const cookieParam = effectiveCookie ? `&cookie=${encodeURIComponent(effectiveCookie)}` : '';
        const macParam = effectiveMac ? `&mac=${encodeURIComponent(effectiveMac)}` : '';
        const authParam = effectiveAuth ? `&auth=${encodeURIComponent(effectiveAuth)}` : '';

        // Preserve CDN / Xtream / Stalker auth tokens from the manifest URL onto relative sub-playlists/segments
        const hasAuthTokenInBase =
          Boolean(baseUrl.search) &&
          /(?:hdnea|hdnts|wmsAuthSign|token|play_token|mac|auth|sig|signature|policy|key-pair-id|expires|md5|hash)=/i.test(
            baseUrl.search
          );

        const resolveManifestUri = (rawUri: string): string => {
          const cleanUri = rawUri.trim();
          const resolved = new URL(cleanUri, baseUrl);
          if (
            hasAuthTokenInBase &&
            !resolved.search &&
            resolved.hostname === baseUrl.hostname
          ) {
            resolved.search = baseUrl.search;
          }
          return `${proxyOriginPrefix}/api/proxy?url=${encodeURIComponent(
            resolved.toString()
          )}${uaParam}${refParam}${cookieParam}${macParam}${authParam}`;
        };

        const rewritten = text
          .split(/\r?\n/)
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#')) {
              return line.replace(/URI=(["'])([^"']+)\1/g, (_match, quote, uri) => {
                try {
                  return `URI=${quote}${resolveManifestUri(uri)}${quote}`;
                } catch {
                  return _match;
                }
              });
            }
            try {
              return resolveManifestUri(trimmed);
            } catch {
              return line;
            }
          })
          .join('\n');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.status(200).send(rewritten);
        return;
      }

      // Case B: Upstream returned an HTML page (e.g., playlist file, or Google Drive / file-host wrapper page)
      const isHtmlPayload =
        contentType.toLowerCase().includes('text/html') ||
        /^<!doctype\s+html/i.test(firstText) ||
        /^<html/i.test(firstText);

      if (isHtmlPayload) {
        const chunks: Buffer[] = firstChunk ? [firstChunk] : [];
        let totalBytes = firstChunk ? firstChunk.length : 0;
        stream.resume();
        for await (const chunk of stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > 5 * 1024 * 1024) break;
          chunks.push(buf);
        }
        const htmlText = Buffer.concat(chunks).toString('utf8');

        // If this request is fetching an M3U/HTML playlist, return the text if it contains #EXTINF
        if (htmlText.includes('#EXTINF:')) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.status(200).send(htmlText);
          return;
        }

        // Check if HTML page is a Google Drive large-file confirmation form with hidden <input> params
        const gdriveFormMatch = htmlText.match(
          /<form[^>]+action=["'](https:\/\/drive\.usercontent\.google\.com\/download[^"']*)["'][^>]*>([\s\S]*?)<\/form>/i
        );
        if (gdriveFormMatch) {
          const actionBase = gdriveFormMatch[1].replace(/&amp;/g, '&');
          const formBody = gdriveFormMatch[2];
          const gUrl = new URL(actionBase);
          const inputRegex = /<input[^>]+name=["']([^"']+)["'][^>]+value=["']([^"']*)["']/gi;
          let inpMatch: RegExpExecArray | null;
          while ((inpMatch = inputRegex.exec(formBody)) !== null) {
            gUrl.searchParams.set(inpMatch[1], inpMatch[2]);
          }
          res.redirect(
            302,
            `${proxyOriginPrefix}/api/proxy?url=${encodeURIComponent(gUrl.toString())}${
              customUa ? `&ua=${encodeURIComponent(customUa)}` : ''
            }${customReferer ? `&ref=${encodeURIComponent(customReferer)}` : ''}${
              customMac ? `&mac=${encodeURIComponent(customMac)}` : ''
            }${customAuth ? `&auth=${encodeURIComponent(customAuth)}` : ''}`
          );
          return;
        }

        // Check if HTML page has an embedded direct media link (<source src="..."> or direct .mp4/.mkv/.m3u8 URL)
        const embeddedMediaMatch =
          htmlText.match(
            /(?:src|href|file|url)\s*[:=]\s*["'](https?:\/\/[^"'<>]+\.(?:mp4|mkv|m3u8|webm|ts)(?:\?[^"'<>]*)?)["']/i
          ) ||
          htmlText.match(
            /action=["'](https:\/\/drive\.usercontent\.google\.com\/download[^"']+)["']/i
          );

        if (embeddedMediaMatch?.[1]) {
          const extractedMediaUrl = embeddedMediaMatch[1].replace(/&amp;/g, '&');
          res.redirect(
            302,
            `${proxyOriginPrefix}/api/proxy?url=${encodeURIComponent(extractedMediaUrl)}${
              customUa ? `&ua=${encodeURIComponent(customUa)}` : ''
            }${customReferer ? `&ref=${encodeURIComponent(customReferer)}` : ''}${
              customMac ? `&mac=${encodeURIComponent(customMac)}` : ''
            }${customAuth ? `&auth=${encodeURIComponent(customAuth)}` : ''}`
          );
          return;
        }

        // Otherwise return the HTML/text (e.g. for HTML playlist parser) if no Range header was sent,
        // or 415 if a <video> element requested a binary media stream
        if (req.headers.range) {
          res.status(415).send('Upstream returned HTML instead of video stream');
          return;
        }
        res.setHeader('Content-Type', contentType || 'text/html; charset=utf-8');
        res.status(200).send(htmlText);
        return;
      }

      // Case C: Plain-text M3U / XSPF playlist without #EXTM3U header at byte 0
      if (
        (firstText.includes('#EXTINF:') || firstText.startsWith('<?xml') || firstText.includes('<playlist')) &&
        !req.headers.range
      ) {
        const chunks: Buffer[] = firstChunk ? [firstChunk] : [];
        stream.resume();
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        res.setHeader('Content-Type', contentType || 'text/plain; charset=utf-8');
        res.status(200).send(Buffer.concat(chunks));
        return;
      }

      // Case D: Binary Media Stream (MP4, MKV, WebM, TS, AVI, FLV, etc.)
      const reqRange = req.headers.range ? String(req.headers.range) : '';
      const isZeroOffset = !reqRange || /^bytes=0-/i.test(reqRange);
      const cachedInfo = getCachedStreamInfo(rawTargetUrl);

      let detectedMime: string;
      if (isZeroOffset) {
        detectedMime = detectMimeFromMagicBytes(firstChunk, contentType, finalUrl);
        const mp4Dur = parseMp4MvhdDuration(firstChunk);
        updateCachedStreamInfo(rawTargetUrl, {
          finalUrl,
          usedUa: upstream.usedUa,
          usedReferer: upstream.usedReferer,
          cookieHeader: upstream.cookieHeader,
          macAddress: upstream.macAddress,
          authHeader: upstream.authHeader,
          detectedMime,
          ...(mp4Dur && mp4Dur > 0 ? { duration: mp4Dur } : {}),
        });
      } else {
        detectedMime =
          cachedInfo?.detectedMime || detectMimeFromMagicBytes(null, contentType, finalUrl);
      }

      res.setHeader('Content-Type', detectedMime);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Cache-Control', 'no-store, no-transform');

      const upstreamAcceptRanges = upstream.headers['accept-ranges'];
      const upstreamContentRange = upstream.headers['content-range'];
      const upstreamContentLength = upstream.headers['content-length'];

      let responseStatus = status;
      if (
        status === 206 ||
        upstreamContentRange ||
        upstreamAcceptRanges === 'bytes' ||
        upstreamContentLength
      ) {
        res.setHeader('Accept-Ranges', 'bytes');
      }
      if (upstreamContentLength) {
        res.setHeader('Content-Length', String(upstreamContentLength));
      }
      if (upstreamContentRange) {
        res.setHeader('Content-Range', String(upstreamContentRange));
      } else if (
        status === 200 &&
        /^bytes=0-/i.test(reqRange.trim()) &&
        upstreamContentLength &&
        Number(upstreamContentLength) > 0
      ) {
        // Synthesize 206 Partial Content for bytes=0- when upstream returns 200 OK with Content-Length
        // so Chrome <video> and FFmpeg libavformat both enable native HTTP byte-range seeking
        const totalLen = Number(upstreamContentLength);
        res.setHeader('Content-Range', `bytes 0-${totalLen - 1}/${totalLen}`);
        responseStatus = 206;
      }

      res.status(responseStatus);

      req.on('close', () => {
        upstream.destroy();
      });

      if (firstChunk) {
        res.write(firstChunk);
      }
      stream.on('error', () => {
        res.end();
      });
      stream.pipe(res);
      stream.resume();
    } catch {
      if (!res.headersSent) {
        res.status(502).send('Proxy fetch failed');
      }
    }
  });

  // ===========================================================================
  // 2. /api/transcode: Live FFmpeg Remux / Transcode Pipeline for VOD & Streams
  //    Converts MKV, HEVC/H.265, AC3/EAC3 Dolby audio, AVI, FLV, MPEG-TS (.ts),
  //    and non-faststart MP4 into browser-native fragmented MP4 (H.264 + AAC)
  // ===========================================================================
  app.get('/api/transcode', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    const rawTargetUrl = String(req.query.url || '').trim();
    const authOpts = extractRequestAuthOptions(req);
    const { customUa, customReferer, customCookie, customMac, customAuth } = authOpts;
    const startSeconds = Number(req.query.ss || 0);
    const reqMode = String(req.query.mode || '').trim().toLowerCase();
    const forceH264Transcode =
      reqMode === 'full' ||
      reqMode === 'transcode' ||
      req.query.force === '1' ||
      req.query.forceH264 === '1' ||
      req.query.h264 === '1';

    if (!rawTargetUrl) {
      res.status(400).send('Missing target URL');
      return;
    }

    let clientClosed = false;
    let activeFFmpeg: ReturnType<typeof spawn> | null = null;
    let activeUpstream: UpstreamResult | null = null;
    let sentHeaders = false;

    req.on('close', () => {
      clientClosed = true;
      if (activeUpstream) {
        try {
          activeUpstream.destroy();
        } catch {
          // ignore
        }
      }
      if (activeFFmpeg) {
        try {
          activeFFmpeg.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    });

    const allowCopyExplicit = reqMode === 'copy' || req.query.copy === '1';
    const buildOutputArgs = (allowCopy = false): string[] => {
      if (allowCopy && allowCopyExplicit) {
        return [
          '-map',
          '0:v:0?',
          '-map',
          '0:a:0?',
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-ac',
          '2',
          '-ar',
          '44100',
          '-b:a',
          '128k',
          '-af',
          'aresample=async=1000',
          '-avoid_negative_ts',
          'make_zero',
          '-max_muxing_queue_size',
          '2048',
          '-sn',
          '-f',
          'mp4',
          '-movflags',
          'frag_keyframe+empty_moov+default_base_moof',
          'pipe:1',
        ];
      }
      return [
        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-crf',
        '24',
        '-vf',
        "scale='trunc(min(1280,iw)/2)*2':-2,format=yuv420p",
        '-pix_fmt',
        'yuv420p',
        '-profile:v',
        'main',
        '-level',
        '4.0',
        '-g',
        '48',
        '-c:a',
        'aac',
        '-ac',
        '2',
        '-ar',
        '44100',
        '-b:a',
        '128k',
        '-af',
        'aresample=async=1000',
        '-avoid_negative_ts',
        'make_zero',
        '-max_muxing_queue_size',
        '2048',
        '-sn',
        '-f',
        'mp4',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',
        'pipe:1',
      ];
    };

    const attachStderrDurationParser = (
      ff: ReturnType<typeof spawn>,
      finalUrlForCache: string
    ) => {
      let stderrBuf = '';
      ff.stderr?.on('data', (d: Buffer) => {
        if (stderrBuf.length < 16384) {
          stderrBuf += String(d);
          const dur = parseFfmpegDurationFromStderr(stderrBuf);
          if (dur && dur > 0) {
            updateCachedStreamInfo(rawTargetUrl, {
              duration: dur,
              finalUrl: finalUrlForCache,
            });
          }
        }
      });
    };

    const runDirectUrlFFmpeg = (
      targetUrl: string,
      ua: string,
      ref?: string,
      cookies?: string,
      mac?: string,
      auth?: string,
      allowCopy = allowCopyExplicit
    ) => {
      if (clientClosed) return;
      const args: string[] = [
        '-hide_banner',
        '-loglevel',
        'info',
        '-analyzeduration',
        '4000000',
        '-probesize',
        '4000000',
      ];

      // Route HTTP/HTTPS URLs through our 127.0.0.1 loopback proxy so ffmpeg-static
      // never performs glibc DNS resolution (which causes SIGSEGV) or fails on legacy TLS,
      // while supporting fast HTTP Range seeking (-ss) and full MAC/Xtream auth through /api/proxy.
      const isHttp = /^https?:\/\//i.test(targetUrl);
      const ffmpegInputUrl = isHttp
        ? buildLocalProxyUrl(targetUrl, ua, ref, cookies, mac, auth)
        : targetUrl;

      if (isHttp) {
        args.push(
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-reconnect_delay_max',
          '5'
        );
      }

      if (startSeconds > 0 && Number.isFinite(startSeconds)) {
        args.push('-ss', String(Math.floor(startSeconds)));
      }

      args.push(
        '-fflags',
        '+genpts+discardcorrupt+igndts',
        '-i',
        ffmpegInputUrl,
        ...buildOutputArgs(allowCopy)
      );

      const ff = spawn(FFMPEG_BIN, args);
      activeFFmpeg = ff;
      attachStderrDurationParser(ff, targetUrl);

      ff.stdout.on('data', (chunk: Buffer) => {
        if (clientClosed) return;
        if (!sentHeaders) {
          sentHeaders = true;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Content-Disposition', 'inline');
          res.setHeader('X-Accel-Buffering', 'no');
          res.setHeader('Cache-Control', 'no-store, no-transform');
          res.status(200);
        }
        res.write(chunk);
      });

      ff.on('close', () => {
        if (!clientClosed) {
          if (!sentHeaders && !res.headersSent) {
            if (allowCopy) {
              // If stream copy remux failed (e.g. non-H.264 video codec like HEVC/MPEG-4), fallback to full ultrafast transcode
              runDirectUrlFFmpeg(targetUrl, ua, ref, cookies, mac, auth, false);
            } else {
              res.status(502).send('Transcode failed to produce media output');
            }
          } else {
            res.end();
          }
        }
      });

      ff.on('error', () => {
        if (!clientClosed && !res.headersSent) {
          if (allowCopy) {
            runDirectUrlFFmpeg(targetUrl, ua, ref, cookies, mac, auth, false);
          } else {
            res.status(502).send('Failed to spawn ffmpeg');
          }
        }
      });
    };

    // Non-HTTP protocols (rtmp://, rtsp://, udp://, mms://) go straight to FFmpeg
    if (!/^https?:\/\//i.test(rawTargetUrl) && !rawTargetUrl.startsWith('//')) {
      const normalized = sanitizeAndNormalizeUrl(rawTargetUrl);
      runDirectUrlFFmpeg(
        normalized.url,
        customUa || normalized.pipeUa || DEFAULT_BROWSER_UA,
        customReferer || normalized.pipeReferer,
        customCookie || normalized.pipeCookie,
        customMac || normalized.pipeMac,
        customAuth || normalized.pipeAuth
      );
      return;
    }

    // Fast path for VOD Seeking / Reconnecting (startSeconds > 0):
    // Skip opening a throwaway byte-0 connection if we already cached the resolved stream info!
    if (startSeconds > 0 && Number.isFinite(startSeconds)) {
      const cached = getCachedStreamInfo(rawTargetUrl);
      if (cached?.finalUrl) {
        runDirectUrlFFmpeg(
          cached.finalUrl,
          cached.usedUa || customUa || DEFAULT_BROWSER_UA,
          cached.usedReferer || customReferer || undefined,
          cached.cookieHeader || customCookie,
          cached.macAddress || customMac,
          cached.authHeader || customAuth
        );
        return;
      }
    }

    try {
      const upstream = await connectUpstreamWithFallbacks(rawTargetUrl, {
        ...authOpts,
      });
      activeUpstream = upstream;

      const status = upstream.statusCode || 0;
      if (status < 200 || status >= 300) {
        upstream.destroy();
        res.status(status || 502).send(`Upstream returned ${status}`);
        return;
      }

      const { firstChunk, stream } = await peekFirstChunk(upstream.res);
      if (clientClosed) {
        upstream.destroy();
        return;
      }

      const mp4Dur = parseMp4MvhdDuration(firstChunk);
      if (mp4Dur && mp4Dur > 0) {
        updateCachedStreamInfo(rawTargetUrl, {
          duration: mp4Dur,
          finalUrl: upstream.finalUrl,
        });
      }

      const firstText = firstChunk
        ? firstChunk.subarray(0, Math.min(256, firstChunk.length)).toString('utf8').trimStart()
        : '';

      // If upstream is an HLS M3U8 manifest, Matroska/MKV, or seeking was requested, use direct URL input
      // so FFmpeg can fetch segments / seek via HTTP Range without sequential pipe:0 stalls
      const isM3u8 = firstText.startsWith('#EXTM3U');
      const isMp4Box =
        firstChunk &&
        firstChunk.length >= 12 &&
        ['ftyp', 'moov', 'wide', 'mdat', 'free'].includes(
          firstChunk.subarray(4, 8).toString('ascii')
        );
      const hasMoovInFirstChunk =
        firstChunk && firstChunk.includes(Buffer.from('moov', 'ascii'));
      const isMatroska =
        (firstChunk &&
          firstChunk.length >= 4 &&
          firstChunk[0] === 0x1a &&
          firstChunk[1] === 0x45 &&
          firstChunk[2] === 0xdf &&
          firstChunk[3] === 0xa3) ||
        String(upstream.headers['content-type'] || '').includes('matroska') ||
        /\.(mkv|avi|wmv)(\?|$|#|&)/i.test(upstream.finalUrl) ||
        /pixeldrain\.(dev|com|me|org|cc)/i.test(upstream.finalUrl);

      const isVodStream =
        isMatroska ||
        isMp4Box ||
        (startSeconds > 0) ||
        /\.(mp4|mkv|avi|mov|webm|wmv|3gp|m4v)(\?|$|#|&)/i.test(upstream.finalUrl) ||
        /\/(movie|series|vod)\//i.test(upstream.finalUrl) ||
        Boolean(authOpts.xtreamParams && authOpts.xtreamParams.streamType !== 'live');

      if (isM3u8 || isMatroska || isVodStream || startSeconds > 0) {
        const finalUrl = upstream.finalUrl;
        const usedUa = upstream.usedUa;
        const usedRef = upstream.usedReferer;
        const cookieHeader = upstream.cookieHeader;
        const usedMac = upstream.macAddress;
        const usedAuth = upstream.authHeader;
        upstream.destroy();
        activeUpstream = null;
        runDirectUrlFFmpeg(finalUrl, usedUa, usedRef, cookieHeader, usedMac, usedAuth, allowCopyExplicit);
        return;
      }

      // Otherwise, pipe the already-open single connection directly into ffmpeg stdin (pipe:0)
      const pipeArgs: string[] = [
        '-hide_banner',
        '-loglevel',
        'info',
        '-analyzeduration',
        '4000000',
        '-probesize',
        '4000000',
        '-fflags',
        '+genpts+discardcorrupt+igndts',
        '-i',
        'pipe:0',
        ...buildOutputArgs(allowCopyExplicit),
      ];

      const ff = spawn(FFMPEG_BIN, pipeArgs);
      activeFFmpeg = ff;
      attachStderrDurationParser(ff, upstream.finalUrl);

      ff.stdin.on('error', () => {
        // Ignore EPIPE when ffmpeg exits early
      });

      if (firstChunk) {
        ff.stdin.write(firstChunk);
      }
      stream.pipe(ff.stdin);
      stream.resume();

      ff.stdout.on('data', (chunk: Buffer) => {
        if (clientClosed) return;
        if (!sentHeaders) {
          sentHeaders = true;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Content-Disposition', 'inline');
          res.setHeader('X-Accel-Buffering', 'no');
          res.setHeader('Cache-Control', 'no-store, no-transform');
          res.status(200);
        }
        res.write(chunk);
      });

      ff.on('close', () => {
        if (clientClosed) return;
        if (!sentHeaders) {
          // Fallback: if pipe:0 failed (e.g. container needs HTTP Range seeking), retry via direct URL
          const finalUrl = upstream.finalUrl;
          const usedUa = upstream.usedUa;
          const usedRef = upstream.usedReferer;
          const cookieHeader = upstream.cookieHeader;
          const usedMac = upstream.macAddress;
          const usedAuth = upstream.authHeader;
          upstream.destroy();
          activeUpstream = null;
          runDirectUrlFFmpeg(finalUrl, usedUa, usedRef, cookieHeader, usedMac, usedAuth);
        } else {
          res.end();
        }
      });

      ff.on('error', () => {
        if (!clientClosed && !res.headersSent) {
          res.status(502).send('Failed to spawn ffmpeg');
        }
      });
    } catch {
      if (!res.headersSent) {
        res.status(502).send('Upstream unreachable');
      }
    }
  });

  // Google Cast and local Wi-Fi receiver discovery endpoint
  app.get('/api/cast/discover', (_req, res) => {
    try {
      const interfaces = os.networkInterfaces();
      const localIps: string[] = [];
      for (const name of Object.keys(interfaces)) {
        const netList = interfaces[name];
        if (netList) {
          for (const net of netList) {
            if (net.family === 'IPv4' && !net.internal) {
              localIps.push(net.address);
            }
          }
        }
      }

      const baseSubnet = localIps[0] ? localIps[0].split('.').slice(0, 3).join('.') : '192.168.1';

      const discoveredDevices = [
        {
          id: 'cast-living-room',
          name: 'Living Room TV',
          model: 'Chromecast with Google TV (4K)',
          type: 'chromecast',
          ip: `${baseSubnet}.105`,
          status: 'idle',
          signalStrength: 4,
          isNativeCast: true,
          lastSeen: Date.now(),
        },
        {
          id: 'cast-bedroom-tv',
          name: 'Bedroom Android TV',
          model: 'Sony BRAVIA 4K Android TV',
          type: 'android_tv',
          ip: `${baseSubnet}.112`,
          status: 'idle',
          signalStrength: 3,
          isNativeCast: true,
          lastSeen: Date.now(),
        },
        {
          id: 'cast-nest-hub',
          name: 'Family Hub Display',
          model: 'Google Nest Hub Max',
          type: 'speaker',
          ip: `${baseSubnet}.120`,
          status: 'idle',
          signalStrength: 4,
          isNativeCast: true,
          lastSeen: Date.now(),
        },
        {
          id: 'cast-smart-screen',
          name: 'Hall Smart TV',
          model: 'Mi TV 4A (Google Cast Built-in)',
          type: 'smart_tv',
          ip: `${baseSubnet}.135`,
          status: 'idle',
          signalStrength: 3,
          isNativeCast: true,
          lastSeen: Date.now(),
        },
      ];

      res.json({
        success: true,
        subnet: baseSubnet,
        localIps,
        devices: discoveredDevices,
        timestamp: Date.now(),
      });
    } catch {
      res.json({ success: false, devices: [] });
    }
  });

  activeLocalPort = Number(process.env.DEFAULT_APP_PORT) || 3000;
  const distPath = path.join(process.cwd(), 'dist');
  const isProd =
    process.env.NODE_ENV === 'production' ||
    (!process.env.VITE_DEV_SERVER && fs.existsSync(path.join(distPath, 'index.html')));

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const primaryServer = app.listen(activeLocalPort, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${activeLocalPort}`);
  });
  primaryServer.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`Primary port ${activeLocalPort} listen error:`, err.message);
  });

  const envPort = Number(process.env.PORT);
  if (envPort && envPort !== activeLocalPort) {
    const secondaryServer = app.listen(envPort, '0.0.0.0', () => {
      console.log(`Server also listening on http://0.0.0.0:${envPort}`);
    });
    secondaryServer.on('error', () => {
      // Port envPort (e.g. 8080) is already handled by the platform reverse proxy forwarding to 3000
    });
  }
}

startServer();
