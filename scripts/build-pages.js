import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

console.log('[build-pages] Building mobile-pwa production bundle...');
execSync('npm run build -w mobile-pwa', { stdio: 'inherit' });

const src = path.resolve('mobile-pwa/dist');
const dest = path.resolve('dist');

console.log(`[build-pages] Mirroring ${src} to ${dest}...`);
if (fs.existsSync(dest)) {
  fs.rmSync(dest, { recursive: true, force: true });
}
fs.cpSync(src, dest, { recursive: true });
console.log('[build-pages] Successfully prepared dist for Cloudflare Pages!');
