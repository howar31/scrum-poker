#!/usr/bin/env node
/**
 * Rasterize `public/icon.svg` into the PNGs required for Add-to-Home-Screen
 * on iOS Safari and installable-PWA on Android Chrome.
 *
 * iOS Safari ignores SVG favicons for the home-screen shortcut and falls
 * back to a page screenshot if no `apple-touch-icon` is present — so we
 * must ship a PNG.
 *
 * Targets:
 *   180×180  — apple-touch-icon (iOS Safari)
 *   192×192  — PWA manifest minimum for Android Chrome install
 *   512×512  — PWA manifest (splash screen + maskable)
 *
 * Run: `npm run icons`
 * Output is committed to the repo so production builds don't need Puppeteer.
 */
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '../public');
const ICON_SVG = readFileSync(join(PUBLIC_DIR, 'icon.svg'), 'utf-8');

const SIZES = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
];

const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();

for (const { file, size } of SIZES) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  const html = `<!DOCTYPE html>
    <html>
      <head><meta charset="UTF-8"><style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: ${size}px; height: ${size}px; }
        svg { display: block; width: 100%; height: 100%; }
      </style></head>
      <body>${ICON_SVG}</body>
    </html>`;
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({
    path: join(PUBLIC_DIR, file),
    type: 'png',
    clip: { x: 0, y: 0, width: size, height: size },
    omitBackground: false,
  });
  console.log(`✓ ${file} (${size}×${size})`);
}

await browser.close();
