/**
 * Cloudflare Pages Functions Handler (Catch-all for /api/*)
 * Runs on Cloudflare's Edge network on your *.pages.dev domain.
 * 
 * Features:
 * - /api/probe: Health check endpoint for web app connectivity
 * - /api/proxy & /api/m3u8-proxy: Stream tunneling, CORS injection, header spoofing
 * - Automatic M3U8 manifest rewriting (TS chunks, encryption keys)
 * - HTTP Range request forwarding for video seeking & scrubbing
 * - Full CORS headers (Access-Control-Allow-Origin: *)
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

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // 1. Health check / probe endpoint
  if (url.pathname.endsWith('/probe') || url.pathname.endsWith('/health') || url.pathname.endsWith('/ping')) {
    return new Response(
      JSON.stringify({ status: 'ok', proxy: 'cloudflare-pages', time: Date.now() }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      }
    );
  }

  // 2. Extract target URL from query parameter or path
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
        service: 'Cloudflare Pages IPTV Proxy',
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

  // 3. Extract custom IPTV headers & auth
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

  // Assemble cookies (including Stalker / Ministra MAC authentication)
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

  // Forward Range header for video seeking and partial downloads
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

    // 4. M3U8 Manifest Rewriting: rewrites segments and key URIs so they route through this proxy
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

          // Rewrite Encryption Keys
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

          // Preserve tags / comments
          if (trimmed.startsWith('#')) {
            return line;
          }

          // Rewrite segment URI (relative or absolute)
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

    // 5. Binary video/audio stream forwarding (VOD MP4/MKV/TS/WebM)
    // Guarantee proper video MIME type so HTML5 <video> never fails on application/octet-stream
    const finalMime = detectVideoMimeType(targetUrl, contentType);
    responseHeaders.set('Content-Type', finalMime);
    responseHeaders.set('Content-Disposition', 'inline');
    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('X-Accel-Buffering', 'no');
    responseHeaders.set('Cache-Control', 'no-cache, no-store');

    let finalStatus = upstreamRes.status;
    const cl = upstreamRes.headers.get('content-length');
    const cr = upstreamRes.headers.get('content-range');

    // If client requested Range starting at 0 and upstream returned 200 with Content-Length,
    // synthesize 206 Partial Content so browser video engine enables HTTP byte-range seeking
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
