// Browser self-test for ronnaops.com (ronnaops/, CPO order W-06).
// Serves ronnaops/ with its own _headers (tests/dev_server.mjs, root option) and fails if:
//   - the home page doesn't fit one screen at 1280x800, 1024x768 or 390x844,
//   - any page scrolls sideways at 360 or 1280 px,
//   - axe-core finds any serious or critical issue, with the device dark or light,
//   - Tab doesn't go skip link, wordmark, "MOM for families", Privacy (each with a ring),
//   - any request goes to another host, is not a GET, or fetches a font it doesn't host,
//   - "MOM for families" doesn't point at https://ronna.mom.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const AXE = readFileSync(process.env.AXE_PATH || createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const { startServer } = await import('./dev_server.mjs');
const site = await startServer({ port: 0, root: path.join(here, '..', 'ronnaops') });
const BASE = `http://127.0.0.1:${site.port}`;
const FONTS = new Set(['archivo-latin-wdth-normal.woff2', 'ibm-plex-mono-latin-400-normal.woff2']);
const problems = [];
const fail = (m) => problems.push(m);
const browser = await chromium.launch();
let axeRuns = 0;

try {
  for (const [scheme, width, height] of [['dark', 1280, 800], ['light', 1280, 800], ['dark', 1024, 768], ['dark', 390, 844], ['light', 360, 740]]) {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width, height } });
    for (const p of ['/', '/privacy/', '/no-such-page']) {
      const tag = `${scheme} ${width}px ${p}`;
      const page = await ctx.newPage();
      await page.addInitScript({ content: AXE }); // init scripts run under any CSP; the page's own policy stays on
      page.on('request', (r) => {
        if (!r.url().startsWith(BASE)) fail(`${tag}: request to another host ${r.url()}`);
        if (r.method() !== 'GET') fail(`${tag}: ${r.method()} ${r.url()}`);
        if (r.resourceType() === 'font' && !FONTS.has(r.url().split('/').pop())) fail(`${tag}: font not hosted here ${r.url()}`);
      });
      page.on('pageerror', (e) => fail(`${tag}: script error ${e}`));
      const res = await page.goto(BASE + p, { waitUntil: 'networkidle' });
      if (p === '/no-such-page' && res.status() !== 404) fail(`${tag}: want 404, got ${res.status()}`);
      if (!/script-src 'none'/.test(res.headers()['content-security-policy'] || '')) fail(`${tag}: CSP header missing`);
      if (res.headers()['x-robots-tag'] !== 'noindex') fail(`${tag}: X-Robots-Tag noindex missing`);
      await page.evaluate(() => document.fonts.ready);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ih: innerHeight, bg: getComputedStyle(document.body).backgroundColor }));
      if (m.sw > m.cw) fail(`${tag}: scrolls sideways (${m.sw} > ${m.cw})`);
      if (m.bg !== 'rgb(23, 26, 32)') fail(`${tag}: ground is ${m.bg}, want the near-black whatever the device theme`);
      if (p === '/' && width !== 360 && m.sh > m.ih) fail(`${tag}: home page is taller than one screen (${m.sh} > ${m.ih})`);
      const ax = await page.evaluate(() => (window.axe ? window.axe.run(document) : null));
      if (!ax) fail(`${tag}: axe did not run`);
      else axeRuns++;
      for (const v of ax ? ax.violations : []) if (['serious', 'critical'].includes(v.impact)) fail(`${tag}: axe [${v.impact}] ${v.id} at ${v.nodes[0].target.join(' ')}`);
      if (p === '/' && scheme === 'dark' && width === 1280) {
        if ((await page.getAttribute('a.btn', 'href')) !== 'https://ronna.mom' || (await page.locator('a.btn').innerText()).trim() !== 'MOM for families') fail(`${tag}: "MOM for families" link wrong`);
        const stops = [];
        for (let i = 0; i < 5; i++) {
          await page.keyboard.press('Tab');
          stops.push(await page.evaluate(() => {
            const el = document.activeElement; const s = getComputedStyle(el);
            return { t: (el.textContent || '').trim() || el.className, ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 };
          }));
        }
        const names = stops.slice(0, 4).map((s) => s.t).join(' | ');
        if (names !== 'Skip to content | RonnaOps | MOM for families | Privacy') fail(`${tag}: Tab order is ${names}`);
        for (const s of stops.slice(0, 4)) if (!s.ring) fail(`${tag}: no focus ring on ${s.t}`);
      }
      await page.close();
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await site.close();
}
if (problems.length) {
  console.log('FAIL (ronnaops.com browser)');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
if (axeRuns < 15) { console.log(`FAIL (ronnaops.com browser): axe ran on only ${axeRuns} states`); process.exit(1); }
console.log(`OK: ronnaops.com in the browser: one screen at 1280, 1024 and 390 px; no sideways scroll at 360; axe ${axeRuns} states, no serious or critical issues; Tab order; nothing left the site`);
