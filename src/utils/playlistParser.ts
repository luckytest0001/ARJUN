export const DEFAULT_PLAYER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

export interface XtreamStreamParams {
  server: string;
  username: string;
  password: string;
  streamId: string;
  streamType: 'live' | 'movie' | 'series';
  extension?: string;
  queryParams?: string;
}

export interface Channel {
  id: string;
  name: string;
  url: string;
  group: string;
  logo?: string;
  tvgId?: string;
  userAgent?: string;
  referer?: string;
  cookie?: string;
  macAddress?: string;
  authToken?: string;
  xtreamParams?: XtreamStreamParams;
  number: number;
  forceProxy?: boolean;
  isProxied?: boolean;
  originalUrl?: string;
}

export interface Playlist {
  id: string;
  name: string;
  sourceUrl?: string;
  sourceType: 'url' | 'file' | 'sample';
  catchupType?: string;
  catchupDays?: string;
  channels: Channel[];
  addedAt: number;
}

export function isYouTubeChannelUrl(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  const u = rawUrl.trim();
  return (
    /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\b/i.test(u) ||
    /^vnd\.youtube:/i.test(u) ||
    /^youtube:\/\//i.test(u) ||
    /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i.test(u)
  );
}

export function normalizeExternalRedirectUrl(rawUrl: string): string {
  const u = rawUrl.trim();
  if (/^vnd\.youtube:\/\/(www\.|m\.)?youtube\.com\//i.test(u)) {
    return u.replace(/^vnd\.youtube:\/\//i, 'https://');
  }
  if (/^vnd\.youtube:([a-zA-Z0-9_-]{11})/i.test(u)) {
    const match = u.match(/^vnd\.youtube:([a-zA-Z0-9_-]{11})/i);
    return `https://www.youtube.com/watch?v=${match?.[1] || ''}`;
  }
  if (/^youtube:\/\//i.test(u)) {
    return u.replace(/^youtube:\/\//i, 'https://www.youtube.com/');
  }
  if (!/^https?:\/\//i.test(u)) {
    return `https://${u}`;
  }
  return u;
}

export function openExternalChannelLink(rawUrl: string): void {
  const finalUrl = normalizeExternalRedirectUrl(rawUrl);
  const anchor = document.createElement('a');
  anchor.href = finalUrl;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function safeDecodeURIComponent(val: string): string {
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

/**
 * Normalizes a raw MAC address string (e.g. "00:1a:79:12:34:56", "00-1A-79-12-34-56",
 * "00%3A1A%3A79%3A12%3A34%3A56", or "001A79123456") into uppercase colon-separated format.
 */
export function normalizeMacAddress(rawMac?: string): string | undefined {
  if (!rawMac) return undefined;
  const decoded = safeDecodeURIComponent(safeDecodeURIComponent(rawMac))
    .trim()
    .replace(/^["']+|["']+$/g, '');
  const colonOrDashMatch = decoded.match(
    /\b([0-9a-fA-F]{2})(?:[:-]([0-9a-fA-F]{2})){5}\b/
  );
  if (colonOrDashMatch) {
    return colonOrDashMatch[0].replace(/-/g, ':').toUpperCase();
  }
  const underscoreMatch = decoded.match(
    /\b([0-9a-fA-F]{2})(?:_([0-9a-fA-F]{2})){5}\b/
  );
  if (underscoreMatch) {
    return underscoreMatch[0].replace(/_/g, ':').toUpperCase();
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

/**
 * Builds a standard Stalker / MAG STB cookie header for a given MAC address,
 * merging with any existing cookies without duplicating keys.
 */
export function buildMacCookieHeader(macAddress?: string, existingCookie?: string): string | undefined {
  const normMac = normalizeMacAddress(macAddress);
  if (!normMac && !existingCookie) return undefined;
  const parts: string[] = [];
  if (existingCookie) {
    existingCookie.split(';').forEach((c) => {
      const trimmed = c.trim();
      if (trimmed) parts.push(trimmed);
    });
  }
  if (normMac) {
    const hasMacInCookie = parts.some((p) => /^mac\s*=/i.test(p));
    if (!hasMacInCookie) {
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

export const STB_MODELS = [
  'MAG 250 / 254 (Infomir Ministra)',
  'MAG 322 (Ministra STB)',
  'MAG 420 (Linux 4.9 STB)',
  'VLC Player (LibVLC 3.0)',
  'Standard Chrome / WebPlayer',
] as const;

export type StbModelType = (typeof STB_MODELS)[number];

export function getStbUserAgent(modelName?: string): string {
  const model = (modelName || '').toLowerCase();
  if (model.includes('322')) {
    return 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG322 stbapp ver: 2 rev: 332 Mobile Safari/533.3';
  }
  if (model.includes('420')) {
    return 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG420 stbapp ver: 4 rev: 420 Mobile Safari/533.3';
  }
  if (model.includes('vlc')) {
    return 'VLC/3.0.18 LibVLC/3.0.18';
  }
  if (model.includes('chrome')) {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  }
  // Default MAG 250 / 254 Ministra
  return 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 2724 Mobile Safari/533.3';
}

export function getDefaultStalkerAuthSettings(): {
  mac?: string;
  token?: string;
  stbModel: string;
  userAgent: string;
} {
  try {
    const rawMac = localStorage.getItem('iptv_default_mac_address') || undefined;
    const mac = normalizeMacAddress(rawMac);
    const token = (localStorage.getItem('iptv_default_portal_token') || '').trim() || undefined;
    const stbModel =
      localStorage.getItem('iptv_stb_emulation_model') || 'MAG 250 / 254 (Infomir Ministra)';
    const userAgent = getStbUserAgent(stbModel);
    return { mac, token, stbModel, userAgent };
  } catch {
    return {
      stbModel: 'MAG 250 / 254 (Infomir Ministra)',
      userAgent: getStbUserAgent(),
    };
  }
}

export function setDefaultStalkerAuthSettings(settings: {
  mac?: string;
  token?: string;
  stbModel?: string;
}) {
  try {
    if (settings.mac !== undefined) {
      const norm = normalizeMacAddress(settings.mac);
      if (norm) {
        localStorage.setItem('iptv_default_mac_address', norm);
      } else {
        localStorage.removeItem('iptv_default_mac_address');
      }
    }
    if (settings.token !== undefined) {
      const cleanToken = settings.token.trim();
      if (cleanToken) {
        localStorage.setItem('iptv_default_portal_token', cleanToken);
      } else {
        localStorage.removeItem('iptv_default_portal_token');
      }
    }
    if (settings.stbModel !== undefined) {
      localStorage.setItem('iptv_stb_emulation_model', settings.stbModel.trim());
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('iptv-stalker-auth-changed'));
    }
  } catch {
    // ignore
  }
}

const RESERVED_NON_XTREAM_SEGMENTS = new Set([
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

/**
 * Parses Xtream Codes API stream URLs and MAC / Stalker Portal authentication parameters
 * from a stream URL.
 */
export function parseXtreamAndMacParams(rawUrl: string): {
  xtreamParams?: XtreamStreamParams;
  macAddress?: string;
  authToken?: string;
} {
  let u = rawUrl.trim();
  // Strip Stalker portal command prefixes like "ffmpeg http://..." or "ffrt3 http://..."
  u = u.replace(/^(?:ffmpeg|ffrt\d*|solution)\s+(?=(?:https?|rtmp|rtsp|udp|mms):\/\/)/i, '').trim();

  let xtreamParams: XtreamStreamParams | undefined;
  let macAddress: string | undefined;
  let authToken: string | undefined;

  // 1. Check for inline MAC address in URL query/path/params
  const macQueryMatch = u.match(
    /[?&;#|](?:mac|deviceMac|stb_mac|mac_address|hw_id)=([^&#|;\s]+)/i
  );
  if (macQueryMatch?.[1]) {
    macAddress = normalizeMacAddress(macQueryMatch[1]);
  }
  if (!macAddress) {
    macAddress = normalizeMacAddress(safeDecodeURIComponent(u));
  }

  // 2. Check for token / play_token / auth parameters in query string
  const tokenMatch = u.match(
    /[?&](?:play_token|token|access_token|auth_token|auth|jwt|wmsAuthSign)=([^&#|\s]+)/i
  );
  if (tokenMatch?.[1]) {
    authToken = safeDecodeURIComponent(tokenMatch[1]).trim();
  }

  // 3. Parse standard Xtream Codes API path:
  //    http(s)://host:port/(live|movie|series)/username/password/streamId(.ext)
  const explicitXtreamMatch = u.match(
    /^(https?:\/\/[^/?#]+)\/(live|movie|series)\/([^/?#]+)\/([^/?#]+)\/([^/?#.]+)(?:\.([a-zA-Z0-9]{2,5}))?(?:\?([^#]*))?$/i
  );
  if (explicitXtreamMatch) {
    const server = explicitXtreamMatch[1];
    const streamType = explicitXtreamMatch[2].toLowerCase() as 'live' | 'movie' | 'series';
    const username = safeDecodeURIComponent(explicitXtreamMatch[3]);
    const password = safeDecodeURIComponent(explicitXtreamMatch[4]);
    const streamId = explicitXtreamMatch[5];
    const extension = explicitXtreamMatch[6]?.toLowerCase();
    const queryParams = explicitXtreamMatch[7];
    xtreamParams = {
      server,
      username,
      password,
      streamId,
      streamType,
      extension,
      queryParams,
    };
    return { xtreamParams, macAddress, authToken };
  }

  // 4. Parse short Xtream Codes Live path:
  //    http(s)://host:port/username/password/streamId(.ext)
  const shortXtreamMatch = u.match(
    /^(https?:\/\/[^/?#]+)\/([^/?#]+)\/([^/?#]+)\/(\d+)(?:\.([a-zA-Z0-9]{2,5}))?(?:\?([^#]*))?$/i
  );
  if (shortXtreamMatch) {
    const seg1 = shortXtreamMatch[2].toLowerCase();
    const seg2 = shortXtreamMatch[3].toLowerCase();
    if (!RESERVED_NON_XTREAM_SEGMENTS.has(seg1) && !RESERVED_NON_XTREAM_SEGMENTS.has(seg2)) {
      xtreamParams = {
        server: shortXtreamMatch[1],
        username: safeDecodeURIComponent(shortXtreamMatch[2]),
        password: safeDecodeURIComponent(shortXtreamMatch[3]),
        streamId: shortXtreamMatch[4],
        streamType: 'live',
        extension: shortXtreamMatch[5]?.toLowerCase(),
        queryParams: shortXtreamMatch[6],
      };
      return { xtreamParams, macAddress, authToken };
    }
  }

  // 5. Parse query-based Xtream Codes URL:
  //    http(s)://host:port/live.php?username=...&password=...&stream=123&extension=ts
  try {
    const parsed = new URL(u);
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
    // ignore invalid URL
  }

  return { xtreamParams, macAddress, authToken };
}

/**
 * Generates alternate Xtream Codes stream URLs (e.g. .m3u8 and .ts variants for live,
 * and .mp4 / .mkv variants for VOD movie/series) so the player can seamlessly switch
 * containers while preserving authentication.
 */
export function buildAuthenticatedXtreamAltUrls(channel: Channel): {
  hlsUrl?: string;
  tsUrl?: string;
  rawLiveUrl?: string;
  vodMp4Url?: string;
  vodMkvUrl?: string;
} {
  const xp = channel.xtreamParams || parseXtreamAndMacParams(channel.url).xtreamParams;
  if (!xp) return {};
  const base = xp.server.replace(/\/+$/, '');
  const u = encodeURIComponent(xp.username);
  const p = encodeURIComponent(xp.password);
  const id = encodeURIComponent(xp.streamId);
  const qs = xp.queryParams ? `?${xp.queryParams}` : '';
  if (xp.streamType === 'live') {
    return {
      hlsUrl: `${base}/live/${u}/${p}/${id}.m3u8${qs}`,
      tsUrl: `${base}/live/${u}/${p}/${id}.ts${qs}`,
      rawLiveUrl: `${base}/live/${u}/${p}/${id}${qs}`,
    };
  }
  return {
    vodMp4Url: `${base}/${xp.streamType}/${u}/${p}/${id}.mp4${qs}`,
    vodMkvUrl: `${base}/${xp.streamType}/${u}/${p}/${id}.mkv${qs}`,
  };
}

const clientVodDurationCache = new Map<string, number>();

export function getCachedClientVodDuration(url?: string): number | undefined {
  if (!url) return undefined;
  const val = clientVodDurationCache.get(url.split('#')[0]);
  return val && Number.isFinite(val) && val > 0 ? val : undefined;
}

export function setCachedClientVodDuration(url: string | undefined, durationSec: number | null | undefined) {
  if (!url || !durationSec || !Number.isFinite(durationSec) || durationSec <= 0) return;
  clientVodDurationCache.set(url.split('#')[0], durationSec);
}

function parseArchiveLengthField(rawLen?: string | number): number | null {
  if (rawLen === undefined || rawLen === null) return null;
  if (typeof rawLen === 'number') {
    return Number.isFinite(rawLen) && rawLen > 0 ? rawLen : null;
  }
  const s = String(rawLen).trim();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const val = parseFloat(s);
    return Number.isFinite(val) && val > 0 ? val : null;
  }
  const parts = s.split(':').map((p) => parseFloat(p));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    const total = parts[0] * 3600 + parts[1] * 60 + parts[2];
    return total > 0 ? total : null;
  }
  if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
    const total = parts[0] * 60 + parts[1];
    return total > 0 ? total : null;
  }
  return null;
}

function parseMp4MvhdDurationClient(buf: Uint8Array): number | null {
  if (!buf || buf.length < 32) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Scan for 'mvhd' (0x6d, 0x76, 0x68, 0x64)
  for (let i = 4; i <= buf.length - 28; i++) {
    if (
      buf[i] === 0x6d &&
      buf[i + 1] === 0x76 &&
      buf[i + 2] === 0x68 &&
      buf[i + 3] === 0x64
    ) {
      const version = buf[i + 4];
      if (version === 0 && i + 24 <= buf.length) {
        const timescale = view.getUint32(i + 16, false);
        const duration = view.getUint32(i + 20, false);
        if (timescale > 0 && duration > 0 && duration !== 0xffffffff) {
          const secs = duration / timescale;
          if (secs > 1 && secs < 86400 * 3) return secs;
        }
      } else if (version === 1 && i + 36 <= buf.length) {
        const timescale = view.getUint32(i + 24, false);
        const high = view.getUint32(i + 28, false);
        const low = view.getUint32(i + 32, false);
        const duration = high * 4294967296 + low;
        if (timescale > 0 && duration > 0) {
          const secs = duration / timescale;
          if (secs > 1 && secs < 86400 * 3) return secs;
        }
      }
    }
  }
  return null;
}

/**
 * Probes VOD duration purely from the browser (works on static GitHub Pages without /api/probe)
 * using cached Archive.org metadata, Xtream get_vod_info API, or HTTP Range bytes=0-131071 MP4 mvhd parsing.
 */
export async function probeClientSideVodDuration(
  channel: Channel,
  candidateUrls: string[],
  signal?: AbortSignal
): Promise<number | null> {
  const cleanUrl = normalizeVodMediaUrl(channel.url || '');
  const allUrls = [cleanUrl, ...candidateUrls].filter(Boolean);
  for (const u of allUrls) {
    const cached = getCachedClientVodDuration(u);
    if (cached) return cached;
  }

  // 1. If Xtream VOD movie, query player_api.php?action=get_vod_info
  const xp = channel.xtreamParams || parseXtreamAndMacParams(cleanUrl).xtreamParams;
  if (xp && xp.streamType === 'movie' && xp.server && xp.username && xp.password && xp.streamId) {
    try {
      const apiUrl = `${xp.server.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(
        xp.username
      )}&password=${encodeURIComponent(xp.password)}&action=get_vod_info&vod_id=${encodeURIComponent(
        xp.streamId
      )}`;
      const res = await fetch(apiUrl, { signal });
      if (res.ok) {
        const data = (await res.json()) as {
          info?: { duration_secs?: number | string; duration?: string };
        };
        const durSecs =
          parseArchiveLengthField(data?.info?.duration_secs) ||
          parseArchiveLengthField(data?.info?.duration);
        if (durSecs && durSecs > 0) {
          for (const u of allUrls) setCachedClientVodDuration(u, durSecs);
          return durSecs;
        }
      }
    } catch {
      // ignore and continue
    }
  }

  // 2. Try fetching first 128KB with Range header to parse MP4 mvhd box directly in browser
  for (const target of allUrls.slice(0, 2)) {
    if (!/^https:\/\//i.test(target) && typeof window !== 'undefined' && window.location.protocol === 'https:') {
      continue;
    }
    // Only send Range headers to same-origin or proxied URLs to avoid triggering browser CORS preflight (OPTIONS) errors on 3rd-party servers
    const isSameOriginOrProxied =
      target.startsWith('/') ||
      target.includes('/api/proxy') ||
      (typeof window !== 'undefined' && target.startsWith(window.location.origin));
    if (!isSameOriginOrProxied) {
      continue;
    }
    try {
      const res = await fetch(target, {
        headers: { Range: 'bytes=0-131071' },
        signal,
      });
      if (res.ok || res.status === 206) {
        const ab = await res.arrayBuffer();
        const dur = parseMp4MvhdDurationClient(new Uint8Array(ab));
        if (dur && dur > 0) {
          for (const u of allUrls) setCachedClientVodDuration(u, dur);
          return dur;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Resolves Archive.org /details/<id> or truncated /download/<id> URLs, Google Drive alternate
 * download links, and truncated VOD filenames directly in the browser (works 100% client-side
 * on GitHub Pages even without a backend server).
 */
export async function resolveClientSideVodUrls(
  channel: Channel,
  signal?: AbortSignal
): Promise<string[]> {
  const results: string[] = [];
  const pushUnique = (u?: string) => {
    if (u && /^https?:\/\//i.test(u) && !results.includes(u)) {
      results.push(u);
    }
  };

  const cleanUrl = normalizeVodMediaUrl(channel.url || '');

  // 1. Archive.org /details/<id>, /download/<id>/<partial>, or ia*.us.archive.org/.../items/<id>/<partial>
  const archiveMatch =
    cleanUrl.match(
      /^https?:\/\/(?:www\.)?archive\.org\/(?:details|download|stream)\/([^/?#]+)(?:\/([^?#]*))?/i
    ) ||
    cleanUrl.match(
      /^https?:\/\/[^/?#]+\.archive\.org\/(?:[^/?#]+\/)*items\/([^/?#]+)(?:\/([^?#]*))?/i
    );
  if (archiveMatch) {
    const itemId = archiveMatch[1];
    const subPath = archiveMatch[2] ? safeDecodeURIComponent(archiveMatch[2]).trim() : '';
    const isDirectMp4OrWebm = /\.(mp4|webm|m4v)(\?|$)/i.test(subPath);

    // Always preserve direct .mp4/.webm download/CDN links first so they play immediately
    if (isDirectMp4OrWebm && !/\/details\//i.test(cleanUrl)) {
      pushUnique(cleanUrl);
    }

    const metaCtrl = new AbortController();
    const onAbort = () => metaCtrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const metaTimeout =
      typeof window !== 'undefined'
        ? window.setTimeout(() => metaCtrl.abort(), 3500)
        : null;

    try {
      const metaRes = await fetch(
        `https://archive.org/metadata/${encodeURIComponent(itemId)}`,
        { signal: metaCtrl.signal }
      );
      if (metaRes.ok) {
        const metaJson = (await metaRes.json()) as {
          files?: Array<{
            name?: string;
            format?: string;
            original?: string;
            length?: string | number;
          }>;
        };
        const files = metaJson.files || [];
        const videoFiles = files.filter(
          (f) => f.name && /\.(mp4|mkv|webm|mov|m4v|avi|ogg|ts)$/i.test(f.name)
        );
        // Strictly prefer browser-native H.264 (.ia.mp4 / format: h.264) over generic MPEG4 (mp4v) or HEVC/MKV
        // so the browser never plays audio-only with a black video screen on GitHub Pages!
        const scoreVideoFile = (f: { name?: string; format?: string }) => {
          const name = (f.name || '').toLowerCase();
          const fmt = (f.format || '').toLowerCase();
          const isMp4OrWebm = /\.(mp4|webm|m4v)$/i.test(name);
          const isExplicitH264 = fmt.includes('h.264') || /\.ia\.mp4$/i.test(name);
          if (isMp4OrWebm && isExplicitH264) return 0;
          if (isMp4OrWebm && fmt.includes('mpeg4')) return 1;
          if (isMp4OrWebm) return 2;
          return 3;
        };
        videoFiles.sort((a, b) => scoreVideoFile(a) - scoreVideoFile(b));

        const cleanTitle = (channel.name || '').trim().toLowerCase();
        const cleanSub = subPath.toLowerCase();
        const cleanSubBase = cleanSub.replace(/(?:\.ia)?\.[a-z0-9]{2,5}$/i, '');

        const stripBase = (n: string) =>
          n.toLowerCase().replace(/(?:\.ia)?\.[a-z0-9]{2,5}$/i, '');

        const matchedList = [
          // 1. Exact H.264 / MP4 derivative of the requested file (via `original` field or base name match)
          ...videoFiles.filter(
            (f) =>
              /\.(mp4|webm|m4v)$/i.test(f.name || '') &&
              ((cleanSub && (f.original || '').toLowerCase() === cleanSub) ||
                (cleanSubBase && stripBase(f.name!) === cleanSubBase))
          ),
          // 2. Exact filename match
          ...videoFiles.filter((f) => cleanSub && f.name!.toLowerCase() === cleanSub),
          // 3. Prefix filename match
          ...videoFiles.filter((f) => cleanSub && f.name!.toLowerCase().startsWith(cleanSub)),
          // 4. Channel title match
          ...videoFiles.filter(
            (f) =>
              cleanTitle &&
              (f.name!.toLowerCase().startsWith(cleanTitle) ||
                f.name!.toLowerCase().includes(cleanTitle))
          ),
          // 5. All remaining sorted video files in the item
          ...videoFiles,
        ];

        let bestItemDuration: number | null = null;
        for (const f of matchedList) {
          const parsedDur = parseArchiveLengthField(f.length);
          if (parsedDur && parsedDur > 0) {
            bestItemDuration = Math.max(bestItemDuration || 0, parsedDur);
          }
        }
        if (bestItemDuration) {
          setCachedClientVodDuration(cleanUrl, bestItemDuration);
        }

        for (const matched of matchedList.slice(0, 4)) {
          if (matched?.name) {
            const encodedName = matched.name
              .split('/')
              .map((seg) => encodeURIComponent(seg))
              .join('/');
            const resolvedArchiveUrl = `https://archive.org/download/${itemId}/${encodedName}`;
            const fileDur = parseArchiveLengthField(matched.length) || bestItemDuration;
            if (fileDur) {
              setCachedClientVodDuration(resolvedArchiveUrl, fileDur);
            }
            pushUnique(resolvedArchiveUrl);
          }
        }
      }
    } catch {
      // Ignore metadata fetch errors; fall back to heuristic reconstruction below
    } finally {
      if (metaTimeout !== null && typeof window !== 'undefined') {
        window.clearTimeout(metaTimeout);
      }
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // 2. Heuristic recovery if a VOD URL was truncated at a space and channel.name has the full title
  const hasMediaExt = /\.(mp4|mkv|m3u8|ts|webm|avi|mov|m4v|flv|ogg)(\?|$)/i.test(cleanUrl);
  if (!hasMediaExt && channel.name) {
    try {
      const uObj = new URL(cleanUrl);
      const pathParts = uObj.pathname.split('/');
      const lastSeg = safeDecodeURIComponent(pathParts[pathParts.length - 1] || '').trim();
      const cleanTitle = channel.name.trim();
      if (
        lastSeg &&
        cleanTitle.toLowerCase().startsWith(lastSeg.toLowerCase()) &&
        cleanTitle.length > lastSeg.length
      ) {
        const baseDir = pathParts.slice(0, -1).join('/');
        const encodedTitle = encodeURIComponent(cleanTitle);
        if (/\.(mp4|mkv|webm|mov|m4v|avi)$/i.test(cleanTitle)) {
          pushUnique(`${uObj.origin}${baseDir}/${encodedTitle}${uObj.search}`);
        } else {
          pushUnique(`${uObj.origin}${baseDir}/${encodedTitle}.mp4${uObj.search}`);
          pushUnique(`${uObj.origin}${baseDir}/${encodedTitle}.mkv${uObj.search}`);
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Google Drive alternate direct download URLs
  const gdriveIdMatch = cleanUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/i);
  if (gdriveIdMatch?.[1] && /google\.com/i.test(cleanUrl)) {
    const gid = gdriveIdMatch[1];
    pushUnique(
      `https://drive.usercontent.google.com/download?id=${gid}&export=download&confirm=t`
    );
    pushUnique(`https://drive.google.com/uc?export=download&confirm=t&id=${gid}`);
  }

  pushUnique(cleanUrl);
  return results;
}

/**
 * Normalizes cloud VOD sharing links (Google Drive, Pixeldrain, Dropbox), Stalker cmd prefixes,
 * and cleans HTML artifacts or unencoded spaces.
 */
export function normalizeVodMediaUrl(rawUrl: string): string {
  let u = rawUrl
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");

  // Strip Stalker/MAG portal command prefixes like "ffmpeg http://..." or "ffrt3 http://..."
  u = u.replace(/^(?:ffmpeg|ffrt\d*|solution)\s+(?=(?:https?|rtmp|rtsp|udp|mms):\/\/)/i, '').trim();

  // Strip any HTML tags or quotes that might follow a URL in an HTML-wrapped M3U file
  u = u.split(/["'<>]/)[0].trim();

  // Fix accidental trailing HTML tag text from earlier parses (e.g. .mp4br, .mkv/p, etc.)
  u = u.replace(
    /\.(mp4|mkv|m3u8|ts|webm|avi|mov|m4v|flv|mp3|aac)(?:br|\/p|\/div|\/a|\/span|\/li|\/td|\/pre|\/body|\/html)+$/i,
    '.$1'
  );

  if (u.startsWith('//')) {
    u = `https:${u}`;
  }

  // Google Drive: /file/d/<ID>/view or /open?id=<ID> or /uc?id=<ID>
  const gdriveFileMatch = u.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i);
  const gdriveIdMatch = u.match(/drive\.google\.com\/(?:open|uc)\?[^#]*\bid=([a-zA-Z0-9_-]+)/i);
  const gdriveId = gdriveFileMatch?.[1] || gdriveIdMatch?.[1];
  if (gdriveId) {
    return `https://drive.usercontent.google.com/download?id=${gdriveId}&export=download&confirm=t`;
  }

  // Pixeldrain: https://pixeldrain.com/u/<ID> -> https://pixeldrain.com/api/file/<ID>
  const pixeldrainMatch = u.match(/pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)/i);
  if (pixeldrainMatch?.[1]) {
    return `https://pixeldrain.com/api/file/${pixeldrainMatch[1]}`;
  }

  // Dropbox: https://www.dropbox.com/... -> https://dl.dropboxusercontent.com/...
  if (/^https?:\/\/(?:www\.)?dropbox\.com\//i.test(u)) {
    u = u
      .replace(/^https?:\/\/(?:www\.)?dropbox\.com\//i, 'https://dl.dropboxusercontent.com/')
      .replace(/[?&]dl=0\b/i, '');
  }

  return u.replace(/ /g, '%20');
}

/**
 * Extracts pipe headers like `http://...|User-Agent=foo&Referer=bar&Cookie=mac=00:1A:79:...&Authorization=Bearer ...`
 * as well as Xtream Codes API parameters and MAC address parameters.
 */
export function extractUrlAndPipeHeaders(rawUrl: string): {
  url: string;
  userAgent?: string;
  referer?: string;
  cookie?: string;
  macAddress?: string;
  authToken?: string;
  xtreamParams?: XtreamStreamParams;
} {
  const cleanedRaw = rawUrl
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&');

  const pipeIndex = cleanedRaw.indexOf('|');
  const basePart = pipeIndex === -1 ? cleanedRaw : cleanedRaw.slice(0, pipeIndex);
  const base = normalizeVodMediaUrl(basePart);
  const parsedUrlAuth = parseXtreamAndMacParams(base);

  let userAgent: string | undefined;
  let referer: string | undefined;
  let cookie: string | undefined;
  let macAddress: string | undefined = parsedUrlAuth.macAddress;
  let authToken: string | undefined = parsedUrlAuth.authToken;

  if (pipeIndex !== -1) {
    const headerPart = cleanedRaw.slice(pipeIndex + 1).trim();
    headerPart.split(/[&|]/).forEach((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx !== -1) {
        const key = pair.slice(0, eqIdx).trim().toLowerCase();
        const rawVal = pair
          .slice(eqIdx + 1)
          .trim()
          .replace(/^["']+|["']+$/g, '');
        const val = safeDecodeURIComponent(rawVal);
        if (key === 'user-agent' || key === 'useragent' || key === 'http-user-agent') {
          userAgent = val;
        } else if (
          key === 'referer' ||
          key === 'referrer' ||
          key === 'origin' ||
          key === 'http-referer' ||
          key === 'http-referrer'
        ) {
          referer = val;
        } else if (key === 'cookie' || key === 'cookies' || key === 'http-cookie') {
          cookie = cookie ? `${cookie}; ${val}` : val;
          const macInCookie = normalizeMacAddress(val);
          if (macInCookie && !macAddress) {
            macAddress = macInCookie;
          }
        } else if (
          key === 'mac' ||
          key === 'mac-address' ||
          key === 'mac_address' ||
          key === 'stb-mac' ||
          key === 'stb_mac' ||
          key === 'devicemac'
        ) {
          const norm = normalizeMacAddress(val);
          if (norm) macAddress = norm;
        } else if (
          key === 'authorization' ||
          key === 'auth' ||
          key === 'token' ||
          key === 'play_token' ||
          key === 'bearer' ||
          key === 'x-auth-token'
        ) {
          authToken = val;
        }
      }
    });
  }

  const finalCookie = buildMacCookieHeader(macAddress, cookie);

  return {
    url: base,
    userAgent,
    referer,
    cookie: finalCookie,
    macAddress,
    authToken,
    xtreamParams: parsedUrlAuth.xtreamParams,
  };
}

/**
 * Repairs and normalizes an existing Channel (e.g. loaded from localStorage),
 * ensuring Xtream Codes API parameters and MAC address auth parameters are extracted.
 */
export function repairAndNormalizeChannel(ch: Channel): Channel {
  let rawUrl = (ch.url || '').trim();
  let proxyMac: string | undefined;
  let proxyCookie: string | undefined;
  let proxyAuth: string | undefined;
  let proxyUa: string | undefined;
  let proxyRef: string | undefined;

  if (rawUrl.includes('/api/proxy?')) {
    try {
      const urlMatch = rawUrl.match(/[?&]url=([^&]+)/);
      const macMatch = rawUrl.match(/[?&]mac=([^&]+)/) || (ch.url || '').match(/[?&]mac=([^&]+)/);
      const cookieMatch = rawUrl.match(/[?&]cookie=([^&]+)/) || (ch.url || '').match(/[?&]cookie=([^&]+)/);
      const authMatch = rawUrl.match(/[?&]auth=([^&]+)/) || (ch.url || '').match(/[?&]auth=([^&]+)/);
      const uaMatch = rawUrl.match(/[?&]ua=([^&]+)/) || (ch.url || '').match(/[?&]ua=([^&]+)/);
      const refMatch = rawUrl.match(/[?&]ref(?:erer)?=([^&]+)/) || (ch.url || '').match(/[?&]ref(?:erer)?=([^&]+)/);

      if (urlMatch && urlMatch[1]) {
        rawUrl = decodeURIComponent(urlMatch[1]).trim();
      }
      if (macMatch?.[1]) proxyMac = normalizeMacAddress(decodeURIComponent(macMatch[1]));
      if (cookieMatch?.[1]) proxyCookie = decodeURIComponent(cookieMatch[1]);
      if (authMatch?.[1]) proxyAuth = decodeURIComponent(authMatch[1]);
      if (uaMatch?.[1]) proxyUa = decodeURIComponent(uaMatch[1]);
      if (refMatch?.[1]) proxyRef = decodeURIComponent(refMatch[1]);
    } catch {
      // keep rawUrl
    }
  }

  const extracted = extractUrlAndPipeHeaders(rawUrl);
  const globalAuth = getDefaultStalkerAuthSettings();

  const resolvedMac =
    normalizeMacAddress(ch.macAddress) ||
    proxyMac ||
    extracted.macAddress ||
    normalizeMacAddress(ch.cookie) ||
    normalizeMacAddress(proxyCookie) ||
    globalAuth.mac;

  const resolvedAuthToken =
    ch.authToken ||
    proxyAuth ||
    extracted.authToken ||
    globalAuth.token;

  const resolvedUserAgent =
    ch.userAgent ||
    proxyUa ||
    extracted.userAgent ||
    (resolvedMac ? globalAuth.userAgent : undefined);

  const resolvedCookie = buildMacCookieHeader(
    resolvedMac,
    ch.cookie || proxyCookie || extracted.cookie
  );

  return {
    ...ch,
    url: extracted.url,
    originalUrl: ch.originalUrl || extracted.url,
    userAgent: resolvedUserAgent,
    referer: ch.referer || proxyRef || extracted.referer,
    cookie: resolvedCookie,
    macAddress: resolvedMac,
    authToken: resolvedAuthToken,
    xtreamParams: ch.xtreamParams || extracted.xtreamParams,
  };
}

/**
 * Parses M3U / M3U8 playlist content into a list of channels.
 */
export function parseM3U(content: string, sourceUrl?: string): Channel[] {
  // Pre-normalize HTML line-break tags and entities in case an M3U playlist is wrapped in index.html
  const normalizedContent = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|pre)>/gi, '\n')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&');

  const lines = normalizedContent.split(/\r?\n/);
  const channels: Channel[] = [];

  let currentName = '';
  let currentGroup = 'All channels';
  let currentLogo = '';
  let currentTvgId = '';
  let currentUserAgent: string | undefined;
  let currentReferer: string | undefined;
  let currentCookie: string | undefined;
  let currentMacAddress: string | undefined;
  let currentAuthToken: string | undefined;

  const pushChannelFromRawUrl = (rawLine: string) => {
    let firstQuoteOrTag = rawLine.split(/["'<>]/)[0].trim();
    if (!firstQuoteOrTag) return;

    // Check if URL was wrapped by a proxy e.g. /api/proxy?url=https%3A%2F%2F...
    if (firstQuoteOrTag.includes('/api/proxy?') || (firstQuoteOrTag.includes('url=') && firstQuoteOrTag.includes('%'))) {
      try {
        const urlMatch = firstQuoteOrTag.match(/[?&]url=([^&|]+)/);
        if (urlMatch && urlMatch[1]) {
          const unwrapped = safeDecodeURIComponent(urlMatch[1]).trim();
          if (/^https?:\/\//i.test(unwrapped)) {
            const uaMatch = firstQuoteOrTag.match(/[?&]ua=([^&|]+)/);
            if (uaMatch && !currentUserAgent) currentUserAgent = safeDecodeURIComponent(uaMatch[1]);
            const refMatch = firstQuoteOrTag.match(/[?&]ref(?:erer)?=([^&|]+)/);
            if (refMatch && !currentReferer) currentReferer = safeDecodeURIComponent(refMatch[1]);
            const cookieMatch = firstQuoteOrTag.match(/[?&]cookie=([^&|]+)/);
            if (cookieMatch && !currentCookie) currentCookie = safeDecodeURIComponent(cookieMatch[1]);
            const macMatch = firstQuoteOrTag.match(/[?&]mac=([^&|]+)/);
            if (macMatch && !currentMacAddress) currentMacAddress = normalizeMacAddress(safeDecodeURIComponent(macMatch[1]));
            const authMatch = firstQuoteOrTag.match(/[?&]auth=([^&|]+)/);
            if (authMatch && !currentAuthToken) currentAuthToken = safeDecodeURIComponent(authMatch[1]);
            firstQuoteOrTag = unwrapped;
          }
        }
      } catch {
        // ignore unwrap error
      }
    }

    // If URL is a relative path (e.g. /live/user/pass/1.ts) and sourceUrl is known, resolve it
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(firstQuoteOrTag) && sourceUrl) {
      try {
        firstQuoteOrTag = new URL(firstQuoteOrTag, sourceUrl).toString();
      } catch {
        // keep raw path
      }
    }

    const {
      url,
      userAgent,
      referer,
      cookie,
      macAddress,
      authToken,
      xtreamParams,
    } = extractUrlAndPipeHeaders(firstQuoteOrTag);
    if (!url) return;
    const number = channels.length + 1;
    const finalMac = macAddress || currentMacAddress;
    const finalCookie = buildMacCookieHeader(finalMac, cookie || currentCookie);
    channels.push({
      id: `ch-${number}-${Math.random().toString(36).slice(2, 7)}`,
      name: currentName || `Channel ${number}`,
      url,
      group: currentGroup || 'General',
      logo: currentLogo || undefined,
      tvgId: currentTvgId || undefined,
      userAgent: userAgent || currentUserAgent,
      referer: referer || currentReferer,
      cookie: finalCookie,
      macAddress: finalMac,
      authToken: authToken || currentAuthToken,
      xtreamParams,
      number,
    });
    currentName = '';
    currentGroup = 'General';
    currentLogo = '';
    currentTvgId = '';
    currentUserAgent = undefined;
    currentReferer = undefined;
    currentCookie = undefined;
    currentMacAddress = undefined;
    currentAuthToken = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.includes('#EXTINF:')) {
      const extInfLine = line.slice(line.indexOf('#EXTINF:'));

      const logoMatch = extInfLine.match(/tvg-logo=["']([^"']*)["']/i);
      const groupMatch = extInfLine.match(/group-title=["']([^"']*)["']/i);
      const tvgIdMatch = extInfLine.match(/tvg-id=["']([^"']*)["']/i);
      const tvgNameMatch = extInfLine.match(/tvg-name=["']([^"']*)["']/i);
      const uaAttrMatch = extInfLine.match(/(?:user-agent|http-user-agent)=["']([^"']*)["']/i);
      const refAttrMatch = extInfLine.match(/(?:referer|referrer|http-referer|http-referrer)=["']([^"']*)["']/i);
      const macAttrMatch = extInfLine.match(/(?:tvg-mac|mac|mac-address|stb-mac)=["']([^"']*)["']/i);
      const cookieAttrMatch = extInfLine.match(/(?:cookie|http-cookie)=["']([^"']*)["']/i);
      const tokenAttrMatch = extInfLine.match(/(?:token|play-token|play_token|authorization)=["']([^"']*)["']/i);

      currentLogo = logoMatch ? logoMatch[1].trim() : '';
      currentGroup = groupMatch && groupMatch[1].trim() ? groupMatch[1].trim() : 'General';
      currentTvgId = tvgIdMatch ? tvgIdMatch[1].trim() : '';
      if (uaAttrMatch?.[1]) currentUserAgent = uaAttrMatch[1].trim();
      if (refAttrMatch?.[1]) currentReferer = refAttrMatch[1].trim();
      if (macAttrMatch?.[1]) currentMacAddress = normalizeMacAddress(macAttrMatch[1].trim());
      if (cookieAttrMatch?.[1]) currentCookie = cookieAttrMatch[1].trim();
      if (tokenAttrMatch?.[1]) currentAuthToken = tokenAttrMatch[1].trim();

      // Strip any quotes/attributes first to find the comma separating metadata from channel title
      const commaIndex = extInfLine.lastIndexOf(',');
      if (commaIndex !== -1) {
        const afterComma = extInfLine.slice(commaIndex + 1).trim();
        // Check if URL was placed on the same line right after the channel title
        const inlineUrlMatch = afterComma.match(
          /\s+((?:ffmpeg\s+|ffrt\d*\s+)?(?:https?:\/\/|rtmp:\/\/|rtsp:\/\/|udp:\/\/|mms:\/\/|vnd\.youtube:|youtube:\/\/))(.+)$/i
        );
        if (inlineUrlMatch && inlineUrlMatch.index !== undefined) {
          currentName = afterComma
            .slice(0, inlineUrlMatch.index)
            .replace(/<[^>]*>/g, '')
            .trim();
          pushChannelFromRawUrl(inlineUrlMatch[1] + inlineUrlMatch[2]);
        } else {
          currentName = afterComma.replace(/<[^>]*>/g, '').trim();
        }
      } else if (tvgNameMatch) {
        currentName = tvgNameMatch[1].trim();
      } else {
        currentName = `Channel ${channels.length + 1}`;
      }
    } else if (line.startsWith('#EXTGRP:')) {
      const grp = line.replace('#EXTGRP:', '').trim();
      if (grp) currentGroup = grp;
    } else if (line.toLowerCase().startsWith('#extvlcopt:')) {
      const opt = line.slice(11).trim();
      const lowerOpt = opt.toLowerCase();
      if (lowerOpt.startsWith('http-user-agent=')) {
        currentUserAgent = opt.slice(16).trim();
      } else if (lowerOpt.startsWith('http-referrer=')) {
        currentReferer = opt.slice(14).trim();
      } else if (lowerOpt.startsWith('http-referer=')) {
        currentReferer = opt.slice(13).trim();
      } else if (lowerOpt.startsWith('http-cookie=')) {
        currentCookie = opt.slice(12).trim();
        const mac = normalizeMacAddress(currentCookie);
        if (mac) currentMacAddress = mac;
      } else if (lowerOpt.startsWith('http-mac=') || lowerOpt.startsWith('mac=')) {
        const eqIdx = opt.indexOf('=');
        currentMacAddress = normalizeMacAddress(opt.slice(eqIdx + 1).trim());
      } else if (lowerOpt.startsWith('http-header=')) {
        const hdr = opt.slice(12).trim();
        if (/^authorization\s*:/i.test(hdr)) {
          currentAuthToken = hdr.replace(/^authorization\s*:\s*/i, '').trim();
        } else if (/^cookie\s*:/i.test(hdr)) {
          currentCookie = hdr.replace(/^cookie\s*:\s*/i, '').trim();
          const mac = normalizeMacAddress(currentCookie);
          if (mac) currentMacAddress = mac;
        }
      }
    } else if (line.toLowerCase().startsWith('#kodiprop:')) {
      const prop = line.slice(10).trim();
      const eqIdx = prop.indexOf('=');
      if (eqIdx !== -1) {
        const val = prop.slice(eqIdx + 1).trim();
        const extracted = extractUrlAndPipeHeaders(`http://dummy|${val}`);
        if (extracted.userAgent) currentUserAgent = extracted.userAgent;
        if (extracted.referer) currentReferer = extracted.referer;
        if (extracted.cookie) currentCookie = extracted.cookie;
        if (extracted.macAddress) currentMacAddress = extracted.macAddress;
        if (extracted.authToken) currentAuthToken = extracted.authToken;
      }
    } else if (line.toLowerCase().startsWith('#exthttp:')) {
      try {
        const jsonStr = line.slice(9).trim();
        const parsed = JSON.parse(jsonStr) as Record<string, string>;
        const ua = parsed['User-Agent'] || parsed['user-agent'] || parsed['UserAgent'];
        const ref = parsed['Referer'] || parsed['referer'] || parsed['Origin'] || parsed['origin'];
        const ck = parsed['Cookie'] || parsed['cookie'];
        const mac = parsed['mac'] || parsed['MAC'] || parsed['X-MAC'];
        const auth = parsed['Authorization'] || parsed['authorization'] || parsed['token'];
        if (ua) currentUserAgent = String(ua);
        if (ref) currentReferer = String(ref);
        if (ck) currentCookie = String(ck);
        if (mac) currentMacAddress = normalizeMacAddress(String(mac));
        if (auth) currentAuthToken = String(auth);
      } catch {
        // ignore invalid JSON
      }
    } else if (!line.startsWith('#')) {
      const urlStartMatch = line.match(
        /((?:ffmpeg\s+|ffrt\d*\s+)?(?:https?:\/\/|rtmp:\/\/|rtsp:\/\/|udp:\/\/|mms:\/\/|vnd\.youtube:|youtube:\/\/|\/api\/proxy|\/|[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)).*/i
      );
      if (urlStartMatch) {
        pushChannelFromRawUrl(urlStartMatch[0]);
      } else if (line.length > 2 && !line.includes('<html') && !line.includes('<!DOCTYPE')) {
        pushChannelFromRawUrl(line);
      }
    }
  }

  return channels;
}

/**
 * Parses XSPF (XML Shareable Playlist Format) content into a list of channels.
 */
export function parseXSPF(content: string): Channel[] {
  const channels: Channel[] = [];
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(content, 'text/xml');
    const tracks = xmlDoc.getElementsByTagName('track');

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const locationNode = track.getElementsByTagName('location')[0];
      const titleNode = track.getElementsByTagName('title')[0];
      const creatorNode = track.getElementsByTagName('creator')[0];
      const albumNode = track.getElementsByTagName('album')[0];
      const imageNode = track.getElementsByTagName('image')[0];

      const rawUrl = locationNode?.textContent?.trim() || '';
      if (!rawUrl) continue;

      const {
        url,
        userAgent,
        referer,
        cookie,
        macAddress,
        authToken,
        xtreamParams,
      } = extractUrlAndPipeHeaders(rawUrl);
      const number = channels.length + 1;
      const name = titleNode?.textContent?.trim() || `Channel ${number}`;
      const group = albumNode?.textContent?.trim() || creatorNode?.textContent?.trim() || 'General';
      const logo = imageNode?.textContent?.trim() || undefined;

      channels.push({
        id: `xspf-${number}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        url,
        group,
        logo,
        userAgent,
        referer,
        cookie,
        macAddress,
        authToken,
        xtreamParams,
        number,
      });
    }
  } catch (err) {
    console.error('Failed to parse XSPF playlist:', err);
  }
  return channels;
}

/**
 * Parses HTML files (e.g. index.html IPTV channel portals) if they don't use raw #EXTINF.
 */
export function parseHTMLPlaylist(content: string): Channel[] {
  if (content.includes('#EXTINF:')) {
    const m3uChannels = parseM3U(content);
    if (m3uChannels.length > 0) return m3uChannels;
  }

  const channels: Channel[] = [];
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/html');

    const candidates = doc.querySelectorAll(
      'a, [data-url], [data-stream], [data-src], [data-href], [data-link], [data-video], [onclick], .channel, .card, .item'
    );
    candidates.forEach((el) => {
      const img = el.querySelector('img');
      const logo = img?.getAttribute('src') || img?.getAttribute('data-src') || undefined;
      const rawText = el.textContent?.trim() || img?.getAttribute('alt')?.trim() || '';
      const href =
        el.getAttribute('href') ||
        el.getAttribute('data-url') ||
        el.getAttribute('data-stream') ||
        el.getAttribute('data-src') ||
        el.getAttribute('data-href') ||
        el.getAttribute('data-link') ||
        el.getAttribute('data-video') ||
        el.querySelector('a')?.getAttribute('href') ||
        el.querySelector('source')?.getAttribute('src') ||
        '';
      const onclick =
        el.getAttribute('onclick') ||
        el.querySelector('[onclick]')?.getAttribute('onclick') ||
        '';
      const quotedUrlMatch = onclick.match(/['"](https?:\/\/[^'"]+)['"]/i);
      const unquotedUrlMatch = onclick.match(/(https?:\/\/[^'")\s]+)/i);
      const streamUrl =
        href && !href.startsWith('#') && !href.startsWith('javascript:')
          ? href
          : quotedUrlMatch
          ? quotedUrlMatch[1]
          : unquotedUrlMatch
          ? unquotedUrlMatch[1]
          : '';

      if (rawText && (streamUrl || logo)) {
        const {
          url,
          userAgent,
          referer,
          cookie,
          macAddress,
          authToken,
          xtreamParams,
        } = extractUrlAndPipeHeaders(
          streamUrl || 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
        );
        const attrMac = normalizeMacAddress(
          el.getAttribute('data-mac') || el.getAttribute('mac') || undefined
        );
        const finalMac = macAddress || attrMac;
        const finalCookie = buildMacCookieHeader(finalMac, cookie);
        const number = channels.length + 1;
        channels.push({
          id: `html-${number}-${Math.random().toString(36).slice(2, 7)}`,
          name: rawText.replace(/\s+/g, ' ').slice(0, 60),
          url,
          group: el.getAttribute('data-group') || el.getAttribute('data-category') || 'General',
          logo,
          userAgent,
          referer,
          cookie: finalCookie,
          macAddress: finalMac,
          authToken,
          xtreamParams,
          number,
        });
      }
    });

    // If no DOM elements matched, check <script> tags for embedded channel objects or stream URLs
    if (channels.length === 0) {
      const scripts = Array.from(doc.querySelectorAll('script'))
        .map((s) => s.textContent || '')
        .join('\n');
      const objRegex =
        /\{[^{}]*?(?:name|title)\s*:\s*["']([^"']+)["'][^{}]*?(?:url|src|file|stream|link)\s*:\s*["'](https?:\/\/[^"']+)["'][^{}]*?\}/gi;
      let match: RegExpExecArray | null;
      while ((match = objRegex.exec(scripts)) !== null) {
        const {
          url,
          userAgent,
          referer,
          cookie,
          macAddress,
          authToken,
          xtreamParams,
        } = extractUrlAndPipeHeaders(match[2]);
        const number = channels.length + 1;
        channels.push({
          id: `html-js-${number}-${Math.random().toString(36).slice(2, 7)}`,
          name: match[1].trim(),
          url,
          group: 'General',
          userAgent,
          referer,
          cookie,
          macAddress,
          authToken,
          xtreamParams,
          number,
        });
      }
    }
  } catch (err) {
    console.error('Failed to parse HTML playlist:', err);
  }

  if (channels.length === 0) {
    return parseM3U(content);
  }

  return channels;
}

/**
 * Automatically detects whether content is M3U, XSPF, JSON, or HTML and parses it.
 */
export function parsePlaylistContent(content: string, sourceUrl?: string): Channel[] {
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];

  if (trimmed.includes('#EXTINF:') || trimmed.includes('#EXTM3U')) {
    const m3u = parseM3U(trimmed, sourceUrl);
    if (m3u.length > 0) return m3u;
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsedJson = JSON.parse(trimmed);
      const arr = Array.isArray(parsedJson)
        ? parsedJson
        : Array.isArray(parsedJson?.channels)
        ? parsedJson.channels
        : Array.isArray(parsedJson?.js?.data)
        ? parsedJson.js.data
        : Array.isArray(parsedJson?.playlists?.[0]?.channels)
        ? parsedJson.playlists[0].channels
        : null;
      if (arr && arr.length > 0) {
        const jsonChannels: Channel[] = [];
        arr.forEach((item: Record<string, unknown>, idx: number) => {
          let rawUrl = String(
            item.url || item.stream || item.src || item.file || item.link || item.cmd || ''
          ).trim();
          if (!rawUrl) return;
          if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl) && sourceUrl) {
            try {
              rawUrl = new URL(rawUrl, sourceUrl).toString();
            } catch {
              // keep rawUrl
            }
          }
          const {
            url,
            userAgent,
            referer,
            cookie,
            macAddress,
            authToken,
            xtreamParams,
          } = extractUrlAndPipeHeaders(rawUrl);
          const itemMac = normalizeMacAddress(
            String(item.mac || item.macAddress || item.stb_mac || '')
          );
          const finalMac = macAddress || itemMac;
          const finalCookie = buildMacCookieHeader(
            finalMac,
            (item.cookie as string) || cookie
          );
          jsonChannels.push({
            id: String(item.id || `json-${idx + 1}-${Math.random().toString(36).slice(2, 7)}`),
            name: String(item.name || item.title || `Channel ${idx + 1}`).trim(),
            url,
            group: String(item.group || item.category || 'General').trim(),
            logo: item.logo ? String(item.logo) : undefined,
            userAgent: (item.userAgent as string) || userAgent,
            referer: (item.referer as string) || referer,
            cookie: finalCookie,
            macAddress: finalMac,
            authToken: (item.authToken as string) || (item.token as string) || authToken,
            xtreamParams: (item.xtreamParams as XtreamStreamParams) || xtreamParams,
            number: idx + 1,
          });
        });
        if (jsonChannels.length > 0) return jsonChannels;
      }
    } catch {
      // Fall through to other parsers
    }
  }

  if (trimmed.startsWith('<?xml') || trimmed.includes('<playlist') || trimmed.includes('<trackList>')) {
    const xspf = parseXSPF(trimmed);
    if (xspf.length > 0) return xspf;
  }
  if (trimmed.includes('<html') || trimmed.includes('<!DOCTYPE') || trimmed.includes('<div') || trimmed.includes('<a ')) {
    const htmlCh = parseHTMLPlaylist(trimmed);
    if (htmlCh.length > 0) return htmlCh;
  }
  return parseM3U(trimmed, sourceUrl);
}

/**
 * Built-in verified public HLS streams for testing IPTV playback immediately.
 */
export const SAMPLE_M3U_CONTENT = `#EXTM3U
#EXTINF:-1 tvg-id="NASA" group-title="Science & Space",NASA TV Public
https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8
#EXTINF:-1 tvg-id="DWEnglish" group-title="News",DW English Live
https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/index.m3u8
#EXTINF:-1 tvg-id="AlJazeera" group-title="News",Al Jazeera English
https://live-hls-web-aje.getaj.net/AJE/index.m3u8
#EXTINF:-1 tvg-id="France24" group-title="News",France 24 English
https://f24hls-i.akamaihd.net/hls/live/221147/F24_EN_HI_HLS/master_2000.m3u8
#EXTINF:-1 tvg-id="RedBullTV" group-title="Sports",Red Bull TV
https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8
#EXTINF:-1 tvg-id="BigBuckBunny" group-title="Movies & Animation",Big Buck Bunny HD (Test Stream)
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 tvg-id="Sintel" group-title="Movies & Animation",Sintel Open Movie 4K
https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8
#EXTINF:-1 tvg-id="TearsOfSteel" group-title="Movies & Animation",Tears of Steel Sci-Fi
https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8
#EXTINF:-1 tvg-id="AppleAdvanced" group-title="Tech & Demo",Apple BipBop Multivariant HLS
https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8
`;

export const PRESET_PLAYLIST_URLS = [
  {
    name: 'IPTV-Org India Channels (M3U)',
    url: 'https://iptv-org.github.io/iptv/countries/in.m3u',
  },
  {
    name: 'IPTV-Org Hindi Channels (M3U)',
    url: 'https://iptv-org.github.io/iptv/languages/hin.m3u',
  },
  {
    name: 'IPTV-Org News Channels (M3U)',
    url: 'https://iptv-org.github.io/iptv/categories/news.m3u',
  },
  {
    name: 'IPTV-Org Sports Channels (M3U)',
    url: 'https://iptv-org.github.io/iptv/categories/sports.m3u',
  },
];
