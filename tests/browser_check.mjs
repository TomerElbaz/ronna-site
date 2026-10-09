// Browser self-test for ronna.mom. Starts tests/dev_server.mjs (which applies
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
//     the page loads, fonts included, as served (before any compression),
//     apart from the hero photo, which has its own 300 KB limit,
//   - a hero photo is over 300 KB, the wrong one loads (a first visit loads
//     only Home; Business loads after the switch; 1000 px files on phones), or
//     any hero text falls below WCAG AA against the brightest pixel behind it
//     (tests/hero_contrast.mjs), at 320, 390, 820, 1024, 1025, 1280 and 1920 px,
//   - axe-core finds any serious or critical accessibility issue on any page,
//     in every state (Home, Business, the email error, the confirm step),
//   - Tab does not walk the form in order (email, button, Privacy) with a
//     visible focus ring, or focus does not land where it should after an
//     error or a submit,
//   - the Content-Security-Policy in public/_headers blocks anything any page
//     tries to load or run (a securitypolicyviolation event, in any state).
//
// axe-core (test-only, pinned in package.json; never in public/) is injected
// in a separate browser context that bypasses the CSP, so the policy itself
// is still tested everywhere else.
//
// Needs Node, Playwright with a Chromium, and `npm ci` for axe-core. Run from
// the repo root:
//   node tests/browser_check.mjs [screenshot-dir]
// If Playwright is not resolvable from here, point PLAYWRIGHT_MODULE at it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.argv[2];
const PAGES = ['/', '/what/', '/how/', '/privacy/', '/terms/', '/confirm/', '/invite/', '/off/', '/family/', '/no-such-page'];
const BUDGET = 150 * 1024;
// Hero photos (CPO order, 9 Oct; Tomer approved 300 KB): outside the page
// budget, each held to its own 300 KB, and only one loads on a first visit.
const PHOTO_BUDGET = 300 * 1024;
const isHeroPhoto = (url) => /\/assets\/hero\/[a-z]+-\d+\.webp$/.test(url);
const AXE = readFileSync(process.env.AXE_PATH || createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_FAIL = new Set(['serious', 'critical']);
const WIDTHS = [[320, 640, 'w320'], [390, 844, 'w390'], [1280, 900, 'desktop']];

// The site and the waitlist Worker, in this process (tests/dev_server.mjs).
const { startServer } = await import('./dev_server.mjs');
const harness = await import('./worker/harness.mjs');
const site = await startServer({ port: 0, emulateAccess: false, minReplyMs: 30, trustTestIp: true });
const BASE = `http://127.0.0.1:${site.port}`;
let ipSeq = 0;
const freshIp = () => `10.99.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const newContext = (opts = {}) => browser.newContext({ ...opts, extraHTTPHeaders: { 'X-Test-Client-IP': freshIp(), ...(opts.extraHTTPHeaders || {}) } });
let browser;
const problems = [];
const weights = [];
let heroNote = '';
const axeNotes = [];
const axeRuns = [];
const fail = (msg) => problems.push(msg);

// Wait until fn(arg), run in the page through page.evaluate, is true. Used
// instead of page.waitForFunction: some Playwright versions compile that
// predicate inside the page with eval, which our CSP (no 'unsafe-eval')
// blocks, so the wait never resolves and the CSP recorder logs "eval".
// page.evaluate runs outside the page's script context, under any CSP.
async function until(page, fn, arg, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg).catch(() => false)) return;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
if (/\.waitForFunction\(/.test(readFileSync(fileURLToPath(import.meta.url), 'utf8'))) {
  fail('browser_check.mjs uses page.waitForFunction; use until() so the wait works under the CSP');
}
const visible = (page, sel) => page.locator(sel).first().isVisible();

try {

  for (const f of ['/favicon.svg', '/favicon.ico', '/icon-32.png', '/icon-180.png', '/icon-512.png', '/apple-touch-icon.png']) {
    const r = await fetch(BASE + f);
    if (r.status !== 200) fail(`${f} returned ${r.status}`);
    if (r.headers.get('x-robots-tag') !== 'noindex') fail(`${f} lacks X-Robots-Tag noindex`);
  }
  for (const old of ['/waitlist', '/waitlist/']) {
    const r = await fetch(BASE + old, { redirect: 'manual' });
    if (r.status !== 301 || r.headers.get('location') !== '/') fail(`${old} should 301 to /, got ${r.status} ${r.headers.get('location')}`);
  }

  browser = await chromium.launch();

  // Page-weight budget: a fresh context per page, so nothing is cached.
  for (const p of PAGES) {
    const ctx = await newContext();
    const page = await ctx.newPage();
    const bodies = [];
    const photos = [];
    page.on('response', (r) => {
      const size = r.body().then((b) => b.length, () => 0);
      if (isHeroPhoto(r.url())) photos.push(size.then((n) => [r.url().split('/').pop(), n]));
      else bodies.push(size);
    });
    await page.goto(BASE + p, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(100);
    const bytes = (await Promise.all(bodies)).reduce((a, n) => a + n, 0);
    const loadedPhotos = await Promise.all(photos);
    weights.push(`${p} ${(bytes / 1024).toFixed(1)} KB` + loadedPhotos.map(([n, b]) => ` + ${n} ${(b / 1024).toFixed(1)} KB`).join(''));
    if (bytes > BUDGET) fail(`${p}: weighs ${(bytes / 1024).toFixed(1)} KB without the hero photo, over the ${BUDGET / 1024} KB budget`);
    for (const [n, b] of loadedPhotos) if (b > PHOTO_BUDGET) fail(`${p}: hero photo ${n} is ${(b / 1024).toFixed(1)} KB, over ${PHOTO_BUDGET / 1024} KB`);
    if (p === '/' && loadedPhotos.map(([n]) => n).join() !== 'home-2000.webp') fail(`/: a first visit should load only the Home photo, loaded ${loadedPhotos.map(([n]) => n).join(', ') || 'none'}`);
    if (p !== '/' && loadedPhotos.length) fail(`${p}: loads a hero photo it doesn't show`);
    await ctx.close();
  }

  // Hero photos: every file self-hosted and ≤300 KB; the right one per view and
  // width; and every hero text element readable against the brightest pixel behind it.
  {
    const { readdirSync, statSync } = await import('node:fs');
    const dir = path.join(here, '..', 'public', 'assets', 'hero');
    const files = readdirSync(dir);
    const want = ['business-1000.webp', 'business-2000.webp', 'home-1000.webp', 'home-2000.webp'];
    if (files.sort().join() !== want.join()) fail(`hero photos on disk: ${files.join(', ')}`);
    for (const f of files) if (statSync(path.join(dir, f)).size > PHOTO_BUDGET) fail(`hero photo ${f} is over ${PHOTO_BUDGET / 1024} KB on disk`);
    const { heroContrast } = await import('./hero_contrast.mjs');
    let worst = Infinity;
    for (const [width, height] of [[320, 640], [390, 844], [820, 1000], [1024, 768], [1025, 768], [1280, 900], [1920, 1080]]) {
      for (const aud of ['home', 'business']) {
        const ctx = await newContext({ viewport: { width, height } });
        const page = await ctx.newPage();
        const loaded = [];
        page.on('response', (r) => { if (isHeroPhoto(r.url())) loaded.push(r.url().split('/').pop()); });
        await page.goto(BASE + '/', { waitUntil: 'networkidle' });
        const size = width <= 760 ? 1000 : 2000;
        if (aud === 'business') {
          // The photo downloads when the page repaints after the switch: wait for it.
          const got = page.waitForResponse((r) => r.url().endsWith(`/assets/hero/business-${size}.webp`), { timeout: 5000 }).catch(() => null);
          await page.click('label[for=aud-business]');
          await got;
        }
        await page.evaluate(() => document.fonts.ready);
        const expect = aud === 'home' ? [`home-${size}.webp`] : [`home-${size}.webp`, `business-${size}.webp`];
        if (loaded.join() !== expect.join()) fail(`hero ${width}px ${aud}: loaded ${loaded.join(', ') || 'nothing'}, want ${expect.join(', ')}`);
        const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.hero--photo'), '::before').backgroundImage);
        if (!bg.includes(`/assets/hero/${aud}-${size}.webp`)) fail(`hero ${width}px ${aud}: shows ${bg}`);
        const r = await heroContrast(page, `hero ${width}px ${aud}`);
        r.failures.forEach(fail);
        worst = Math.min(worst, r.worst);
        if (shots) await page.screenshot({ path: path.join(shots, `hero_${width}_${aud}.png`) });
        await ctx.close();
      }
    }
    heroNote = `hero photos: worst text contrast is ${worst.toFixed(2)}× the WCAG AA minimum`;
  }

  // Accessibility (issue #14): axe-core on every page and every state.
  {
    const ctx = await newContext({ bypassCSP: true, viewport: { width: 1280, height: 900 } });
    const axeRun = async (page, label) => {
      if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: AXE });
      const r = await page.evaluate(() => window.axe.run(document));
      for (const v of r.violations) {
        const where = v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ');
        if (AXE_FAIL.has(v.impact)) fail(`axe ${label}: [${v.impact}] ${v.id}: ${v.help} at ${where}`);
        else axeNotes.push(`${label}: [${v.impact}] ${v.id} at ${where}`);
      }
      for (const v of r.incomplete) if (AXE_FAIL.has(v.impact)) axeNotes.push(`${label}: needs review [${v.impact}] ${v.id}`);
      axeRuns.push(r.passes.length);
    };
    for (const p of PAGES) {
      const page = await ctx.newPage();
      await page.goto(BASE + p, { waitUntil: 'networkidle' });
      await axeRun(page, p);
      if (await page.locator('label[for=aud-business]').count()) {
        await page.click('label[for=aud-business]');
        await axeRun(page, `${p} (Business)`);
        await page.click('label[for=aud-home]');
      }
      if (await page.locator('form[data-waitlist]').count()) {
        await page.click('form[data-waitlist] button[type=submit]');
        await axeRun(page, `${p} (email error)`);
        await page.fill('#waitlist-email', 'test@example.com');
        await page.click('form[data-waitlist] button[type=submit]');
        await page.click('[data-resend]');
        await axeRun(page, `${p} (confirm step)`);
      }
      await page.close();
    }
    await ctx.close();
  }

  // Keyboard order and visible focus on the form (issue #14).
  {
    const ctx = await newContext({ viewport: { width: 1280, height: 900 } });
    const here = (page) => page.evaluate(() => {
      const el = document.activeElement;
      const s = getComputedStyle(el);
      const name = el.id === 'waitlist-email' ? 'email'
        : el.matches('form[data-waitlist] button[type=submit]') ? 'submit'
        : el.matches('.fine a') ? 'privacy'
        : el.matches('[data-step=confirm]') ? 'confirm-step'
        : el.matches('[data-resend]') ? 'resend'
        : `${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 20)}`;
      return { name, ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 };
    });
    for (const p of ['/', '/what/']) {
      const page = await ctx.newPage();
      await page.goto(BASE + p, { waitUntil: 'networkidle' });
      // Reach the form from the hero by keyboard alone.
      await page.focus('.hero .btn--ghost');
      await page.keyboard.press('Tab');
      let at = await here(page);
      if (at.name !== 'email') fail(`keyboard ${p}: Tab after the hero goes to ${at.name}, not the email field`);
      const forward = ['submit', 'privacy'];
      for (const want of forward) {
        if (!at.ring) fail(`keyboard ${p}: no visible focus ring on ${at.name}`);
        await page.keyboard.press('Tab');
        at = await here(page);
        if (at.name !== want) fail(`keyboard ${p}: Tab order in the form reaches ${at.name}, want ${want}`);
      }
      for (const want of ['submit', 'email']) {
        await page.keyboard.press('Shift+Tab');
        at = await here(page);
        if (at.name !== want) fail(`keyboard ${p}: Shift+Tab reaches ${at.name}, want ${want}`);
      }
      // Submit empty with Enter: focus stays on the email field, marked invalid, error tied to it.
      await page.keyboard.press('Enter');
      at = await here(page);
      const invalid = await page.getAttribute('#waitlist-email', 'aria-invalid');
      if (at.name !== 'email' || invalid !== 'true') fail(`keyboard ${p}: after an empty submit focus is on ${at.name}, aria-invalid=${invalid}`);
      if (!(await page.isVisible('#waitlist-error'))) fail(`keyboard ${p}: error not shown after an empty submit`);
      // Type and submit with Enter: focus moves to the confirm step, then Tab reaches "Send the link again".
      await page.keyboard.type('test@example.com');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-step=confirm]:not([hidden])', { timeout: 5000 }).catch(() => {});
      at = await here(page);
      if (at.name !== 'confirm-step') fail(`keyboard ${p}: after submit focus is on ${at.name}, not the confirm step`);
      await page.keyboard.press('Tab');
      at = await here(page);
      if (at.name !== 'resend' || !at.ring) fail(`keyboard ${p}: Tab from the confirm step reaches ${at.name} (ring ${at.ring}), want "Send the link again" with a ring`);
      await page.close();
    }
    await ctx.close();
  }
  // ---------- End to end, against the real Worker (rules 69, 72, 74) ----------
  {
    const t0 = { t: Date.now() };
    const urls = [];          // every request URL the browser makes in these flows
    const secrets = [];       // codes, tokens and emails that must never appear in a URL (rule 72.3)
    const watch = (page) => page.on('request', (r) => urls.push(r.url()));
    const lastMailTo = (email) => [...site.mail].reverse().find((m) => m.to === email);
    const axeOn = async (page, label) => {
      const r = await page.evaluate(() => window.axe.run(document));
      for (const v of r.violations) if (AXE_FAIL.has(v.impact)) fail(`axe ${label}: [${v.impact}] ${v.id} at ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
      axeRuns.push(r.passes.length);
    };
    const cspWatch = async (page) => page.addInitScript(() => {
      window.__cspBlocked = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__cspBlocked.push(`${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile || '?'}:${e.lineNumber || 0}${e.sample ? ' [' + e.sample.slice(0, 40) + ']' : ''}`));
    });
    const cspCheck = async (page, label) => {
      for (const b of await page.evaluate(() => window.__cspBlocked || [])) fail(`e2e ${label}: CSP ${b}`);
    };
    const open = async (ctx) => {
      const page = await ctx.newPage();
      watch(page);
      await cspWatch(page);
      await page.addInitScript({ content: AXE }); // init scripts run under any CSP; the page's own policy stays on
      page.on('pageerror', (e) => fail(`e2e: script error ${e}`));
      return page;
    };

    // 1. Signup, confirm with a click, place shown; then one-click delete.
    {
      const ctx = await newContext({ viewport: { width: 390, height: 844 } });
      const page = await open(ctx);
      const email = 'e2e-person@example.com';
      secrets.push(email);
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      await page.fill('#waitlist-email', email);
      await page.click('form[data-waitlist] button[type=submit]');
      await page.waitForSelector('[data-step=confirm]:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e signup: no confirm step'));
      const mail = lastMailTo(email);
      if (!mail) fail('e2e signup: no confirm email captured');
      const token = harness.tokenFrom(mail, 'confirm');
      const del = harness.tokenFrom(mail, 'delete');
      secrets.push(token, del);
      await page.goto(`${BASE}/confirm/#t=${token}`, { waitUntil: 'networkidle' });
      if (page.url().includes('#')) fail('e2e confirm: token left in the address bar');
      if (!(await visible(page, '[data-step=ready]'))) fail('e2e confirm: no Confirm button');
      await page.click('[data-confirm-button]');
      await page.waitForSelector('[data-step=done]:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e confirm: not confirmed'));
      if ((await page.locator('h1').textContent()).trim() !== "You're on the list") fail('e2e confirm: heading is not "You\'re on the list"');
      if (!/^#\d+$/.test((await page.locator('[data-place]').textContent()).trim())) fail('e2e confirm: no place number');
      await axeOn(page, '/confirm/ (done)');
      await cspCheck(page, '/confirm/');
      if (shots) await page.screenshot({ path: path.join(shots, 'e2e_confirm_done.png'), fullPage: true });
      await page.goto(`${BASE}/off/#d=${del}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-step=deleted]:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e delete: not deleted'));
      if (page.url().includes('#')) fail('e2e delete: token left in the address bar');
      if (site.env.DB.rows('SELECT * FROM signups WHERE email = ?', email).length) fail('e2e delete: row still there');
      await axeOn(page, '/off/ (deleted)');
      await cspCheck(page, '/off/');
      // /off/ without a token: the request form, same answer for any address
      await page.goto(`${BASE}/off/`, { waitUntil: 'networkidle' });
      await page.fill('#off-email', 'not-on-the-list@example.com');
      await page.click('form[data-off-form] button[type=submit]');
      await page.waitForSelector('[data-step=sent]:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e off: request form gave no answer'));
      await ctx.close();
    }

    // 2. Family page behind Access: enrol, name, mint (shown once), revoke, cap.
    let code = null;
    {
      const ownerSub = 'e2e-owner-sub';
      const operatorJwt = await harness.signJwt(harness.accessClaims('operator', 'tomer-sub', Date.now()));
      const familyId = (await harness.call(site.env, '/api/operator/family/create', {}, { jwt: operatorJwt })).body.familyId;
      const enrolCode = (await harness.call(site.env, '/api/operator/family/enrolment-code', { familyId }, { jwt: operatorJwt })).body.code;
      const ownerJwt = await harness.signJwt(harness.accessClaims('family', ownerSub, Date.now()));
      const ctx = await newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': ownerJwt } });
      const page = await open(ctx);
      await page.goto(BASE + '/family/', { waitUntil: 'networkidle' });
      const notice = await page.locator('[data-access-notice]').innerText();
      if (!/Cloudflare/.test(notice) || !/sign-in email/.test(notice) || !/a day/.test(notice)) fail(`e2e family: rule 74.2 notice missing: ${notice}`);
      await page.waitForSelector('[data-step=enrol]:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e family: no enrol step'));
      await page.fill('#enrol-code', enrolCode.toLowerCase());
      await page.click('form[data-enrol-form] button[type=submit]');
      await page.waitForSelector('[data-step=family]:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e family: enrol failed'));
      await page.click('[data-mint]');
      await page.waitForSelector('[data-mint-note]:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e family: minting without a name was not refused'));
      await page.fill('#family-name', 'Dana Smith');
      await page.click('form[data-name-form] button[type=submit]');
      await page.waitForSelector('#name-error:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e family: a surname was accepted'));
      await page.fill('#family-name', "O'Neil");
      await page.click('form[data-name-form] button[type=submit]');
      await until(page, () => document.querySelector('[data-family-name]').textContent === "O'Neil").catch(() => fail('e2e family: name not saved'));
      await page.click('[data-mint]');
      await page.waitForSelector('[data-new-code]:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e family: no code shown'));
      code = (await page.locator('[data-new-code-text]').textContent()).trim();
      if (!/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/.test(code)) fail(`e2e family: code shape ${code}`);
      secrets.push(code, code.replace(/-/g, ''), code.toLowerCase(), code.replace(/-/g, '').toLowerCase());
      if (!/Unused/.test(await page.locator('[data-codes]').innerText())) fail('e2e family: new code not listed as unused');
      await axeOn(page, '/family/ (code shown)');
      if (shots) await page.screenshot({ path: path.join(shots, 'e2e_family.png'), fullPage: true });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('[data-step=family]:not([hidden])', { timeout: 5000 });
      if ((await page.content()).includes(code) || (await page.content()).includes(code.replace(/-/g, ''))) fail('e2e family: code shown again after reload');
      // revoke one, then fill to five and see the sixth refused
      const spare = (await harness.call(site.env, '/api/family/mint', {}, { jwt: ownerJwt })).body;
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('[data-step=family]:not([hidden])', { timeout: 5000 });
      const before = await page.locator('[data-codes] button').count();
      await page.locator('[data-codes] button').last().click();
      await until(page, (n) => document.querySelectorAll('[data-codes] button').length === n - 1, before).catch(() => fail('e2e family: revoke did not update the list'));
      for (let i = 0; i < 4; i++) await harness.call(site.env, '/api/family/mint', {}, { jwt: ownerJwt });
      await page.click('[data-mint]');
      await until(page, () => /5 live codes/.test(document.querySelector('[data-mint-note]').textContent)).catch(() => fail('e2e family: sixth code not refused'));
      void spare;
      await cspCheck(page, '/family/');
      await ctx.close();
    }

    // 3. Invite: /invite/#code=…, "Invited by" + the name only, join, confirm. No code in any URL.
    {
      const ctx = await newContext({ viewport: { width: 390, height: 844 } });
      const page = await open(ctx);
      const email = 'e2e-invitee@example.com';
      secrets.push(email);
      await page.goto(`${BASE}/invite/#code=${code}`, { waitUntil: 'networkidle' });
      if (page.url().includes('#')) fail('e2e invite: code left in the address bar');
      await page.waitForSelector('[data-step=join]:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e invite: valid code not accepted'));
      const shown = (await page.locator('.invited').innerText()).trim();
      if (shown !== "Invited by O'Neil") fail(`invite-shows-only-first-name: shows "${shown}"`);
      if ((await page.locator('[data-invited-by]').innerHTML()) !== 'O\'Neil') fail('e2e invite: the name was not inserted as text');
      const pageText = await page.locator('main').innerText();
      if (/fam_|code_|@/.test(pageText.replace(/ronna\.mom\/off/g, ''))) fail('e2e invite: page shows more than the first name');
      if (!/doesn't move you up the list/i.test(pageText)) fail('e2e invite: referral line missing');
      await axeOn(page, '/invite/ (join)');
      if (shots) await page.screenshot({ path: path.join(shots, 'e2e_invite_join.png'), fullPage: true });
      await page.fill('#invite-email', email);
      await page.click('form[data-invite-join] button[type=submit]');
      await page.waitForSelector('[data-step=sent]:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e invite: redeem gave no answer'));
      const token = harness.tokenFrom(lastMailTo(email), 'confirm');
      secrets.push(token);
      await page.goto(`${BASE}/confirm/#t=${token}`, { waitUntil: 'networkidle' });
      await page.click('[data-confirm-button]');
      await page.waitForSelector('[data-step=done]:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e invite: confirm failed'));
      const row = site.env.DB.rows('SELECT invited_by_family_id FROM signups WHERE email = ?', email)[0];
      if (!row || !row.invited_by_family_id) fail('e2e invite: invitee not marked invited-by');
      // the same code again, typed this time: one reply for a bad code
      await page.goto(`${BASE}/invite/`, { waitUntil: 'networkidle' });
      await page.fill('#invite-code', code.toLowerCase().replace(/-/g, ' '));
      await page.click('form[data-code-form] button[type=submit]');
      await page.waitForSelector('[data-bad]:not([hidden])', { timeout: 5000 }).catch(() => fail('e2e invite: used code not refused'));
      if ((await page.locator('[data-bad]').innerText()).trim() !== "This invite isn't valid.") fail('e2e invite: bad-code reply wording');
      await axeOn(page, '/invite/ (bad code)');
      await cspCheck(page, '/invite/');
      await ctx.close();
    }

    // invite-code-never-in-url (rule 72.3), and no token or email either.
    for (const u of urls) {
      const lower = decodeURIComponent(u).toLowerCase();
      for (const sec of secrets) if (sec && lower.includes(sec.toLowerCase())) fail(`invite-code-never-in-url: a request URL carried a secret: ${u.slice(0, 60)}…`);
    }
    if (urls.length < 20) fail(`e2e: too few requests recorded (${urls.length}); the URL check would prove nothing`);
  }

  for (const [width, height, tag] of WIDTHS) {
    const ctx = await newContext({ viewport: { width, height } });
    for (const p of PAGES) {
      const page = await ctx.newPage();
      const is404 = p === '/no-such-page';
      page.on('request', (r) => { if (!r.url().startsWith(BASE)) fail(`${tag} ${p}: off-site request ${r.url()}`); });
      page.on('requestfailed', (r) => fail(`${tag} ${p}: request failed ${r.url()}`));
      page.on('pageerror', (e) => fail(`${tag} ${p}: script error ${e}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        if (is404 && /status of 404/.test(m.text())) return;
        if (p === '/family/' && /status of 403/.test(m.text())) return; // signed out: the family page shows its "denied" state
        fail(`${tag} ${p}: console error ${m.text()}`);
      });

      // Record anything the CSP blocks (issue #15), from the first byte on.
      await page.addInitScript(() => {
        window.__cspBlocked = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__cspBlocked.push(`${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile || '?'}:${e.lineNumber || 0}${e.sample ? ' [' + e.sample.slice(0, 40) + ']' : ''}`));
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
      if (['/confirm/', '/invite/', '/off/', '/family/'].includes(p)) {
        if (res.headers()['cache-control'] !== 'no-store') fail(`${tag} ${p}: not no-store`);
        const rp = (res.headers()['referrer-policy'] || '').split(',').map((x) => x.trim());
        if (rp.at(-1) !== 'no-referrer') fail(`${tag} ${p}: Referrer-Policy ends with ${rp.at(-1)}, want no-referrer`);
        if ((await page.getAttribute('meta[name=referrer]', 'content')) !== 'no-referrer') fail(`${tag} ${p}: no no-referrer meta`);
      }
      if (p === '/confirm/' && !(await visible(page, '[data-step=none]'))) fail(`${tag} /confirm/: without a token it should ask to open the email link`);
      if (p === '/family/' && !(await visible(page, '[data-step=denied]'))) fail(`${tag} /family/: signed out, it should show the denied state`);

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

        // Steps, with JS. The only request is a same-origin POST to /api/signup.
        const sent = [];
        page.on('request', (r) => sent.push(`${r.method()} ${r.url()}`));
        const before = page.url();
        await page.click('form[data-waitlist] button[type=submit]');
        if (!(await visible(page, '#waitlist-error'))) fail(`${tag} waitlist: empty email shows no error`);
        if (!(await visible(page, '[data-step=form]'))) fail(`${tag} waitlist: empty email left the form`);
        await page.fill('#waitlist-email', 'test@example.com');
        await page.click('form[data-waitlist] button[type=submit]');
        await page.waitForSelector('[data-step=confirm]:not([hidden])', { timeout: 5000 }).catch(() => {});
        if (!(await visible(page, '[data-step=confirm]')) || (await visible(page, '[data-step=form]'))) fail(`${tag} waitlist: confirm step not shown`);
        if ((await page.locator('[data-step=confirm] h2').textContent()).trim() !== 'Check your email.') fail(`${tag} waitlist: confirm heading wrong`);
        if ((await page.inputValue('#waitlist-email')) !== '') fail(`${tag} waitlist: email kept in the page after submit`);
        if ((await page.evaluate(() => document.activeElement?.dataset?.step)) !== 'confirm') fail(`${tag} waitlist: focus did not move to the confirm step`);
        await page.click('[data-resend]');
        await page.waitForSelector('[data-resent]:not([hidden])', { timeout: 5000 }).catch(() => {});
        if (!(await visible(page, '[data-resent]'))) fail(`${tag} waitlist: "Send the link again" shows nothing`);
        if (shots) await page.screenshot({ path: path.join(shots, `${tag}${p.replace(/\//g, '_')}confirm.png`), fullPage: false });
        const unexpected = sent.filter((x) => x !== `POST ${BASE}/api/signup`);
        if (page.url() !== before || unexpected.length || sent.length !== 2) fail(`${tag} waitlist: requests were ${sent.join(', ') || 'none'} (url ${page.url()})`);
        // Rule 69.8: the two-line notice sits above the button.
        const keep = await page.evaluate(() => {
          const k = document.querySelector('form[data-waitlist] [data-keep]');
          const b = document.querySelector('form[data-waitlist] button[type=submit]');
          return k && b ? { lines: k.innerHTML.split(/<br\s*\/?>/i).filter((x) => x.trim()).length, before: !!(k.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), text: k.textContent } : null;
        });
        if (!keep || keep.lines !== 2 || !keep.before || !/keep only your email/i.test(keep.text) || !/delete/i.test(keep.text)) fail(`${tag} ${p}: notice above the button wrong: ${JSON.stringify(keep)}`);

        // The place on the list is /confirm/ only (CPO, issue #8).
        if (await page.locator('[data-step=place], #on-the-list').count()) fail(`${tag} ${p}: in-page place step should be gone`);

        // Without JS: the switch still works (CSS only) and the form sends nothing.
        const noJs = await newContext({ javaScriptEnabled: false, viewport: { width, height } });
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
      const blocked = await page.evaluate(() => window.__cspBlocked || []);
      for (const b of blocked) fail(`${tag} ${p}: CSP ${b}`);
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await site.close();
}

if (problems.length) {
  console.log('FAIL');
  console.log('  weights: ' + weights.join(', '));
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log(`OK: ${PAGES.length} pages at 320, 390 and 1280 px; switch, steps and redirect work; nothing left the site`);
console.log(`Weights (budget ${BUDGET / 1024} KB): ${weights.join(', ')}`);
console.log(`axe-core: ${axeRuns.length} page states, no serious or critical issues${axeNotes.length ? '; notes: ' + axeNotes.join('; ') : ''}`);
console.log(heroNote);
