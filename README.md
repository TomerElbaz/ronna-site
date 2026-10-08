# ronna-site
Public site for MOM by Ronna

Static site for Cloudflare Pages: plain HTML, CSS and one small script. No
framework and no build step. In Pages, leave the build command empty and set
the output directory to `public`. Only `public/` is published; this README and
`tests/` stay in the repo and never reach ronna.mom.

## Pages

| Path         | File                         | State                                        |
|--------------|------------------------------|----------------------------------------------|
| `/`          | `public/index.html`          | Home. Copy is placeholder `[COPY]`.          |
| `/what/`     | `public/what/index.html`     | Short "what MOM is" page. `[COPY]`.          |
| `/waitlist/` | `public/waitlist/index.html` | Form present, **not connected** (see below). |
| `/invite/`   | `public/invite/index.html`   | Invite-accept placeholder. Does nothing.     |
| 404          | `public/404.html`            | Served by Pages for unknown paths.           |

Shared look lives in `public/assets/site.css` (the Brand desk palette, Archivo
and IBM Plex Mono). The fonts are self-hosted in `public/assets/fonts/` under
the SIL Open Font License, so the site makes no third-party requests. Response
headers, including a strict Content-Security-Policy, are in `public/_headers`.

## Rules

- `main` publishes ronna.mom. Work lands on a branch; it reaches `main` only
  on the CPO's word.
- No secret, key or token ever goes in this repo.
- No form destination, analytics or third-party script without a CISO
  ruling posted in the CPO chat. The waitlist form has an empty action, its
  submit is held by `public/assets/site.js`, and the CSP sets `form-action 'none'`.
- Nothing here points at the MOM product's backend or any of its hosts.
- No real family data, no names, no product screenshots.
- Copy marked `[COPY]` is placeholder until the CBO's text arrives through
  the CPO.
- Company mark: A, the element tile (picked 8 Oct). `public/favicon.svg` is its
  small-size cut (filled `#0B0C0E` tile, white R drawn as an outline, so it
  needs no web font); `favicon.ico` and `apple-touch-icon.png` are rendered
  from it. The header pairs the tile with "RonnaOps" in mixed case.
  Gold (`#B5964D`) is used for MOM only. The one action color is white.
- Every page is `noindex` (meta robots on each page and `X-Robots-Tag` in
  `_headers`) until the CPO says the copy is live. Remove both together.
- Accessibility: text meets WCAG AA contrast on every surface (grey on
  ground 8.4:1, gold 6.9:1); form field edges use `--dim` to meet the 3:1
  boundary rule; every focus stop shows a white outline; Tab starts at a
  skip link.

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
and lost guards in `_headers`. `browser_check.mjs` loads every page at phone
and desktop width with the real headers and fails on any off-site request,
console error, missing font or tile, sideways scroll, invisible keyboard
focus, or a waitlist submit that sends anything, with or without JavaScript.
If Playwright is installed elsewhere, set `PLAYWRIGHT_MODULE` to its path.
