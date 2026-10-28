/**
 * Cloudflare Pages Advanced Mode Worker (_worker.js)
 * Automatically invoked by Cloudflare Pages when deployed from dist/ or repository.
 * 
 * - Intercepts all /api/ requests (probe, proxy, m3u8-proxy, stream)
 * - Transparently proxies HTTP and HTTPS IPTV streams, bypasses Mixed Content & CORS
 * - Rewrites M3U8 chunk lists and encryption keys
 * - Delegates all static frontend assets to env.ASSETS.fetch(request)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Date, Server, Transfer-Encoding',
  'Access-Control-Max-Age': '86400',
};

function detectVideoMimeType(urlStr, contentType) {
  const ct = (contentType || '').toLowerCase().trim();
  if (ct.startsWith('video/') || ct.startsWith('audio/')) {
    return contentType;
  }
  const clean = urlStr.toLowerCase().split('?')[0];
  if (clean.endsWith('.mp4') || clean.endsWith('.m4v')) return 'video/mp4';
  if (clean.endsWith('.mkv')) return 'video/x-matroska';
  if (clean.endsWith('.webm')) return 'video/webm';
  if (clean.endsWith('.ts')) return 'video/mp2t';
  if (clean.endsWith('.mov')) return 'video/quicktime';
  if (clean.endsWith('.avi')) return 'video/x-msvideo';
  if (clean.endsWith('.flv')) return 'video/x-flv';
  if (clean.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (/\/(movie|series|vod)\//i.test(urlStr)) return 'video/mp4';
  return 'video/mp4';
}

async function handleApiRequest(request) {
  const url = new URL(request.url);

  // 1. CORS Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  // 2. Health check / probe
  if (url.pathname.endsWith('/probe') || url.pathname.endsWith('/health') || url.pathname.endsWith('/ping')) {
    return new Response(
      JSON.stringify({ status: 'ok', proxy: 'cloudflare-pages-worker', time: Date.now() }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      }
    );
  }

  // 3. Extract target URL
  let targetUrl = url.searchParams.get('url') || url.searchParams.get('target');
  if (!targetUrl) {
    const match = url.pathname.match(/^\/api\/(?:proxy|stream|m3u8-proxy)\/(https?:\/.+)$/i);
    if (match) {
      targetUrl = match[1].replace(/^(https?:\/)(?=[^/])/, '$1/');
    }
  }

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl.trim())) {
    return new Response(
      JSON.stringify({
        status: 'ok',
        service: 'Cloudflare Pages IPTV Worker',
        usage: '/api/proxy?url=http://example.com/stream.m3u8',
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      }
    );
  }

  targetUrl = targetUrl.trim();

  // 4. Headers & authentication parameters
  const customUa =
    url.searchParams.get('ua') ||
    url.searchParams.get('userAgent') ||
    request.headers.get('User-Agent') ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  const customRef = url.searchParams.get('ref') || url.searchParams.get('referer');
  const customMac = url.searchParams.get('mac') || url.searchParams.get('macAddress');
  const customCookie = url.searchParams.get('cookie') || url.searchParams.get('cookies');
  const customAuth = url.searchParams.get('auth') || url.searchParams.get('authToken');

  const upstreamHeaders = new Headers();
  upstreamHeaders.set('User-Agent', customUa);
  upstreamHeaders.set('Accept', '*/*');
  if (customRef) {
    upstreamHeaders.set('Referer', customRef);
  }

  const cookieParts = [];
  if (customMac) {
    cookieParts.push(`mac=${customMac}`);
    cookieParts.push(`stb_sn=${customMac.replace(/[^a-zA-Z0-9]/g, '')}`);
  }
  if (customAuth) {
    cookieParts.push(`token=${customAuth}`);
  }
  if (customCookie) {
    cookieParts.push(customCookie);
  }
  if (cookieParts.length > 0) {
    upstreamHeaders.set('Cookie', cookieParts.join('; '));
  }

  const clientRange = request.headers.get('Range');
  if (clientRange) {
    upstreamHeaders.set('Range', clientRange);
  }

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
      redirect: 'follow',
    });

    const responseHeaders = new Headers(upstreamRes.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      responseHeaders.set(k, v);
    }

    const contentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();
    const isM3u8 =
      targetUrl.includes('.m3u8') ||
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl') ||
      url.pathname.includes('/m3u8-proxy');

    // 5. M3U8 Manifest Rewriting
    if (isM3u8 && upstreamRes.ok && request.method !== 'HEAD') {
      const manifestText = await upstreamRes.text();
      const origin = url.origin;
      const proxyEndpoint = `${origin}/api/proxy`;

      const authParams = [];
      if (customUa) authParams.push(`ua=${encodeURIComponent(customUa)}`);
      if (customRef) authParams.push(`ref=${encodeURIComponent(customRef)}`);
      if (customMac) authParams.push(`mac=${encodeURIComponent(customMac)}`);
      if (customCookie) authParams.push(`cookie=${encodeURIComponent(customCookie)}`);
      if (customAuth) authParams.push(`auth=${encodeURIComponent(customAuth)}`);
      const qsExtra = authParams.length > 0 ? `&${authParams.join('&')}` : '';

      const rewritten = manifestText
        .split(/\r?\n/)
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          if (trimmed.startsWith('#EXT-X-KEY:')) {
            return trimmed.replace(/URI=["']([^"']+)["']/i, (_match, keyUri) => {
              try {
                const absKey = new URL(keyUri, targetUrl).href;
                return `URI="${proxyEndpoint}?url=${encodeURIComponent(absKey)}${qsExtra}"`;
              } catch {
                return `URI="${keyUri}"`;
              }
            });
          }

          if (trimmed.startsWith('#')) {
            return line;
          }

          try {
            const absSegment = new URL(trimmed, targetUrl).href;
            return `${proxyEndpoint}?url=${encodeURIComponent(absSegment)}${qsExtra}`;
          } catch {
            return line;
          }
        })
        .join('\n');

      responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
      responseHeaders.delete('content-length');
      return new Response(rewritten, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    }

    // 6. Direct binary stream forwarding (VOD MP4/MKV/TS/WebM)
    const finalMime = detectVideoMimeType(targetUrl, contentType);
    responseHeaders.set('Content-Type', finalMime);
    responseHeaders.set('Content-Disposition', 'inline');
    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('X-Accel-Buffering', 'no');
    responseHeaders.set('Cache-Control', 'no-cache, no-store');

    let finalStatus = upstreamRes.status;
    const cl = upstreamRes.headers.get('content-length');
    const cr = upstreamRes.headers.get('content-range');

    if (
      finalStatus === 200 &&
      clientRange &&
      /^bytes=0-/i.test(clientRange.trim()) &&
      cl &&
      !cr
    ) {
      const totalLen = parseInt(cl, 10);
      if (Number.isFinite(totalLen) && totalLen > 0) {
        responseHeaders.set('Content-Range', `bytes 0-${totalLen - 1}/${totalLen}`);
        finalStatus = 206;
      }
    }

    return new Response(upstreamRes.body, {
      status: finalStatus,
      statusText: upstreamRes.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'Proxy Fetch Error',
        message: err?.message || String(err),
        targetUrl,
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      }
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // If request targets API endpoints or has a stream query url, route to the proxy handler
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname === '/health' ||
      url.pathname === '/ping' ||
      (url.searchParams.has('url') && /^https?:\/\//i.test(url.searchParams.get('url') || ''))
    ) {
      return handleApiRequest(request);
    }

    // Serve static assets if running in Cloudflare Pages Advanced Mode
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    // Standalone fallback
    return handleApiRequest(request);
  },
};
