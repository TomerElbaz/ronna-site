// Browser self-test for ronna.mom. Starts tests/serve.py (which applies
// public/_headers and public/_redirects), then loads every page in Chromium
// at 320, 390 and 1280 px and fails if:
//   - any request leaves the site, or a same-site request fails,
//   - a page logs an error (other than the 404 page's own status),
//   - noindex is missing from the page or the response header,
//   - the fonts or the header tile do not load,
//   - the page scrolls sideways or text is cut off at the right edge,
//   - keyboard focus is not visible, or Tab does not start at the skip link,
//   - the Home | Business switch does not swap the copy (with or without JS),
//     on the main page and on /what/,
//   - the 404 page loses its large 1e27 and the "Page not found." line,
//   - any icon in the set is missing,
//   - /how/ loses its three steps or its switch, /privacy/ its CISO mark or
//     sections, /confirm/ its heading, place placeholder or no-store, or runs a script,
//   - the human-check slot is not Turnstile-sized (300x65, 150x140 under 332 px),
//   - the waitlist steps misbehave (empty email, confirm, resend), or an
//     in-page place step comes back (the place is /confirm/ only),
//   - the waitlist form sends anything, with or without JavaScript,
//   - /waitlist/ does not redirect to the main page,
//   - any page weighs more than BUDGET (150 KB) on a first visit: every byte
//     the page loads, fonts included, as served (before any compression).
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
const PAGES = ['/', '/what/', '/how/', '/privacy/', '/terms/', '/confirm/', '/invite/', '/off/', '/no-such-page'];
const BUDGET = 150 * 1024;
const WIDTHS = [[320, 640, 'w320'], [390, 844, 'w390'], [1280, 900, 'desktop']];

const server = spawn('python3', [path.join(here, 'serve.py'), String(PORT)], { stdio: 'ignore' });
const problems = [];
const weights = [];
const fail = (msg) => problems.push(msg);
const visible = (page, sel) => page.locator(sel).first().isVisible();

try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  for (const f of ['/favicon.svg', '/favicon.ico', '/icon-32.png', '/icon-180.png', '/icon-512.png', '/apple-touch-icon.png']) {
    const r = await fetch(BASE + f);
    if (r.status !== 200) fail(`${f} returned ${r.status}`);
    if (r.headers.get('x-robots-tag') !== 'noindex') fail(`${f} lacks X-Robots-Tag noindex`);
  }
  for (const old of ['/waitlist', '/waitlist/']) {
    const r = await fetch(BASE + old, { redirect: 'manual' });
    if (r.status !== 301 || r.headers.get('location') !== '/') fail(`${old} should 301 to /, got ${r.status} ${r.headers.get('location')}`);
  }

  const browser = await chromium.launch();

  // Page-weight budget: a fresh context per page, so nothing is cached.
  for (const p of PAGES) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const bodies = [];
    page.on('response', (r) => bodies.push(r.body().then((b) => b.length, () => 0)));
    await page.goto(BASE + p, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(100);
    const bytes = (await Promise.all(bodies)).reduce((a, n) => a + n, 0);
    weights.push(`${p} ${(bytes / 1024).toFixed(1)} KB`);
    if (bytes > BUDGET) fail(`${p}: weighs ${(bytes / 1024).toFixed(1)} KB, over the ${BUDGET / 1024} KB budget`);
    await ctx.close();
  }
  for (const [width, height, tag] of WIDTHS) {
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

      const fit = async (label) => {
        const r = await page.evaluate(() => {
          const cw = document.documentElement.clientWidth;
          const cut = [...document.querySelectorAll('h1,h2,h3,p,a,button,input,label,li,span')]
            .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().right > cw + 0.5 && !e.closest('.sr-only'))
            .map((e) => `${e.tagName}:${e.textContent.trim().slice(0, 24)}`);
          return { sideways: document.documentElement.scrollWidth > cw, cut };
        });
        if (r.sideways) fail(`${tag} ${p}${label}: scrolls sideways`);
        if (r.cut.length) fail(`${tag} ${p}${label}: cut off at right edge: ${r.cut.join(' | ')}`);
      };
      await fit('');

      // Keyboard: first Tab lands on the skip link; every focus stop shows an outline
      // (for the switch, the outline sits on the radio's label).
      await page.keyboard.press('Tab');
      if ((await page.evaluate(() => document.activeElement?.className)) !== 'skip') fail(`${tag} ${p}: first Tab is not the skip link`);
      for (let n = 0; n < 20; n++) {
        const f = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const shown = (x) => { const s = getComputedStyle(x); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0; };
          const target = el.type === 'radio' ? document.querySelector(`label[for="${el.id}"]`) : el;
          return { label: (target.textContent || '').trim().slice(0, 30) || el.tagName, outline: shown(target) };
        });
        if (!f) break;
        if (!f.outline) fail(`${tag} ${p}: focus not visible on "${f.label}"`);
        await page.keyboard.press('Tab');
      }

      if (shots) await page.screenshot({ path: path.join(shots, `${tag}${p.replace(/\//g, '_') || '_'}.png`), fullPage: true });

      if (p === '/how/') {
        const titles = (await page.locator('.how-step h3').allTextContents()).map((t) => t.replace('Step 1: ', '').replace('Step 2: ', '').replace('Step 3: ', '').trim());
        if (titles.join('|') !== 'Tell MOM|MOM files it|You say Go') fail(`${tag} /how/: steps are ${titles.join(' | ')}`);
        if (!(await visible(page, '.how-step [data-aud=home]')) || (await visible(page, '.how-step [data-aud=business]'))) fail(`${tag} /how/: Home copy not the default`);
        await page.click('label[for=aud-business]');
        if (!(await visible(page, '.how-step [data-aud=business]')) || (await visible(page, '.how-step [data-aud=home]'))) fail(`${tag} /how/: switch does not swap the steps`);
        await fit(' (Business)');
      }
      if (p === '/privacy/') {
        if (!(await visible(page, '.review'))) fail(`${tag} /privacy/: CISO review mark missing`);
        const heads = (await page.locator('main h2').allTextContents()).map((t) => t.trim());
        if (heads.join('|') !== 'What we collect|Why|How to leave the list|Never') fail(`${tag} /privacy/: sections are ${heads.join(' | ')}`);
      }
      if (p === '/confirm/') {
        if ((await page.locator('h1').textContent()).trim() !== "You're on the list") fail(`${tag} /confirm/: heading wrong`);
        if (!(await visible(page, '.place-num'))) fail(`${tag} /confirm/: place number placeholder missing`);
        if (await page.locator('script').count()) fail(`${tag} /confirm/: page runs a script`);
        if (res.headers()['cache-control'] !== 'no-store') fail(`${tag} /confirm/: not no-store`);
      }

      if (is404) {
        if ((await page.locator('.egg').textContent()).trim() !== '1e27') fail(`${tag} 404: 1e27 missing`);
        if ((await page.locator('h1').textContent()).trim() !== 'Page not found.') fail(`${tag} 404: line under 1e27 is not "Page not found."`);
        const size = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.egg')).fontSize));
        if (size < 90) fail(`${tag} 404: 1e27 not large (${size}px)`);
      }

      if (p === '/' || p === '/what/') {
        if ((await page.getAttribute('.hero .btn--ghost', 'href')) !== '/how/') fail(`${tag} ${p}: "How it works" does not open /how/`);
        const slot = await page.locator('[data-slot=human-check]').boundingBox();
        const want = width < 332 ? [150, 140] : [300, 65];
        if (!slot || Math.round(slot.width) !== want[0] || Math.round(slot.height) !== want[1]) fail(`${tag} ${p}: human-check slot is ${slot && Math.round(slot.width)}x${slot && Math.round(slot.height)}, want ${want.join('x')}`);
        // Switch: Home copy by default, Business copy after the switch.
        if (!(await visible(page, 'h1 [data-aud=home]')) || (await visible(page, 'h1 [data-aud=business]'))) fail(`${tag} switch: Home copy not the default`);
        await page.click('label[for=aud-business]');
        if (!(await visible(page, 'h1 [data-aud=business]')) || (await visible(page, 'h1 [data-aud=home]'))) fail(`${tag} switch: Business copy did not show`);
        if (p === '/' && (await page.locator('#shelf-title [data-aud=business]').textContent()).trim() !== 'A box in your office') fail(`${tag} switch: Business shelf title wrong`);
        await fit(' (Business)');
        if (shots) await page.screenshot({ path: path.join(shots, `${tag}${p.replace(/\//g, '_')}business.png`), fullPage: true });
        await page.click('label[for=aud-home]');
        if (!(await visible(page, 'h1 [data-aud=home]'))) fail(`${tag} switch: Home copy did not come back`);

        // Steps, with JS. Nothing may leave the page at any point.
        const sent = [];
        page.on('request', (r) => sent.push(`${r.method()} ${r.url()}`));
        const before = page.url();
        await page.click('form[data-waitlist] button[type=submit]');
        if (!(await visible(page, '#waitlist-error'))) fail(`${tag} waitlist: empty email shows no error`);
        if (!(await visible(page, '[data-step=form]'))) fail(`${tag} waitlist: empty email left the form`);
        await page.fill('#waitlist-email', 'test@example.com');
        await page.click('form[data-waitlist] button[type=submit]');
        await page.waitForTimeout(300);
        if (!(await visible(page, '[data-step=confirm]')) || (await visible(page, '[data-step=form]'))) fail(`${tag} waitlist: confirm step not shown`);
        if ((await page.locator('[data-step=confirm] h2').textContent()).trim() !== 'Check your email.') fail(`${tag} waitlist: confirm heading wrong`);
        if ((await page.inputValue('#waitlist-email')) !== '') fail(`${tag} waitlist: email kept in the page after submit`);
        if ((await page.evaluate(() => document.activeElement?.dataset?.step)) !== 'confirm') fail(`${tag} waitlist: focus did not move to the confirm step`);
        await page.click('[data-resend]');
        if (!(await visible(page, '[data-resent]'))) fail(`${tag} waitlist: "Send the link again" shows nothing`);
        if (shots) await page.screenshot({ path: path.join(shots, `${tag}${p.replace(/\//g, '_')}confirm.png`), fullPage: false });
        if (page.url() !== before || sent.length) fail(`${tag} waitlist: something was sent: ${sent.join(', ') || page.url()}`);

        // The place on the list is /confirm/ only (CPO, issue #8).
        if (await page.locator('[data-step=place], #on-the-list').count()) fail(`${tag} ${p}: in-page place step should be gone`);

        // Without JS: the switch still works (CSS only) and the form sends nothing.
        const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height } });
        const p2 = await noJs.newPage();
        await p2.goto(BASE + p, { waitUntil: 'networkidle' });
        await p2.click('label[for=aud-business]');
        if (!(await visible(p2, 'h1 [data-aud=business]'))) fail(`${tag} ${p} no-JS: switch does not swap copy`);
        const posts = [];
        p2.on('request', (r) => { if (r.method() !== 'GET') posts.push(`${r.method()} ${r.url()}`); });
        await p2.fill('#waitlist-email', 'test@example.com');
        await p2.click('form[data-waitlist] button[type=submit]', { noWaitAfter: true });
        await p2.waitForTimeout(600);
        if (posts.length) fail(`${tag} ${p} no-JS waitlist: sent ${posts.join(', ')}`);
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
  console.log('  weights: ' + weights.join(', '));
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log(`OK: ${PAGES.length} pages at 320, 390 and 1280 px; switch, steps and redirect work; nothing left the site`);
console.log(`Weights (budget ${BUDGET / 1024} KB): ${weights.join(', ')}`);
