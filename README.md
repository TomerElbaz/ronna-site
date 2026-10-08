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
("Check your email." and "Send the link again"); the place-on-the-list step
also shows in-page at `/#on-the-list`; the confirm email's link itself opens
`/confirm/`. Until the form is connected these carry a preview note saying
nothing was sent or confirmed.

Shared look lives in `public/assets/site.css` (the Brand desk palette, Archivo
and IBM Plex Mono). The fonts are self-hosted in `public/assets/fonts/` under
the SIL Open Font License, so the site makes no third-party requests. Response
headers, including a strict Content-Security-Policy, are in `public/_headers`.

## Rules

- `main` publishes ronna.mom. Work lands on a branch; it reaches `main` only
  on the CPO's word. Pages previews are off, so a branch is checked with the
  self-test, not a preview URL.
- No secret, key or token ever goes in this repo.
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

Run both before every push:

```sh
python3 tests/check_static.py      # standard library only
node tests/browser_check.mjs       # needs Node and Playwright with Chromium
```

`check_static.py` scans `public/` for anything pointing off-site, backend
host names, secret-looking strings, missing noindex, lang, title, viewport or
alt text, broken links, a waitlist form with an action, script network calls,
and lost guards in `_headers`.

`browser_check.mjs` loads every page at 320, 390 and 1280 px with the real
headers and redirects, and fails on any off-site request, console error,
missing font or tile, sideways scroll or cut-off text, invisible keyboard
focus, a switch that does not swap the copy, a broken step (empty email,
confirm, resend, place), a waitlist submit that sends anything with or
without JavaScript, or `/waitlist/` not redirecting.
If Playwright is installed elsewhere, set `PLAYWRIGHT_MODULE` to its path.
