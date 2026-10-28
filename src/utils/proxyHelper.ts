/**
 * Smart Proxy & Backend Resolution Helper
 * Ensures the IPTV Web App works seamlessly both when deployed on full-stack Node/Cloud Run
 * AND when deployed as a static site on GitHub Pages (*.github.io), Vercel, Netlify, or custom domains.
 */

import type { Channel } from './playlistParser';

const REMOTE_BACKEND_FALLBACK_URLS = [
  (import.meta as unknown as { env?: Record<string, string> })?.env?.VITE_API_BASE_URL || '',
].filter(Boolean);

let resolvedApiBaseUrl: string | null = null;
let backendAvailable = false;
let probePromise: Promise<string | null> | null = null;
let probeFinished = false;

/**
 * Reads any user-configured proxy host from localStorage (`iptv_backend_proxy_url` or `iptv_proxy_settings_v1`)
 * if it looks like a full HTTP/HTTPS backend URL.
 */
export function getCustomConfiguredBackendUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    // 1. Check direct backend proxy URL setting
    const directUrl = window.localStorage.getItem('iptv_backend_proxy_url');
    if (directUrl && /^https?:\/\//i.test(directUrl.trim())) {
      return directUrl.trim().replace(/\/+$/, '');
    }

    // 2. Check structured proxy settings
    const raw = window.localStorage.getItem('iptv_proxy_settings_v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { enabled?: boolean; host?: string; port?: string };
    if (parsed?.enabled && parsed.host) {
      let h = parsed.host.trim();
      if (!/^https?:\/\//i.test(h)) {
        h = `http://${h}${parsed.port ? `:${parsed.port}` : ''}`;
      }
      return h.replace(/\/+$/, '');
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Detects if the current environment is a static-only host (like GitHub Pages, Vercel, Netlify,
 * or any host where `/api/probe` was checked and found not to be our Express server).
 */
export function isStaticHostEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  if (probeFinished) {
    return !backendAvailable;
  }
  const host = window.location.hostname.toLowerCase();
  const proto = window.location.protocol.toLowerCase();
  if (proto === 'file:' || proto === 'capacitor:' || proto === 'ionic:') {
    return true;
  }
  // Only pure static hosts without native serverless proxy functions by default
  return (
    host.endsWith('.github.io') ||
    host.endsWith('.githubusercontent.com') ||
    host.endsWith('.surge.sh') ||
    host.endsWith('.gitlab.io')
  );
}


async function checkBackendUrl(baseUrl: string, timeoutMs = 2400): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 1. Try /api/probe (Express server or Cloudflare Worker with /api/probe route)
    const testUrl = `${baseUrl}/api/probe`;
    const res = await fetch(testUrl, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (res.ok) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/json')) {
        return true;
      }
    }
    // 2. Try root URL with health check query (for Cloudflare Workers / custom proxies)
    const rootRes = await fetch(`${baseUrl}/?url=`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (rootRes.ok) {
      const ct = (rootRes.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/json') || ct.includes('text/plain')) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Probes and caches the active backend base URL (`""` for same-origin Express server,
 * or custom backend URL when hosted on GitHub Pages, or `null` if no backend is reachable).
 */
export async function ensureBackendProbed(): Promise<string | null> {
  if (probeFinished) {
    return backendAvailable ? resolvedApiBaseUrl : null;
  }
  if (probePromise) {
    return probePromise;
  }

  probePromise = (async () => {
    const candidates: string[] = [];
    const host = typeof window !== 'undefined' ? window.location.hostname.toLowerCase() : '';
    const isPureStatic =
      host.endsWith('.github.io') ||
      host.endsWith('.githubusercontent.com') ||
      host.endsWith('.surge.sh');

    // Always probe same-origin ('') unless on explicit static-only host (e.g. GitHub Pages)
    // On Cloudflare Pages (*.pages.dev), '' routes directly to functions/api or _worker.js!
    if (!isPureStatic) {
      candidates.push('');
    }
    const customBackend = getCustomConfiguredBackendUrl();
    if (customBackend) {
      candidates.push(customBackend);
    }
    const envApiUrl = (
      (import.meta as unknown as { env?: Record<string, string> })?.env?.VITE_API_BASE_URL || ''
    )
      .trim()
      .replace(/\/+$/, '');
    if (envApiUrl && !candidates.includes(envApiUrl)) {
      candidates.push(envApiUrl);
    }
    for (const remoteUrl of REMOTE_BACKEND_FALLBACK_URLS) {
      if (remoteUrl && !candidates.includes(remoteUrl)) {
        candidates.push(remoteUrl);
      }
    }

    for (const candidate of candidates) {
      const ok = await checkBackendUrl(candidate, 1800);
      if (ok) {
        resolvedApiBaseUrl = candidate;
        backendAvailable = true;
        probeFinished = true;
        return candidate;
      }
    }

    // On static deployments (e.g. GitHub Pages), if no probe succeeded, there is NO backend available.
    // Do NOT fall back to fake/dead URLs. Mark as unavailable so app uses direct/CORS streaming!
    resolvedApiBaseUrl = null;
    backendAvailable = false;
    probeFinished = true;
    return null;
  })();

  return probePromise;
}

// Kick off background probe immediately on module load in browser
if (typeof window !== 'undefined') {
  ensureBackendProbed().catch(() => {});
}

/**
 * Synchronously returns the verified active API base URL, or empty string if no backend proxy is running.
 */
export function getEffectiveApiBaseUrl(): string {
  const customBackend = getCustomConfiguredBackendUrl();
  if (customBackend) {
    return customBackend;
  }
  if (backendAvailable && resolvedApiBaseUrl !== null) {
    return resolvedApiBaseUrl; // Can be '' for same-origin proxy (Cloudflare Pages or Express)
  }
  if (!isStaticHostEnvironment()) {
    return ''; // Same-origin relative path /api/*
  }
  return '';
}

/**
 * Returns whether the backend proxy/transcode server can be used.
 * When running in full-stack Node.js Express environment or Cloudflare Pages with active functions/worker, this is true.
 */
export function canUseBackendProxy(): boolean {
  if (probeFinished) {
    return backendAvailable || Boolean(getCustomConfiguredBackendUrl());
  }
  if (!isStaticHostEnvironment()) {
    return true; // We are running a full-stack Express Node.js or Cloudflare Pages environment
  }
  return backendAvailable || Boolean(getCustomConfiguredBackendUrl());
}


/**
 * Detects whether a channel is a direct VOD URL (MP4, MKV, AVI, WebM, MOV, /movie/, /series/, /vod/, Pixeldrain, etc.)
 * that needs to be routed through the proxy server to avoid browser CORS and Mixed Content issues.
 */
export function isDirectVodChannel(
  channel:
    | Channel
    | {
        name?: string;
        url?: string;
        group?: string;
        xtreamParams?: { streamType?: string };
        forceProxy?: boolean;
        isProxied?: boolean;
      }
): boolean {
  if (!channel || !channel.url) return false;
  if (channel.forceProxy || channel.isProxied) return true;

  const cleanUrl = channel.url.trim().toLowerCase();

  // If already proxied
  if (cleanUrl.includes('/api/proxy?') || cleanUrl.includes('api.cors.lol') || cleanUrl.includes('corsproxy.io')) {
    return true;
  }

  // Direct VOD media container extensions
  if (/\.(mp4|mkv|avi|webm|mov|m4v|flv|wmv|3gp|mpg|mpeg|divx|ogv)(\?|$|#|&)/i.test(cleanUrl)) {
    return true;
  }

  // URL query parameter specifying VOD format
  if (/[?&](?:extension|output|format)=(?:mp4|mkv|avi|mov|webm)\b/i.test(cleanUrl)) {
    return true;
  }

  // Common IPTV VOD path segments
  if (/\/(movie|series|vod)\//i.test(cleanUrl)) {
    return true;
  }

  // VOD hosting services and cloud drives
  if (
    /pixeldrain\.(com|dev)|archive\.org|drive\.usercontent\.google\.com|drive\.google\.com|dropbox\.com|dropboxusercontent\.com|1fichier\.com|mega\.nz|mediafire\.com|gofile\.io|terabox|streamtape|streamwish|mixdrop|filemoon/i.test(
      cleanUrl
    )
  ) {
    return true;
  }

  // Xtream streamType
  if (channel.xtreamParams?.streamType === 'movie' || channel.xtreamParams?.streamType === 'series') {
    return true;
  }

  // Group name hint for VOD (e.g. "VOD Movies", "Series") unless it's an HLS live stream
  const group = (channel.group || '').toLowerCase();
  if (
    (group.includes('vod') ||
      group.includes('movie') ||
      group.includes('movies') ||
      group.includes('series') ||
      group.includes('cinema') ||
      group.includes('film')) &&
    !/\.m3u8(\?|$|#|&)/i.test(cleanUrl)
  ) {
    return true;
  }

  // Channel name hint for VOD (e.g. "[VOD] Avatar", "Movie 2024")
  const name = ((channel as Channel).name || '').toLowerCase();
  if (
    (name.includes('vod') || /\b(movie|film|cinema|series|season|episode|s\d+e\d+)\b/i.test(name)) &&
    !/\.m3u8(\?|$|#|&)/i.test(cleanUrl)
  ) {
    return true;
  }

  return false;
}

/**
 * Builds the proxy streaming URL for any channel.
 * Routes through the active backend / proxy server with authenticated query parameters.
 */
export function buildChannelProxyUrl(
  channel: Channel,
  fallbackUa?: string,
  overrideTargetUrl?: string,
  baseUrlOverride?: string
): string {
  const targetUrl = (overrideTargetUrl || channel.originalUrl || channel.url || '').trim();

  // If targetUrl is already a complete proxy URL, avoid double-wrapping
  if (targetUrl.includes('/api/proxy?')) {
    return targetUrl;
  }

  // If on a static host without a reachable backend proxy, return raw target
  if (!canUseBackendProxy() && baseUrlOverride === undefined) {
    return targetUrl;
  }

  const base = baseUrlOverride !== undefined ? baseUrlOverride : getEffectiveApiBaseUrl();

  let qs = `url=${encodeURIComponent(targetUrl)}`;
  const effectiveUa = (channel.userAgent || fallbackUa || '').trim();
  if (effectiveUa) {
    qs += `&ua=${encodeURIComponent(effectiveUa)}`;
  }
  if (channel.referer) {
    qs += `&ref=${encodeURIComponent(channel.referer)}`;
  }
  if (channel.cookie) {
    qs += `&cookie=${encodeURIComponent(channel.cookie)}`;
  }
  if (channel.macAddress) {
    qs += `&mac=${encodeURIComponent(channel.macAddress)}`;
  }
  if (channel.authToken) {
    qs += `&auth=${encodeURIComponent(channel.authToken)}`;
  }
  if (channel.xtreamParams) {
    qs += `&xtreamServer=${encodeURIComponent(channel.xtreamParams.server)}`;
    qs += `&xtreamUser=${encodeURIComponent(channel.xtreamParams.username)}`;
    qs += `&xtreamPass=${encodeURIComponent(channel.xtreamParams.password)}`;
    qs += `&xtreamStreamId=${encodeURIComponent(channel.xtreamParams.streamId)}`;
    qs += `&xtreamType=${encodeURIComponent(channel.xtreamParams.streamType)}`;
  }
  if (channel.name) {
    qs += `&title=${encodeURIComponent(channel.name)}`;
  }

  if (base && base.endsWith('/api/proxy')) {
    return `${base}?${qs}`;
  }
  return `${base || ''}/api/proxy?${qs}`;
}

/**
 * Builds public CORS & HTTPS-bridge proxy URLs for fetching or streaming media/M3U/HLS/VOD
 * directly from the browser when deployed on GitHub Pages (HTTPS) or when backend proxy is unavailable.
 */
export function buildPublicCorsProxyUrls(
  targetUrl: string,
  authParams?: {
    ua?: string;
    ref?: string;
    mac?: string;
    cookie?: string;
    auth?: string;
  }
): string[] {
  if (!/^https?:\/\//i.test(targetUrl)) return [];
  const encoded = encodeURIComponent(targetUrl);
  const urls: string[] = [];

  // 1. User-configured backend proxy or Cloudflare Worker from Settings
  const custom = getCustomConfiguredBackendUrl();
  if (custom) {
    let qs = `url=${encoded}`;
    if (authParams?.ua) qs += `&ua=${encodeURIComponent(authParams.ua)}`;
    if (authParams?.ref) qs += `&ref=${encodeURIComponent(authParams.ref)}`;
    if (authParams?.mac) qs += `&mac=${encodeURIComponent(authParams.mac)}`;
    if (authParams?.cookie) qs += `&cookie=${encodeURIComponent(authParams.cookie)}`;
    if (authParams?.auth) qs += `&auth=${encodeURIComponent(authParams.auth)}`;

    if (custom.includes('workers.dev') || !custom.includes('/api')) {
      urls.push(`${custom}/?${qs}`);
    } else {
      urls.push(`${custom}/api/proxy?${qs}`);
    }
  }

  // 2. Active backend proxy or Cloudflare Pages proxy when probed and available
  if (canUseBackendProxy()) {
    const effectiveBase = getEffectiveApiBaseUrl();
    if (effectiveBase !== custom) {
      let qs = `url=${encoded}`;
      if (authParams?.ua) qs += `&ua=${encodeURIComponent(authParams.ua)}`;
      if (authParams?.ref) qs += `&ref=${encodeURIComponent(authParams.ref)}`;
      if (authParams?.mac) qs += `&mac=${encodeURIComponent(authParams.mac)}`;
      if (authParams?.cookie) qs += `&cookie=${encodeURIComponent(authParams.cookie)}`;
      if (authParams?.auth) qs += `&auth=${encodeURIComponent(authParams.auth)}`;
      urls.push(`${effectiveBase || ''}/api/proxy?${qs}`);
    }
  }


  // 3. Fallback open CORS bridge for static text/M3U/JSON fetching when no custom proxy is configured
  if (urls.length === 0) {
    urls.push(`https://api.allorigins.win/raw?url=${encoded}`);
  }

  return urls;
}

/**
 * Given any media URL (HTTP or HTTPS), returns an ordered list of browser-safe URLs
 * that will not be blocked by Mixed Content or CORS on HTTPS GitHub Pages deployments.
 * When `forNativeVideo` is true, optimizes for native HTML5 <video> playback.
 */
export function getHttpsSafeMediaUrls(rawUrl: string, forNativeVideo = false): string[] {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return [];
  const urls: string[] = [];
  const pushUnique = (u?: string) => {
    if (u && !urls.includes(u)) urls.push(u);
  };

  const isPageHttps =
    typeof window !== 'undefined' && window.location.protocol === 'https:';
  const isTargetHttp = /^http:\/\//i.test(rawUrl);

  if (!isPageHttps) {
    // Page is HTTP: direct streaming works natively
    pushUnique(rawUrl);
    return urls;
  }

  if (!isTargetHttp) {
    // Target is already HTTPS:
    // Native HTML5 <video src="..."> can load cross-origin HTTPS media directly without CORS headers
    pushUnique(rawUrl);

    // If used for JS/Hls.js/MSE fetch, also provide CORS proxies in case the server lacks CORS headers
    if (!forNativeVideo) {
      for (const corsUrl of buildPublicCorsProxyUrls(rawUrl)) {
        pushUnique(corsUrl);
      }
    }
    return urls;
  }

  // Page is HTTPS (e.g. GitHub Pages) and target media URL is plain http://
  // 1. If user configured custom proxy (e.g. Cloudflare Worker), prioritize it
  for (const corsUrl of buildPublicCorsProxyUrls(rawUrl)) {
    pushUnique(corsUrl);
  }

  // 2. Direct HTTPS upgrade attempt ONLY if port is default 80 or omitted (fallback after proxy to prevent ERR_CONNECTION_REFUSED)
  if (/^http:\/\/[^/:]+(\/|$)/i.test(rawUrl)) {
    pushUnique(rawUrl.replace(/^http:\/\//i, 'https://'));
  }

  // 3. Keep rawUrl as final fallback (some WebViews/browsers permit passive mixed-content video)
  pushUnique(rawUrl);

  return urls;
}

/**
 * Fetches a playlist / M3U / XSPF / XMLTV / JSON URL with automatic fallback across:
 * 1. Active Backend Proxy (if available)
 * 2. Direct Browser Fetch
 * 3. Public CORS Proxies (essential for GitHub Pages static deployments)
 */
export async function fetchWithUniversalFallback(
  targetUrl: string,
  proxyQuerySuffix: string
): Promise<Response> {
  const baseUrl = await ensureBackendProbed();

  // 1. If we are on a static host (like GitHub Pages), try Direct Fetch first for fast CORS-friendly HTTPS URLs
  if (isStaticHostEnvironment() && /^https:\/\//i.test(targetUrl)) {
    try {
      const directRes = await fetch(targetUrl);
      if (directRes.ok) return directRes;
    } catch {
      // continue to proxy fallbacks
    }
  }

  // 2. Try verified backend proxy (local or remote Cloud Run / custom proxy)
  if (baseUrl !== null && (baseUrl !== '' || !isStaticHostEnvironment())) {
    try {
      const proxyUrl = baseUrl.endsWith('/api/proxy')
        ? `${baseUrl}?${proxyQuerySuffix}`
        : `${baseUrl}/api/proxy?${proxyQuerySuffix}`;
      const proxyRes = await fetch(proxyUrl);
      const ct = (proxyRes.headers.get('content-type') || '').toLowerCase();
      // Guard against static hosts returning 200/404 SPA index.html for /api/proxy
      const isSpaFallbackHtml =
        baseUrl === '' &&
        ct.includes('text/html') &&
        !targetUrl.toLowerCase().endsWith('.html');
      if (proxyRes.ok && !isSpaFallbackHtml) {
        return proxyRes;
      }
    } catch {
      // continue
    }
  }

  // 3. Try Direct Browser Fetch (if not already tried)
  if (!isStaticHostEnvironment()) {
    try {
      const directRes = await fetch(targetUrl);
      if (directRes.ok) return directRes;
    } catch {
      // continue
    }
  }

  // 4. Try Public CORS Proxies / Cloudflare Worker (ensures GitHub Pages can load any HTTP/HTTPS M3U/Xtream/VOD URL)
  const corsUrls = buildPublicCorsProxyUrls(targetUrl);
  for (const corsUrl of corsUrls) {
    try {
      const corsRes = await fetch(corsUrl);
      if (corsRes.ok) return corsRes;
    } catch {
      // try next CORS proxy
    }
  }

  throw new Error('Failed to fetch resource across all direct and proxy routes');
}
