# ronna-site
Public site for MOM by Ronna

Static site for Cloudflare Pages: plain HTML, CSS and one small script. No
framework and no build step. Only `public/` is published; this README,
`docs/`, `tests/`, `tools/` and `worker/` stay in the repo and never reach
ronna.mom through Pages. See [How to deploy](#how-to-deploy).

The waitlist itself (signup, confirm, delete, invitations) is a separate
Cloudflare Worker in `worker/`, built to CISO rules 69, 72 and 74 and **not
deployed**. See [Waitlist Worker](#waitlist-worker).

## Pages

| Path       | File                       | State                                                        |
|------------|----------------------------|--------------------------------------------------------------|
| `/`        | `public/index.html`        | The waitlist is the main page (UX design, 12:58 CT 8 Oct). Form posts to `/api/signup` (Worker not deployed). |
| `/what/`   | `public/what/index.html`   | "What MOM is" in the main page's blocks, Home and Business. `[COPY]`. |
| `/how/`    | `public/how/index.html`    | How it works: three steps (Tell MOM, MOM files it, You say Go), Home and Business. `[COPY]`. |
| `/privacy/`| `public/privacy/index.html`| Privacy skeleton, **for CISO review**: what we collect (email only), why, how to leave, never. `[COPY]`. |
| `/terms/`  | `public/terms/index.html`  | Terms skeleton, **for counsel review**: who we are, the waitlist, leaving, changes, governing law, contact. `[COPY]`. |
| `/confirm/`| `public/confirm/index.html`| Confirm-email landing: reads `#t=`, a **Confirm** click spends it, then "You're on the list" and the place. `no-store`, no referrer. |
| `/invite/` | `public/invite/index.html` | Invitations: `#code=` or typed; "Invited by" and the chosen first name only; join, then confirm. `no-store`, no referrer. |
| `/off/`    | `public/off/index.html`    | "Take me off the list": `#d=` deletes in one click; otherwise a form that emails a link. `no-store`, no referrer. |
| `/family/` | `public/family/index.html` | Family owners, behind Cloudflare Access: link the family, choose the first name, make up to 5 codes (each shown once), revoke. |
| 404        | `public/404.html`          | `1e27`, large, over "Page not found." Served for unknown paths. |

`/waitlist` and `/waitlist/` redirect to `/` (`public/_redirects`).

The main page, top to bottom: a Home | Business switch in the header, a
full-width hero (white "Put us on the list", outlined "How it works"), three
facts, a box shelf of four cards with labelled placeholder images, the form
(email, a human-check slot, white button), a "never" list with white dashes,
a keeper line, and a footer with the 10<sup>27</sup> line and links to
What MOM is, How it works, Privacy and "Take me off the list". The hero's
"How it works" button opens `/how/`. The switch is CSS only (radio plus `:has`): blocks marked
`data-aud="home"` or `data-aud="business"` show for the checked side, so it
works without JavaScript. After submit, the page shows the confirm step
("Check your email." and "Send the link again"). The place on the list is
its own page, `/confirm/`, which the confirm email's link opens; there is no
in-page place step. Above the button, a two-line notice says what is kept and
how to delete it (rule 69.8).

Every page except the 404 and `/family/` carries Open Graph and Twitter share tags with
`[COPY]` titles and descriptions and the tile (`icon-512.png`) as the image.
Pages stay `noindex`.

Response headers are a **DRAFT FOR CISO** (issue #15): a
Content-Security-Policy with no outside host at all (fonts are self-hosted)
and nothing inline, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, and a Permissions-Policy denying camera,
microphone and location; `connect-src 'self'` lets the pages post to this
site's own `/api/`. `/confirm/`, `/invite/`, `/off/` and `/family/` send no
referrer at all (header and meta) and are `no-store`.

Shared look lives in `public/assets/site.css` (the Brand desk palette, Archivo
and IBM Plex Mono). The fonts are self-hosted in `public/assets/fonts/` under
the SIL Open Font License, so the site makes no third-party requests.
Archivo is trimmed to the weights (400-700) and widths (100-125%) the site
uses, to stay inside the page-weight budget; see `tools/trim_font.py`. Response
headers, including a strict Content-Security-Policy, are in `public/_headers`.

## Design documents

- `docs/SIGNUP_DESIGN.md`: how the waitlist stores, confirms and deletes
  addresses, and how invitations work, **for the CISO**. Cleared with
  changes (rules 69, 72, 74) and built in `worker/`; not deployed.

## Rules

- `main` publishes ronna.mom. Work lands on a branch; it reaches `main` only
  on the CPO's word. Pages previews are off, so a branch is checked with the
  self-test, not a preview URL.
- No secret, key or token ever goes in this repo.
- Outside links: none today. `ALLOWED_OUTSIDE_HOSTS` in
  `tests/check_links.py` stays empty until the CPO approves hosts by name.
- No form destination, analytics or third-party script without a CISO
  ruling posted in the CPO chat. The forms post only to this site's own
  `/api/` (the waitlist Worker, rules 69, 72, 74), from
  `public/assets/site.js`; their action stays empty and the CSP keeps
  `form-action 'none'`, so nothing is sent without JavaScript. The human-check slot is sized for
  Cloudflare Turnstile (300 x 65, or 150 x 140 under 332 px) and stays an
  empty box: no script, no key, no request until the CISO rules, and the CSP
  would block the widget until that ruling opens it.
- Nothing here points at the MOM product's backend or any of its hosts. The
  waitlist Worker is this site's own; it has no binding to any MOM product
  resource and never calls one (rule 69.1, tested).
- No real family data, no names, no product screenshots.
- Copy marked `[COPY]` is placeholder until the CBO's text arrives through
  the CPO.
- Company mark: A, the element tile (picked 8 Oct). `public/favicon.svg` is its
  small-size cut (filled `#0B0C0E` tile, white R drawn as an outline, so it
  needs no web font); `favicon.ico` and `apple-touch-icon.png` are rendered
  from it. The header pairs the tile with "RonnaOps" in mixed case.
  Gold (`#B5964D`) is used on the word MOM only. The one action color is
  white; the secondary button is outlined in `#6A707A` with white text.
- Ground is carbon `#171A20` (UX's waitlist design). Cards sit on
  `#1F232A`, a lift derived here for UX to confirm.
- Every page is `noindex` (meta robots on each page and `X-Robots-Tag` in
  `_headers`) until the CPO says the copy is live. Remove both together.
- Accessibility: text meets WCAG AA contrast on carbon (grey 7.5:1, gold
  6.2:1); field edges and outlines use `#6A707A` (3.5:1, meets the 3:1
  boundary rule); every focus stop shows a white outline; Tab starts at a
  skip link.

## Hero photos

The main page's hero carries two photos from Unsplash, under the Unsplash
License (CPO order, 9 Oct; Tomer's word 15:02): **Home**
(unsplash.com/photos/IHxTr8c_yh8, a house at night) and **Business**
(unsplash.com/photos/NWOyowI7t44, a lit storefront at night).

- **Self-hosted, never hotlinked:** `public/assets/hero/{home,business}-{2000,1000}.webp`. The CSP keeps `img-src 'self'`.
- **Processed:** each photo was converted to sRGB, then all metadata was stripped (EXIF, XMP and the ICC profile), and it was encoded as WebP at 2000 px (quality 90) and 1000 px (85).
- **Sizes:** each file is well under the 300 KB Tomer approved. The 150 KB page budget still covers everything else.
- **What loads:** a CSS layer behind the hero carries the photo, so only the one shown downloads. That's Home on a first visit, Business after the switch, and the 1000 px files on phones.
- **Layout:**
  - Wide screens: the photo fills the hero, with a carbon shade on the text side, and the text column is capped so it stays there.
  - Up to 1024 px: the photo is a band across the top, and the text sits below it.
- **Credit:** a plain-text line with no link (CISO 76(b)): Home "Photo: Vladyslav Melnyk on Unsplash", Business "Photo: Martin Laprise on Unsplash".
- **Checks:**
  - `tests/hero_contrast.mjs` measures every hero text element against the brightest pixel behind it, at seven widths in both views, and fails below WCAG AA.
  - `check_static.py` fails on metadata in any hero file, a file over 300 KB, any `img-src` other than `'self'`, or a credit with a link.

## Icons

Mark A, the element tile's icon cut, lives in `public/favicon.svg` (filled
`#0B0C0E` tile, white outline, white R drawn as a path so it needs no web
font). The PNGs are rendered from it: `icon-32.png`, `icon-180.png` (on a
solid `#0B0C0E` ground for iOS; `apple-touch-icon.png` is the same file at the
path iOS asks for by default), `icon-512.png`, and `favicon.ico` (16, 32, 48).
After changing the SVG, re-render them:

```sh
node tools/render_icons.mjs
```

## How to deploy

Cloudflare Pages, connected to this GitHub repo. A push to `main` publishes
ronna.mom; nothing else deploys.

1. In the Cloudflare dashboard, open **Workers & Pages**, choose **Create**,
   then **Pages**, then **Connect to Git**, and pick `TomerElbaz/ronna-site`.
2. Set up the build:
   - Production branch: `main`
   - Framework preset: **None**
   - Build command: leave empty
   - Build output directory: `public`
   - Root directory: leave empty
   - Environment variables: none. The site needs no keys or secrets.
3. Turn previews off. In the project's **Settings**, under **Builds**
   (branch control), keep automatic production deployments for `main` on and
   set preview branches to **None**. Other branches, including `claude/*`,
   then build nothing and get no preview URL. Check a branch with the
   self-test instead (see [Self-test](#self-test)).
4. Add the domain. Under **Custom domains**, add `ronna.mom` (and `www` if
   wanted, redirected to the apex).
5. Merge to `main` only on the CPO's word.

`public/_headers` and `public/_redirects` are read by Pages automatically. The
`*.pages.dev` address serves the same site with the same headers, so it is
`noindex` too.

After a deploy, check the live headers and the redirect:

```sh
curl -sI https://ronna.mom/ | grep -iE 'content-security-policy|x-robots-tag'
curl -sI https://ronna.mom/waitlist/ | grep -iE '^(HTTP|location)'
```

The first should show the CSP with `form-action 'none'` and
`X-Robots-Tag: noindex`; the second a 301 to `/`.

## Waitlist Worker

`worker/` is the waitlist backend: one Cloudflare Worker, `ronna-site-signup`,
with one D1 database of its own, `ronna-site-waitlist`. It is built to the
design in `docs/SIGNUP_DESIGN.md` and CISO rules 69, 72 and 74, with every
point of those rules as a test (rule 70). **It is not deployed, and no SES key
exists.** Until the CPO says go and the CISO says yes to the key, nothing is live.

| File | What |
|---|---|
| `worker/wrangler.toml` | Name, route `ronna.mom/api/*` only, the one D1 binding, the daily cron, and placeholders set at setup. Secrets are listed by name only. |
| `worker/schema.sql` | Tables: `signups`, `tokens`, `families`, `family_owners`, `enrolment_codes`, `invite_codes`, `salts`, `counters`. |
| `worker/src/index.js` | Routes: public `/api/signup`, `/confirm`, `/delete-request`, `/delete`, `/invite/lookup`, `/invite/redeem`; `/api/family/*` and `/api/operator/*` behind Access; the daily cleanup. |
| `worker/src/access.js` | Checks the Cloudflare Access JWT: signature, issuer, expiry, and the audience tag of *that* application. |
| `worker/src/limits.js` | Rate limits on a salted IP hash (fresh random salt each day), counters only. |
| `worker/src/mail.js` | Plain confirm and delete emails through Amazon SES (SigV4); sends nothing without the secrets. |
| `worker/src/log.js` | The only way to log: fixed event names and error kinds. |
| `worker/src/util.js` | Tokens, Crockford codes, hashing, the reply-time floor. |

**When the CPO says go** (not before), Tomer would, in this order:
1. Create the D1 database `ronna-site-waitlist` and load `worker/schema.sql`; put its ID in `wrangler.toml`.
2. Create two Cloudflare Access applications on Zero Trust Free (logs kept 24 hours, rule 74.2):
   **family** on `ronna.mom/family/*` and `ronna.mom/api/family/*`, letting in the owners' sign-in
   emails; **operator** on `ronna.mom/api/operator/*`, letting in Tomer only, with two-factor
   sign-in (rule 74.6). Put the team domain and each application's audience tag in `wrangler.toml`.
3. After the CISO's yes: create the SES identity for `mail.ronna.mom` (SPF, DKIM, DMARC
   `p=reject`), an IAM key allowed only `ses:SendEmail`, and set it with
   `wrangler secret put SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY`. Never in the repo.
4. Deploy the Worker. Its default Cloudflare subdomain stays off; it answers only on `ronna.mom/api/*`.

**Operator calls** go through the operator Access application, with the
page origin set: for example `POST /api/operator/family/create`,
`/family/enrolment-code {familyId}` (the code is shown once; Tomer hands it
over himself, never by email), `/family/leave {familyId}`, `/revoke
{codeId}` or `{familyId, all: true}`, and `/delete {email}` for deletion
requests that arrive by reply (by hand, within 7 days).

## Preview locally

```sh
node tests/dev_server.mjs 8080
```

Then open http://127.0.0.1:8080. The dev server serves `public/` with the
real `_headers` and `_redirects`, and runs the waitlist Worker in the same
process on an in-memory database: nothing is sent, and each email's links are
printed to the terminal instead. For trying `/family/` by hand it stands in
for Cloudflare Access with dev-only sign-ins.

## Self-test

Run all four before every push:

```sh
npm ci                             # once: axe-core and Playwright, both test-only and pinned
npx playwright install chromium    # once: the browser for that Playwright version
npm run test:worker                # the Worker: every point of rules 69, 72, 74 (Node 22, no network)
python3 tests/check_static.py      # standard library only
python3 tests/check_links.py       # standard library only
node tests/browser_check.mjs       # needs Node and Playwright with Chromium
```

`npm test` runs them all.

`tests/worker/` runs the Worker against a D1-shaped database over Node's
built-in SQLite (batches as transactions, as on D1), with a test-only Access
signing key and a captured mailer. `rule69.test.mjs` and `rule72.test.mjs`
hold one or more tests per point of rules 69, 72 and 74, named after the rule
(`mint-sixth-refused`, `bad-code-one-reply`, `reserve-one-wins`,
`logs-clean`, …). Races are forced with a barrier, not left to chance. `package.json` holds test tools only; nothing in
it is published, since Pages serves `public/` alone.

`check_static.py` scans `public/` for anything pointing off-site, backend
host names, secret-looking strings, missing noindex, lang, title, viewport or
alt text, missing share tags or a share image other than the tile, a waitlist
form with an action, script network calls, anything inline the CSP would block
(inline script or style, `style=""`, `on*=""`, `javascript:`), and any drift
from the drafted headers in `_headers`.

`check_links.py` reads every link (HTML, CSS `url()`, share tags) and fails if
an internal link does not resolve (after `_redirects`), a `#fragment` is not
on its target page, a link goes to any outside host (the allowlist in the
script is empty today; the footer will need two hosts later, added on the
CPO's word), a link uses `mailto:`, `tel:`, `javascript:` or `data:`, or a
page is linked from nowhere (except the 404, `/confirm/`, `/invite/` and `/family/`,
which are reached from outside or through Access).

`browser_check.mjs` runs the site and the Worker in-process
(`tests/dev_server.mjs`), walks signup → confirm → delete, the family page
(enrol, name, mint once, revoke, the sixth refused) and an invitation
(`#code=` → "Invited by" → join → confirm), and fails if any request URL
ever carries a code, token or email (`invite-code-never-in-url`). It loads
every page at 320, 390 and 1280 px with the real headers and redirects, and
fails on any off-site request, console error,
missing font or tile, sideways scroll or cut-off text, invisible keyboard
focus, a switch that does not swap the copy, a broken step (empty email,
confirm, resend), a waitlist submit that sends anything but one same-origin
POST to `/api/signup` (or anything at all without JavaScript), a missing
two-line notice above the button, `/waitlist/` not redirecting, or any page over the
**150 KB budget**: every byte a first visit loads, fonts included, measured
as served before compression, in a fresh browser each time. It prints each
page's weight. It also runs **axe-core** on every page and state (Home,
Business, the email error, the confirm step, and the confirm, delete,
invite and family flows) and fails on any serious or
critical issue; walks the form by keyboard (email, button, Privacy, and back;
Enter on an empty field keeps focus there and marks it invalid; Enter on a
filled one moves focus to the confirm step, then Tab reaches "Send the link
again") and fails on a missing focus ring or a wrong stop; and records every
`securitypolicyviolation`, failing if the CSP blocks anything on any page.
Playwright is pinned (1.56.1) so every machine runs the same version. The
browser test never uses `page.waitForFunction`; it waits with its own
`until()`, which reads the page through `page.evaluate`, so no wait depends on
evaluating code inside a page whose CSP forbids eval. A guard fails the test
if `waitForFunction` comes back, and the CSP recorder names the source of
anything it blocks. To use a Playwright installed elsewhere, set
`PLAYWRIGHT_MODULE` to its path.
