/**
 * Smart HLS Stream & Segment Proxy Loader for Static Deployments (GitHub Pages, etc.)
 * Solves the #1 cause of IPTV failures on GitHub Pages:
 * 1. Rewrites relative M3U8 chunk URIs to full absolute HTTPS URLs.
 * 2. Proxies insecure http:// media segments through active CORS / Cloudflare Worker bridges on https:// pages.
 * 3. Injects custom User-Agent, Referer, and Stalker MAC auth headers into query parameters.
 */

import Hls, {
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderResponse,
  LoaderStats,
} from 'hls.js';
import type { Channel } from './playlistParser';
import {
  buildPublicCorsProxyUrls,
  canUseBackendProxy,
  getCustomConfiguredBackendUrl,
  getEffectiveApiBaseUrl,
  isStaticHostEnvironment,
} from './proxyHelper';

/**
 * Transforms any target media URL into an HTTPS-safe, CORS-friendly URL suitable for
 * fetching directly from a browser on Cloudflare Pages or GitHub Pages.
 */
export function toSafeStreamingProxyUrl(
  targetUrl: string,
  channel?: Channel | null,
  fallbackUa?: string
): string {
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return targetUrl;
  }

  // Avoid re-wrapping if already proxied
  if (targetUrl.includes('/api/proxy?') || targetUrl.includes('/api/m3u8-proxy?')) {
    return targetUrl;
  }

  const isPageHttps =
    typeof window !== 'undefined' && window.location.protocol === 'https:';
  const isTargetHttp = /^http:\/\//i.test(targetUrl);

  // 1. Check if user configured a custom Cloudflare Worker or backend proxy URL
  const customProxy = getCustomConfiguredBackendUrl();
  if (customProxy) {
    const encoded = encodeURIComponent(targetUrl);
    let qs = `url=${encoded}`;
    const effectiveUa = (channel?.userAgent || fallbackUa || '').trim();
    if (effectiveUa) qs += `&ua=${encodeURIComponent(effectiveUa)}`;
    if (channel?.referer) qs += `&ref=${encodeURIComponent(channel.referer)}`;
    if (channel?.cookie) qs += `&cookie=${encodeURIComponent(channel.cookie)}`;
    if (channel?.macAddress) qs += `&mac=${encodeURIComponent(channel.macAddress)}`;
    if (channel?.authToken) qs += `&auth=${encodeURIComponent(channel.authToken)}`;

    if (customProxy.includes('workers.dev') || !customProxy.includes('/api')) {
      return `${customProxy}/?${qs}`;
    }
    return `${customProxy}/api/proxy?${qs}`;
  }

  // 2. Route through active backend proxy or Cloudflare Pages Functions/Worker (/api/proxy)
  if (canUseBackendProxy()) {
    const effectiveBase = getEffectiveApiBaseUrl();
    const encoded = encodeURIComponent(targetUrl);
    let qs = `url=${encoded}`;
    const effectiveUa = (channel?.userAgent || fallbackUa || '').trim();
    if (effectiveUa) qs += `&ua=${encodeURIComponent(effectiveUa)}`;
    if (channel?.referer) qs += `&ref=${encodeURIComponent(channel.referer)}`;
    if (channel?.cookie) qs += `&cookie=${encodeURIComponent(channel.cookie)}`;
    if (channel?.macAddress) qs += `&mac=${encodeURIComponent(channel.macAddress)}`;
    if (channel?.authToken) qs += `&auth=${encodeURIComponent(channel.authToken)}`;
    return `${effectiveBase || ''}/api/proxy?${qs}`;
  }

  // 3. Fallback: If page is HTTPS and target is HTTP (GitHub Pages mixed content constraint),
  // upgrade to https:// if standard port 80 or omitted
  if (isPageHttps && isTargetHttp && /^http:\/\/[^/:]+(\/|$)/i.test(targetUrl)) {
    return targetUrl.replace(/^http:\/\//i, 'https://');
  }

  return targetUrl;
}


/**
 * Rewrites M3U8 playlist content on the fly:
 * - Converts relative segment URIs into absolute URLs based on the master playlist URL.
 * - Rewrites `#EXT-X-KEY:METHOD=...,URI="..."` encryption keys.
 * - Routes through custom Cloudflare Worker proxy if configured in Settings.
 */
export function rewriteM3u8PlaylistContent(
  m3u8Text: string,
  playlistUrl: string,
  channel?: Channel | null,
  fallbackUa?: string
): string {
  if (!m3u8Text || typeof m3u8Text !== 'string') return m3u8Text;
  if (!m3u8Text.includes('#EXTM3U')) return m3u8Text;

  const lines = m3u8Text.split(/\r?\n/);
  const isPageHttps =
    typeof window !== 'undefined' && window.location.protocol === 'https:';

  const rewrittenLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // 1. Rewrite Encryption Key URIs: #EXT-X-KEY:METHOD=AES-128,URI="key.php"
    if (trimmed.startsWith('#EXT-X-KEY:')) {
      return trimmed.replace(/URI=["']([^"']+)["']/i, (_match, keyUri) => {
        let absKey = keyUri;
        try {
          absKey = new URL(keyUri, playlistUrl).href;
        } catch {
          absKey = keyUri;
        }
        const safeKey = isPageHttps
          ? toSafeStreamingProxyUrl(absKey, channel, fallbackUa)
          : absKey;
        return `URI="${safeKey}"`;
      });
    }

    // 2. Pass other comment/tag lines as-is
    if (trimmed.startsWith('#')) {
      return line;
    }

    // 3. Media segment or child playlist URI:
    // Resolve relative path against playlistUrl
    let absSegmentUrl: string;
    try {
      absSegmentUrl = new URL(trimmed, playlistUrl).href;
    } catch {
      absSegmentUrl = trimmed;
    }

    // Route through safe proxy if user configured custom Cloudflare Worker proxy, or active backend/pages proxy, or if upgrading http to https
    const customProxy = getCustomConfiguredBackendUrl();
    if (customProxy || canUseBackendProxy() || (isPageHttps && /^http:\/\//i.test(absSegmentUrl))) {
      return toSafeStreamingProxyUrl(absSegmentUrl, channel, fallbackUa);
    }

    return absSegmentUrl;
  });

  return rewrittenLines.join('\n');
}

/**
 * Creates a specialized Hls.js Loader class that transparently intercepts
 * manifest and fragment loading to bypass GitHub Pages CORS and Mixed Content.
 */
export function createSmartHlsLoaderClass(
  channel?: Channel | null,
  fallbackUa?: string
): Hls['config']['loader'] {
  const BaseLoader = Hls.DefaultConfig.loader;

  return class SmartHlsLoader extends (BaseLoader as any) {
    private originalContextUrl = '';

    constructor(config: any) {
      super(config);
    }

    load(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>
    ) {
      this.originalContextUrl = context.url;
      const isPageHttps =
        typeof window !== 'undefined' && window.location.protocol === 'https:';
      const customProxy = getCustomConfiguredBackendUrl();

      // Transform URL for loading if needed
      let targetUrl = context.url;
      if (customProxy || canUseBackendProxy() || (isPageHttps && /^http:\/\//i.test(targetUrl))) {
        targetUrl = toSafeStreamingProxyUrl(targetUrl, channel, fallbackUa);
      }


      // Clone context with safe target URL
      const transformedContext: LoaderContext = {
        ...context,
        url: targetUrl,
      };

      // Wrap callbacks to rewrite M3U8 playlist content on success
      const wrappedCallbacks: LoaderCallbacks<LoaderContext> = {
        onSuccess: (
          response: LoaderResponse,
          stats: LoaderStats,
          ctx: LoaderContext,
          networkDetails: any
        ) => {
          // If manifest or level playlist text was loaded, rewrite segment URLs
          if (
            (ctx.type === 'manifest' || ctx.type === 'level') &&
            typeof response.data === 'string'
          ) {
            const rawM3u8 = response.data;
            const rewritten = rewriteM3u8PlaylistContent(
              rawM3u8,
              this.originalContextUrl || ctx.url,
              channel,
              fallbackUa
            );
            response.data = rewritten;
          }

          callbacks.onSuccess(response, stats, ctx, networkDetails);
        },
        onError: (error: any, ctx: LoaderContext, networkDetails: any, stats: LoaderStats) => {
          callbacks.onError(error, ctx, networkDetails, stats);
        },
        onTimeout: (stats: LoaderStats, ctx: LoaderContext, networkDetails: any) => {
          callbacks.onTimeout(stats, ctx, networkDetails);
        },
        onProgress: (
          stats: LoaderStats,
          ctx: LoaderContext,
          data: string | ArrayBuffer,
          networkDetails: any
        ) => {
          if (callbacks.onProgress) {
            callbacks.onProgress(stats, ctx, data, networkDetails);
          }
        },
        onAbort: (stats: LoaderStats, ctx: LoaderContext, networkDetails: any) => {
          if (callbacks.onAbort) {
            callbacks.onAbort(stats, ctx, networkDetails);
          }
        },
      };

      super.load(transformedContext, config, wrappedCallbacks);
    }
  } as unknown as Hls['config']['loader'];
}
