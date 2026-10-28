/**
 * =====================================================================
 * CLOUDFLARE WORKER IPTV STREAM & CORS PROXY (गिटहब पेजेस प्रॉक्सी)
 * =====================================================================
 * Free Cloudflare Worker for hosting IPTV Player on GitHub Pages (*.github.io).
 * 
 * FEATURES:
 * 1. 100% Free Forever (100,000 requests per day on Cloudflare Workers free plan).
 * 2. Rewrites M3U8 playlists & encryption keys so relative TS segments stream through proxy.
 * 3. Injects custom User-Agent (VLC/MAG STB), Referer, and Stalker MAC cookies.
 * 4. Adds full CORS headers (Access-Control-Allow-Origin: *) and Range seek support.
 * 
 * 1-MINUTE SETUP INSTRUCTIONS:
 * 1. Visit: https://workers.cloudflare.com (Sign in or create free account)
 * 2. Click "Create Worker" or "Create Application" -> "Worker".
 * 3. Click "Deploy", then "Edit Code".
 * 4. Paste this ENTIRE file content and click "Save and Deploy".
 * 5. Copy your Worker URL (e.g. https://my-iptv.your-name.workers.dev).
 * 6. In your IPTV Web App, open Settings -> Proxy Settings -> paste Worker URL.
 * =====================================================================
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 2. Health check / probe endpoint for the web app
    if (url.pathname === '/api/probe' || url.pathname === '/health' || url.pathname === '/ping') {
      return new Response(
        JSON.stringify({ status: 'ok', proxy: 'cloudflare-worker', time: Date.now() }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // 3. Extract target URL from query parameter: ?url=http://...
    let targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      // Support path-based proxying: /proxy/http://...
      const match = url.pathname.match(/^\/(?:proxy|stream)\/(https?:\/.+)$/i);
      if (match) {
        targetUrl = match[1].replace(/^(https?:\/)(?=[^/])/, '$1/');
      }
    }

    if (!targetUrl || !/^https?:\/\//i.test(targetUrl.trim())) {
      return new Response(
        'Cloudflare Worker IPTV Proxy is running!\n\nUsage: /?url=http://example.com/live/channel.m3u8\n',
        {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    targetUrl = targetUrl.trim();

    // 4. Extract custom IPTV authentication parameters
    const customUa =
      url.searchParams.get('ua') ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
    const customRef = url.searchParams.get('ref');
    const customMac = url.searchParams.get('mac');
    const customCookie = url.searchParams.get('cookie');
    const customAuth = url.searchParams.get('auth');

    const headers = new Headers();
    headers.set('User-Agent', customUa);
    headers.set('Accept', '*/*');
    if (customRef) {
      headers.set('Referer', customRef);
    }

    // Assemble cookies for Stalker / Ministra portals
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
      headers.set('Cookie', cookieParts.join('; '));
    }

    // Forward Range header for video seeking
    const range = request.headers.get('Range');
    if (range) {
      headers.set('Range', range);
    }

    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        redirect: 'follow',
      });

      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');
      responseHeaders.set('Access-Control-Expose-Headers', '*');

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const isM3u8 =
        targetUrl.includes('.m3u8') ||
        contentType.includes('application/vnd.apple.mpegurl') ||
        contentType.includes('application/x-mpegurl');

      // 5. Rewrite M3U8 playlists so all relative chunks route through this worker
      if (isM3u8 && response.ok) {
        const text = await response.text();
        const workerOrigin = url.origin;
        const authSuffix = [];
        if (customUa) authSuffix.push(`ua=${encodeURIComponent(customUa)}`);
        if (customRef) authSuffix.push(`ref=${encodeURIComponent(customRef)}`);
        if (customMac) authSuffix.push(`mac=${encodeURIComponent(customMac)}`);
        const qsExtra = authSuffix.length > 0 ? `&${authSuffix.join('&')}` : '';

        const rewritten = text
          .split('\n')
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;

            // Rewrite encryption key URI
            if (trimmed.startsWith('#EXT-X-KEY:')) {
              return trimmed.replace(/URI=["']([^"']+)["']/i, (_m, keyUri) => {
                try {
                  const abs = new URL(keyUri, targetUrl).href;
                  return `URI="${workerOrigin}/?url=${encodeURIComponent(abs)}${qsExtra}"`;
                } catch {
                  return `URI="${keyUri}"`;
                }
              });
            }

            // Keep comments / tags
            if (trimmed.startsWith('#')) return line;

            // Rewrite relative or absolute segment URI
            try {
              const abs = new URL(trimmed, targetUrl).href;
              return `${workerOrigin}/?url=${encodeURIComponent(abs)}${qsExtra}`;
            } catch {
              return line;
            }
          })
          .join('\n');

        responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
        return new Response(rewritten, {
          status: response.status,
          headers: responseHeaders,
        });
      }

      // Stream media binary directly
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(`Proxy Error: ${err?.message || err}`, {
        status: 502,
        headers: {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
