// Browser self-test for ronna.mom. Starts tests/serve.py (which applies
// public/_headers), then loads every page in Chromium at phone and desktop
// width and fails if:
//   - any request leaves the site, or a same-site request fails,
//   - a page logs an error (other than the 404 page's own status),
//   - noindex is missing from the page or the response header,
//   - the fonts or the header tile do not load,
//   - the page scrolls sideways,
//   - keyboard focus is not visible, or Tab does not start at the skip link,
//   - the waitlist form sends anything, with or without JavaScript.
//
// Needs Node and Playwright with a Chromium. Run from the repo root:
//   node tests/browser_check.mjs [screenshot-dir]
// If Playwright is not resolvable from here, point PLAYWRIGHT_MODULE at it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.argv[2];
const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const PAGES = ['/', '/what/', '/waitlist/', '/invite/', '/no-such-page'];

const server = spawn('python3', [path.join(here, 'serve.py'), String(PORT)], { stdio: 'ignore' });
const problems = [];
const fail = (msg) => problems.push(msg);

try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  for (const f of ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png']) {
    const r = await fetch(BASE + f);
    if (r.status !== 200) fail(`${f} returned ${r.status}`);
    if (r.headers.get('x-robots-tag') !== 'noindex') fail(`${f} lacks X-Robots-Tag noindex`);
  }

  const browser = await chromium.launch();
  for (const [width, height, tag] of [[375, 812, 'phone'], [1280, 900, 'desktop']]) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    for (const p of PAGES) {
      const page = await ctx.newPage();
      const is404 = p === '/no-such-page';
      page.on('request', (r) => { if (!r.url().startsWith(BASE)) fail(`${tag} ${p}: off-site request ${r.url()}`); });
      page.on('requestfailed', (r) => fail(`${tag} ${p}: request failed ${r.url()}`));
      page.on('pageerror', (e) => fail(`${tag} ${p}: script error ${e}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        if (is404 && /status of 404/.test(m.text())) return;
        fail(`${tag} ${p}: console error ${m.text()}`);
      });

      const res = await page.goto(BASE + p, { waitUntil: 'networkidle' });
      if (res.status() !== (is404 ? 404 : 200)) fail(`${tag} ${p}: status ${res.status()}`);
      if (res.headers()['x-robots-tag'] !== 'noindex') fail(`${tag} ${p}: no X-Robots-Tag noindex`);
      if ((await page.getAttribute('meta[name=robots]', 'content')) !== 'noindex') fail(`${tag} ${p}: no meta robots noindex`);

      await page.evaluate(() => document.fonts.ready);
      const families = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
      for (const fam of ['Archivo', 'IBM Plex Mono']) {
        if (!families.some((f) => f.replace(/"/g, '') === fam)) fail(`${tag} ${p}: font ${fam} not loaded`);
      }
      const tileOk = await page.evaluate(() => { const i = document.querySelector('.wordmark img'); return !!i && i.complete && i.naturalWidth > 0; });
      if (!tileOk) fail(`${tag} ${p}: header tile did not load`);
      if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) fail(`${tag} ${p}: scrolls sideways`);

      // Keyboard: first Tab lands on the skip link; every focus stop shows an outline.
      await page.keyboard.press('Tab');
      if ((await page.evaluate(() => document.activeElement?.className)) !== 'skip') fail(`${tag} ${p}: first Tab is not the skip link`);
      for (let n = 0; n < 12; n++) {
        const f = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const s = getComputedStyle(el);
          return { label: el.textContent.trim().slice(0, 30) || el.tagName, outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 };
        });
        if (!f) break;
        if (!f.outline) fail(`${tag} ${p}: focus not visible on "${f.label}"`);
        await page.keyboard.press('Tab');
      }

      if (shots) await page.screenshot({ path: path.join(shots, `${tag}${p.replace(/\//g, '_') || '_'}.png`), fullPage: true });

      if (p === '/waitlist/') {
        await page.goto(BASE + p, { waitUntil: 'networkidle' });
        const sent = [];
        page.on('request', (r) => sent.push(`${r.method()} ${r.url()}`));
        const before = page.url();
        await page.fill('#waitlist-email', 'test@example.com');
        await page.click('button[type=submit]');
        await page.waitForTimeout(400);
        if (page.url() !== before || sent.length) fail(`${tag} waitlist: submit sent ${sent.join(', ') || page.url()}`);
        if (!(await page.isVisible('#waitlist-notice'))) fail(`${tag} waitlist: "nothing was sent" notice not shown`);

        const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height } });
        const p2 = await noJs.newPage();
        await p2.goto(BASE + p, { waitUntil: 'networkidle' });
        const posts = [];
        p2.on('request', (r) => { if (r.method() !== 'GET') posts.push(`${r.method()} ${r.url()}`); });
        await p2.fill('#waitlist-email', 'test@example.com');
        await p2.click('button[type=submit]', { noWaitAfter: true });
        await p2.waitForTimeout(600);
        if (posts.length) fail(`${tag} waitlist without JS: sent ${posts.join(', ')}`);
        await noJs.close();
      }
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();
} finally {
  server.kill();
}

if (problems.length) {
  console.log('FAIL');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log(`OK: ${PAGES.length} pages at phone and desktop width, nothing left the site`);
