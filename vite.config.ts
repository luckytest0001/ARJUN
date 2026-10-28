import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, Plugin} from 'vite';

const SOURCE_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="theme-color" content="#000000" />
    <meta name="referrer" content="no-referrer" />
    <title>IPTV Player</title>
    <meta name="description" content="Material Design IPTV player supporting M3U and XSPF playlists with live HLS channel streaming, category groups, and favorites." />
    <meta property="og:title" content="IPTV Player" />
    <meta property="og:description" content="Material Design IPTV player supporting M3U and XSPF playlists with live HLS channel streaming, category groups, and favorites." />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <script src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

function githubPagesRootSyncPlugin(): Plugin {
  return {
    name: 'github-pages-root-sync',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        // In Vite dev server (or build), if index.html on disk was replaced with compiled ./assets/* tags,
        // feed Vite the clean /src/main.tsx entry so live TypeScript source is always used.
        if (ctx.server || !html.includes('/src/main.tsx')) {
          return SOURCE_INDEX_HTML;
        }
        return html;
      },
    },
  };
}

export default defineConfig(({command}) => {
  const rootDir = typeof import.meta !== 'undefined' && (import.meta as any).dirname
    ? (import.meta as any).dirname
    : path.resolve('.');

  if (command === 'build') {
    try {
      const rootIndexHtml = path.resolve(rootDir, 'index.html');
      fs.writeFileSync(rootIndexHtml, SOURCE_INDEX_HTML, 'utf8');
    } catch {
      // ignore
    }
  }
  return {
    base: process.env.VITE_BASE_PATH || './',
    plugins: [githubPagesRootSyncPlugin(), react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(rootDir, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
