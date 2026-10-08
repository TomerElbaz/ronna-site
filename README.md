# ronna-site
Public site for MOM by Ronna

Static site for Cloudflare Pages: plain HTML, CSS and one small script. No
framework and no build step. Only `public/` is published; this README,
`tests/` and `tools/` stay in the repo and never reach ronna.mom. See
[How to deploy](#how-to-deploy).

## Pages

| Path       | File                       | State                                                        |
|------------|----------------------------|--------------------------------------------------------------|
| `/`        | `public/index.html`        | The waitlist is the main page (UX design, 12:58 CT 8 Oct). Form **not connected**. |
| `/what/`   | `public/what/index.html`   | "What MOM is" in the main page's blocks, Home and Business. `[COPY]`. |
| `/how/`    | `public/how/index.html`    | How it works: three steps (Tell MOM, MOM files it, You say Go), Home and Business. `[COPY]`. |
| `/privacy/`| `public/privacy/index.html`| Privacy skeleton, **for CISO review**: what we collect (email only), why, how to leave, never. `[COPY]`. |
| `/terms/`  | `public/terms/index.html`  | Terms skeleton, **for counsel review**: who we are, the waitlist, leaving, changes, governing law, contact. `[COPY]`. |
| `/confirm/`| `public/confirm/index.html`| Confirm-email landing a double opt-in link opens: "You're on the list", place placeholder. Static; reads nothing from the URL; `no-store`. |
| `/invite/` | `public/invite/index.html` | Invite-accept placeholder. Does nothing.                     |
| `/off/`    | `public/off/index.html`    | "Take me off the list" placeholder. No form yet.             |
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
in-page place step. Until the form is connected both carry a preview note
saying nothing was sent or confirmed.

Every page except the 404 carries Open Graph and Twitter share tags with
`[COPY]` titles and descriptions and the tile (`icon-512.png`) as the image.
Pages stay `noindex`.

Response headers are a **DRAFT FOR CISO** (issue #15): a
Content-Security-Policy with no outside host at all (fonts are self-hosted)
and nothing inline, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, and a Permissions-Policy denying camera,
microphone and location. `/confirm/` and `/invite/`, which open from links
that may carry a token, also set `no-referrer` in a meta tag.

Shared look lives in `public/assets/site.css` (the Brand desk palette, Archivo
and IBM Plex Mono). The fonts are self-hosted in `public/assets/fonts/` under
the SIL Open Font License, so the site makes no third-party requests.
Archivo is trimmed to the weights (400-700) and widths (100-125%) the site
uses, to stay inside the page-weight budget; see `tools/trim_font.py`. Response
headers, including a strict Content-Security-Policy, are in `public/_headers`.

## Rules

- `main` publishes ronna.mom. Work lands on a branch; it reaches `main` only
  on the CPO's word. Pages previews are off, so a branch is checked with the
  self-test, not a preview URL.
- No secret, key or token ever goes in this repo.
- Outside links: none today. `ALLOWED_OUTSIDE_HOSTS` in
  `tests/check_links.py` stays empty until the CPO approves hosts by name.
- No form destination, analytics or third-party script without a CISO
  ruling posted in the CPO chat. The waitlist form has an empty action, its
  submit is held by `public/assets/site.js` (which clears the field), and
  the CSP sets `form-action 'none'`. The human-check slot is sized for
  Cloudflare Turnstile (300 x 65, or 150 x 140 under 332 px) and stays an
  empty box: no script, no key, no request until the CISO rules, and the CSP
  would block the widget until that ruling opens it.
- Nothing here points at the MOM product's backend or any of its hosts.
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

## Preview locally

```sh
python3 tests/serve.py 8080
```

Then open http://localhost:8080. `tests/serve.py` applies the `/*` headers
from `public/_headers` and serves `404.html` for unknown paths, like Pages.

## Self-test

Run all three before every push:

```sh
npm ci                             # once: installs axe-core (test-only, pinned)
python3 tests/check_static.py      # standard library only
python3 tests/check_links.py       # standard library only
node tests/browser_check.mjs       # needs Node and Playwright with Chromium
```

`npm test` runs all three. `package.json` holds test tools only; nothing in
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
page is linked from nowhere (except the 404, `/confirm/` and `/invite/`,
which are reached from outside).

`browser_check.mjs` loads every page at 320, 390 and 1280 px with the real
headers and redirects, and fails on any off-site request, console error,
missing font or tile, sideways scroll or cut-off text, invisible keyboard
focus, a switch that does not swap the copy, a broken step (empty email,
confirm, resend), a waitlist submit that sends anything with or
without JavaScript, `/waitlist/` not redirecting, or any page over the
**150 KB budget**: every byte a first visit loads, fonts included, measured
as served before compression, in a fresh browser each time. It prints each
page's weight. It also runs **axe-core** on every page and state (Home,
Business, the email error, the confirm step) and fails on any serious or
critical issue; walks the form by keyboard (email, button, Privacy, and back;
Enter on an empty field keeps focus there and marks it invalid; Enter on a
filled one moves focus to the confirm step, then Tab reaches "Send the link
again") and fails on a missing focus ring or a wrong stop; and records every
`securitypolicyviolation`, failing if the CSP blocks anything on any page.
If Playwright is installed elsewhere, set `PLAYWRIGHT_MODULE` to its path.
