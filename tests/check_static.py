#!/usr/bin/env python3
"""Static self-test for the ronna.mom site in public/. Standard library only.

Fails if anything in the published tree:
  - points at another origin (only same-site paths, or absolute URLs on our
    own host for share tags, are allowed),
  - mentions the MOM product's backend hosts,
  - looks like a secret, key or token,
  - lacks noindex, a language, a title or a viewport,
  - has an image without alt, or a page without exactly one h1,
  - (except 404.html) lacks its Open Graph / Twitter share tags, or shares an
    image other than the tile (icon-512.png),
  - gives the waitlist form an action, or lets a script reach anything but
    this site's own /api/ (one fetch, inside post(), to literal "/api/..." paths),
  - drops the guards in _headers (CSP form-action 'none', X-Robots-Tag noindex),
  - strays from the DRAFT FOR CISO headers (issue #15): CSP with no outside
    host and frame-ancestors 'none', nosniff, Referrer-Policy
    strict-origin-when-cross-origin, Permissions-Policy denying camera,
    microphone and geolocation,
  - has anything inline that CSP would block: a <script> without src, a
    <style> element, a style="" attribute, an on*="" handler, a javascript: URL,
  - lets /confirm/ or /invite/ (token links) lose their no-referrer meta.

Links (internal resolution, anchors, outside hosts) are checked by
tests/check_links.py.

Run from the repo root:  python3 tests/check_static.py
"""
import os
import re
import sys
from html.parser import HTMLParser

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")
ROOT = os.path.normpath(ROOT)
TEXT_EXT = {".html", ".css", ".js", ".svg", ".txt", ""}

# The only absolute URL allowed: the SVG namespace, which is an identifier and never fetched.
ALLOWED_URLS = {"http://www.w3.org/2000/svg"}
# Our own host, for the absolute URLs that Open Graph / Twitter tags require.
OWN_ORIGIN = "https://ronna.mom/"
URL_RE = re.compile(r"""(?:https?:)?//[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\s"'<>)]*""")
# The MOM product's backend: its Worker and any workers.dev host. The site's own
# waitlist Worker (worker/, rules 69 and 74) is not the MOM Worker.
BACKEND_RE = re.compile(r"workers\.dev|\bMOM(?:'s)?(?: product's)? Worker\b|mom-tenant|tenant-0", re.I)
SECRET_RE = re.compile(
    r"(api[_-]?key\s*[:=]|secret\s*[:=]\s*[\"']|bearer\s+[a-z0-9]{8}|token\s*[:=]\s*[\"'][A-Za-z0-9_\-]{16,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN)",
    re.I,
)
NETWORK_JS_RE = re.compile(r"\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|navigator\.sendBeacon|\.submit\(\))", re.I)

problems = []


def rel(path):
    return os.path.relpath(path, ROOT)


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.lang = None
        self.title = False
        self.viewport = False
        self.robots = None
        self.share = {}
        self.h1 = 0
        self.imgs_without_alt = 0
        self.forms = []
        self.inline = []
        self.referrer = None
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "html":
            self.lang = a.get("lang")
        elif tag == "title":
            self._in_title = True
        elif tag == "meta" and a.get("name") == "viewport":
            self.viewport = True
        elif tag == "meta" and a.get("name") == "robots":
            self.robots = a.get("content")
        elif tag == "meta" and (a.get("property", "").startswith("og:") or a.get("name", "").startswith("twitter:")):
            self.share[a.get("property") or a.get("name")] = a.get("content", "")
        elif tag == "h1":
            self.h1 += 1
        elif tag == "img" and "alt" not in a:
            self.imgs_without_alt += 1
        if tag == "form":
            self.forms.append(a)
        if tag == "meta" and a.get("name") == "referrer":
            self.referrer = a.get("content")
        if tag == "script" and not a.get("src"):
            self.inline.append("inline <script>")
        if tag == "style":
            self.inline.append("<style> element")
        for k, v in a.items():
            if k == "style":
                self.inline.append(f'style="" on <{tag}>')
            elif k.startswith("on"):
                self.inline.append(f'{k}="" handler on <{tag}>')
            elif k in ("href", "src", "action") and (v or "").strip().lower().startswith("javascript:"):
                self.inline.append(f"javascript: URL on <{tag}>")

    def handle_data(self, data):
        if self._in_title and data.strip():
            self.title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False


def main():
    files = []
    for d, _, names in os.walk(ROOT):
        for n in names:
            files.append(os.path.join(d, n))

    for path in files:
        ext = os.path.splitext(path)[1].lower()
        if ext not in TEXT_EXT and os.path.basename(path) != "_headers":
            continue
        text = open(path, encoding="utf-8", errors="replace").read()
        is_license = os.path.basename(path).startswith("OFL-")
        if not is_license:
            for m in URL_RE.finditer(text):
                url = m.group(0).rstrip(".,;")
                if url not in ALLOWED_URLS and not url.startswith(OWN_ORIGIN):
                    problems.append(f"{rel(path)}: points off-site: {url}")
        if BACKEND_RE.search(text):
            problems.append(f"{rel(path)}: mentions a backend host")
        if not is_license and SECRET_RE.search(text):
            problems.append(f"{rel(path)}: looks like a secret: {SECRET_RE.search(text).group(0)}")
        if ext == ".js":
            # The only network use allowed: one fetch inside post(), and post() called
            # only with literal same-origin "/api/..." paths (the waitlist Worker).
            other = [m.group(0) for m in NETWORK_JS_RE.finditer(text) if m.group(0) != "fetch"]
            if other:
                problems.append(f"{rel(path)}: script uses {other[0]}")
            fetches = re.findall(r"\bfetch\(([^,)]*)", text)
            if fetches and fetches != ["path"]:
                problems.append(f"{rel(path)}: fetch must appear once, as fetch(path, ...) inside post(): {fetches}")
            for target in re.findall(r"\bpost\(([^,)]*)", text):
                if not re.fullmatch(r'"/api/[a-z/-]+"', target.strip()) and target.strip() != "path":
                    problems.append(f"{rel(path)}: post() to {target.strip()}, not a literal /api/ path")

        if ext == ".html":
            p = Page()
            p.feed(text)
            if not p.lang:
                problems.append(f"{rel(path)}: no lang on <html>")
            if not p.title:
                problems.append(f"{rel(path)}: no <title>")
            if not p.viewport:
                problems.append(f"{rel(path)}: no viewport meta")
            if p.robots != "noindex":
                problems.append(f"{rel(path)}: meta robots is {p.robots!r}, want 'noindex'")
            if p.h1 != 1:
                problems.append(f"{rel(path)}: {p.h1} <h1> elements, want 1")
            if p.imgs_without_alt:
                problems.append(f"{rel(path)}: {p.imgs_without_alt} <img> without alt")
            if rel(path) not in ("404.html", "family/index.html"):  # 404 and the private family page carry no share tags
                for key in ("og:title", "og:description", "og:url", "og:image", "twitter:card", "twitter:title", "twitter:description", "twitter:image"):
                    if not p.share.get(key):
                        problems.append(f"{rel(path)}: share tag {key} missing")
                for key in ("og:image", "twitter:image"):
                    if p.share.get(key) and p.share[key] != OWN_ORIGIN + "icon-512.png":
                        problems.append(f"{rel(path)}: {key} is {p.share[key]}, want the tile {OWN_ORIGIN}icon-512.png")
            for what in p.inline:
                problems.append(f"{rel(path)}: CSP would block {what}")
            if rel(path) in ("confirm/index.html", "invite/index.html", "off/index.html", "family/index.html") and p.referrer != "no-referrer":
                problems.append(f"{rel(path)}: token page lost <meta name=referrer content=no-referrer>")
            for form in p.forms:
                if form.get("action", "") != "":
                    problems.append(f"{rel(path)}: form has an action ({form.get('action')}) without a CISO ruling")

    headers = open(os.path.join(ROOT, "_headers"), encoding="utf-8").read()
    if not re.search(r"^\s+X-Robots-Tag:\s*noindex\s*$", headers, re.M):
        problems.append("_headers: X-Robots-Tag: noindex missing")
    site = headers.split("\n/*\n", 1)[1].split("\n\n", 1)[0] if "\n/*\n" in headers else ""
    def header(name):
        m = re.search(rf"^\s+{re.escape(name)}:\s*(.+?)\s*$", site, re.M | re.I)
        return m.group(1) if m else None
    want = {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
    }
    for name, value in want.items():
        if header(name) != value:
            problems.append(f"_headers: {name} is {header(name)!r}, want {value!r}")
    pp = header("Permissions-Policy") or ""
    for feature in ("camera=()", "microphone=()", "geolocation=()"):
        if feature not in pp:
            problems.append(f"_headers: Permissions-Policy does not deny {feature.split('=')[0]}")
    csp = header("Content-Security-Policy") or ""
    if "default-src 'none'" not in csp:
        problems.append("_headers: CSP default-src 'none' missing")
    if re.search(r"https?:|\*|//", csp):
        problems.append("_headers: CSP allows another origin")
    if "form-action 'none'" not in csp:
        problems.append("_headers: CSP lost form-action 'none'")
    if "frame-ancestors 'none'" not in csp:
        problems.append("_headers: CSP lost frame-ancestors 'none'")
    for line in headers.splitlines():
        if line.lstrip().startswith("#") and line[:1].isspace():
            problems.append("_headers: indented comment inside a rule block")

    if problems:
        print("FAIL")
        for p in problems:
            print("  " + p)
        return 1
    print(f"OK: {len(files)} files in public/ checked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
