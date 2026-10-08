# ronna-site
Public site for MOM by Ronna

Static site for Cloudflare Pages: plain HTML, CSS and one small script. No
framework and no build step. In Pages, leave the build command empty and set
the output directory to `/`.

## Pages

| Path         | File                  | State                                        |
|--------------|-----------------------|----------------------------------------------|
| `/`          | `index.html`          | Home. Copy is placeholder `[COPY]`.          |
| `/what/`     | `what/index.html`     | Short "what MOM is" page. `[COPY]`.          |
| `/waitlist/` | `waitlist/index.html` | Form present, **not connected** (see below). |
| `/invite/`   | `invite/index.html`   | Invite-accept placeholder. Does nothing.     |
| 404          | `404.html`            | Served by Pages for unknown paths.           |

Shared look lives in `assets/site.css` (the Brand desk palette, Archivo and
IBM Plex Mono). The fonts are self-hosted in `assets/fonts/` under the SIL Open
Font License, so the site makes no third-party requests. Response headers,
including a strict Content-Security-Policy, are in `_headers`.

## Rules

- `main` publishes ronna.mom. Work lands on a branch; it reaches `main` only
  on the CPO's word.
- No secret, key or token ever goes in this repo.
- No form destination, analytics or third-party script without a CISO
  ruling posted in the CPO chat. The waitlist form has an empty action, its
  submit is held by `assets/site.js`, and the CSP sets `form-action 'none'`.
- Nothing here points at the MOM product's backend or any of its hosts.
- No real family data, no names, no product screenshots.
- Copy marked `[COPY]` is placeholder until the CBO's text arrives through
  the CPO.
- Company mark: A, the element tile (picked 8 Oct). `favicon.svg` is its
  small-size cut (filled `#0B0C0E` tile, white R drawn as an outline, so it
  needs no web font); `favicon.ico` and `apple-touch-icon.png` are rendered
  from it. The header pairs the tile with "RonnaOps" in mixed case.
  Gold (`#B5964D`) is used for MOM only. The one action color is white.
- Every page is `noindex` (meta robots on each page and `X-Robots-Tag` in
  `_headers`) until the CPO says the copy is live. Remove both together.

## Preview locally

```sh
python3 -m http.server 8080
```

Then open http://localhost:8080. The local server ignores `_headers`.
