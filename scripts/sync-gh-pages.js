import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const distAssetsDir = path.join(distDir, 'assets');
const rootAssetsDir = path.join(rootDir, 'assets');
const distIndexHtml = path.join(distDir, 'index.html');
const rootIndexHtml = path.join(rootDir, 'index.html');
const dist404Html = path.join(distDir, '404.html');
const root404Html = path.join(rootDir, '404.html');

console.log('🔄 Syncing GitHub Pages deployment files...');

// 1. Sync assets folder
if (fs.existsSync(distAssetsDir)) {
  fs.mkdirSync(rootAssetsDir, { recursive: true });
  // Clean old root assets
  for (const oldFile of fs.readdirSync(rootAssetsDir)) {
    try {
      fs.rmSync(path.join(rootAssetsDir, oldFile), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  // Copy new assets
  fs.cpSync(distAssetsDir, rootAssetsDir, { recursive: true });
  console.log('✅ Synced dist/assets -> root assets/');
}

// 2. Sync index.html and 404.html with relative asset paths for universal GitHub Pages hosting
if (fs.existsSync(distIndexHtml)) {
  let html = fs.readFileSync(distIndexHtml, 'utf8');
  // Ensure all asset paths are relative (./assets/...) so they load properly under any repository subpath
  html = html.replace(/(?:src|href)=["'](?:\/[^"'/]+)?\/assets\//g, (match) => {
    return match.startsWith('src') ? 'src="./assets/' : 'href="./assets/';
  });

  fs.writeFileSync(distIndexHtml, html, 'utf8');
  fs.writeFileSync(rootIndexHtml, html, 'utf8');
  fs.writeFileSync(dist404Html, html, 'utf8');
  fs.writeFileSync(root404Html, html, 'utf8');
  console.log('✅ Synced index.html and generated 404.html with relative ./assets paths in root and dist/');
}

// 3. Ensure .nojekyll in root and dist so GitHub Pages Jekyll does not ignore assets
const nojekyllContent = '# Disable Jekyll processing on GitHub Pages\n';
fs.writeFileSync(path.join(rootDir, '.nojekyll'), nojekyllContent, 'utf8');
fs.writeFileSync(path.join(distDir, '.nojekyll'), nojekyllContent, 'utf8');
console.log('✅ Verified .nojekyll in root and dist/');

// 4. Ensure cloudflare-worker.js, _worker.js, _routes.json, and _headers are synced to dist
const filesToSync = [
  'cloudflare-worker.js',
  '_worker.js',
  '_routes.json',
  '_headers',
];

for (const file of filesToSync) {
  const src = path.join(rootDir, file);
  const dest = path.join(distDir, file);
  if (fs.existsSync(src) && fs.existsSync(distDir)) {
    fs.copyFileSync(src, dest);
    console.log(`✅ Synced ${file} to dist/`);
  }
}

// 5. Ensure functions directory is synced to dist/functions (for Cloudflare Pages Functions)
const functionsDir = path.join(rootDir, 'functions');
const distFunctionsDir = path.join(distDir, 'functions');
if (fs.existsSync(functionsDir) && fs.existsSync(distDir)) {
  fs.cpSync(functionsDir, distFunctionsDir, { recursive: true });
  console.log('✅ Synced functions/ to dist/functions/');
}

// 6. Ensure sw.js is present in both root and dist
const publicSw = path.join(rootDir, 'public', 'sw.js');
const rootSw = path.join(rootDir, 'sw.js');
const distSw = path.join(distDir, 'sw.js');
if (fs.existsSync(publicSw)) {
  fs.copyFileSync(publicSw, rootSw);
  fs.copyFileSync(publicSw, distSw);
  console.log('✅ Synced sw.js to root and dist/');
}

console.log('🎉 GitHub Pages & Cloudflare Pages deployment files successfully prepared!');

