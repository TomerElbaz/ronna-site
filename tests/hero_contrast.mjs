// Hero photo contrast check for tests/browser_check.mjs. No dependencies.
// For every visible text element in the photo hero, hides the text, takes a
// screenshot, and measures WCAG contrast between the text colour and the
// *brightest* pixel behind it (the worst case, not an average). Fails below
// 4.5:1, or 3:1 for large text (24 px, or 18.66 px bold).
import zlib from 'node:zlib';

// Minimal PNG decoder: 8-bit RGB or RGBA, not interlaced (what Chromium writes).
export function decodePng(buf) {
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG');
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error('unsupported PNG colour type ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  return { width, height, bpp, px };
}

const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
export const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

// Every paragraph and headline line in the hero, the gold MOM, any [COPY] tag, and the credit.
const TEXT = '.hero--photo p, .hero--photo p > span, .hero--photo .mom, .hero--photo h1 > span, .hero--photo .copy-tag';

// Returns a list of failures ("" when all pass) and the worst ratio against the requirement.
export async function heroContrast(page, label) {
  const boxes = await page.evaluate((sel) => [...document.querySelectorAll(sel)]
    .filter((e) => e.offsetParent !== null && e.getClientRects().length)
    .map((e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return { name: (e.className || e.tagName).toString().slice(0, 20), x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height, color: s.color, size: parseFloat(s.fontSize), weight: Number(s.fontWeight) };
    }), TEXT);
  await page.evaluate(() => {
    for (const e of document.querySelectorAll('.hero--photo *')) {
      e.dataset.heroWas = e.getAttribute('style') || '';
      e.style.setProperty('color', 'transparent', 'important');
      e.style.setProperty('border-color', 'transparent', 'important');
      if (e.matches('.btn')) e.style.setProperty('visibility', 'hidden', 'important');
    }
  });
  const shot = decodePng(await page.screenshot({ fullPage: true }));
  await page.evaluate(() => {
    for (const e of document.querySelectorAll('.hero--photo *')) {
      if (e.dataset.heroWas) e.setAttribute('style', e.dataset.heroWas); else e.removeAttribute('style');
      delete e.dataset.heroWas;
    }
  });
  const failures = [];
  let worst = Infinity;
  for (const b of boxes) {
    const fg = luminance(b.color.match(/\d+/g).slice(0, 3).map(Number));
    let brightest = 0;
    const x0 = Math.max(0, Math.floor(b.x)), x1 = Math.min(shot.width, Math.ceil(b.x + b.w));
    const y0 = Math.max(0, Math.floor(b.y)), y1 = Math.min(shot.height, Math.ceil(b.y + b.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * shot.width + x) * shot.bpp;
        const l = luminance([shot.px[i], shot.px[i + 1], shot.px[i + 2]]);
        if (l > brightest) brightest = l;
      }
    }
    const need = b.size >= 24 || (b.size >= 18.66 && b.weight >= 700) ? 3 : 4.5;
    const c = contrast(fg, brightest);
    worst = Math.min(worst, c / need);
    if (c < need) failures.push(`${label}: hero text "${b.name}" is ${c.toFixed(2)}:1 against the brightest pixel behind it, needs ${need}:1`);
  }
  if (!boxes.length) failures.push(`${label}: no hero text found to check`);
  return { failures, worst };
}
