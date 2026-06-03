// Populates www/ with every file the WebView needs to serve.
// This is intentionally simple — there is no bundler or transpiler;
// the app is a single index.html with inline JS/CSS.
// Run with: npm run build:web

import { copyFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const www = join(__dirname, 'www');

mkdirSync(www, { recursive: true });

const assets = [
  'index.html',
  'manifest.json',
  'sw.js',
  'logo.png',
  'icon-192.png',
  'icon-192-maskable.png',
  'icon-512.png',
  'icon-512-maskable.png',
];

assets.forEach(file => {
  copyFileSync(join(__dirname, file), join(www, file));
  console.log(`  copied → www/${file}`);
});

console.log(`\nwww/ ready (${assets.length} files). Run: npx cap sync`);
