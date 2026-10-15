// Renders the icon set from public/favicon.svg (mark A, the element tile's
// icon cut: filled #0B0C0E tile, white outline, white R as an outline path).
// Writes into public/:
//   icon-32.png, icon-180.png, icon-512.png   the PNG set
//   apple-touch-icon.png                      same as icon-180, at the path iOS asks for by default
//   favicon.ico                               16, 32 and 48 px for older browsers
// The 180 px icon sits on #0B0C0E with no transparent corners, since iOS
// applies its own mask. The others keep the tile's own corners.
//
// Needs Node and Playwright with a Chromium. Run from the repo root:
//   node tools/render_icons.mjs
// If Playwright is not resolvable from here, point PLAYWRIGHT_MODULE at it.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = readFileSync(path.join(pub, 'favicon.svg'), 'utf8');

const browser = await chromium.launch();
async function render(size, ground) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  await page.setContent(`<html><body style="margin:0;background:${ground || 'transparent'}">${sized}</body></html>`);
  const png = await page.screenshot({ omitBackground: !ground });
  await page.close();
  return png;
}

const out = {};
for (const size of [16, 32, 48, 512]) out[size] = await render(size);
out[180] = await render(180, '#0B0C0E');
await browser.close();

writeFileSync(path.join(pub, 'icon-32.png'), out[32]);
writeFileSync(path.join(pub, 'icon-180.png'), out[180]);
writeFileSync(path.join(pub, 'apple-touch-icon.png'), out[180]);
writeFileSync(path.join(pub, 'icon-512.png'), out[512]);

// ICO with PNG entries: 6-byte header, 16 bytes per entry, then the PNGs.
const sizes = [16, 32, 48];
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s, e);
  header.writeUInt8(s, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(out[s].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += out[s].length;
});
writeFileSync(path.join(pub, 'favicon.ico'), Buffer.concat([header, ...sizes.map((s) => out[s])]));
console.log('wrote icon-32.png, icon-180.png, apple-touch-icon.png, icon-512.png, favicon.ico');
