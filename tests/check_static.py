#!/usr/bin/env python3
"""Static self-test for the ronna.mom site in public/. Standard library only.

Fails if anything in the published tree:
  - points at another origin (only same-site paths are allowed),
  - mentions the MOM product's backend hosts,
  - looks like a secret, key or token,
  - lacks noindex, a language, a title or a viewport,
  - has an image without alt, or a page without exactly one h1,
  - links to a page or asset that does not exist,
  - gives the waitlist form an action or a network call,
  - drops the guards in _headers (CSP form-action 'none', X-Robots-Tag noindex).

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
URL_RE = re.compile(r"""(?:https?:)?//[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\s"'<>)]*""")
BACKEND_RE = re.compile(r"workers\.dev|\bworker\b", re.I)
SECRET_RE = re.compile(
    r"(api[_-]?key|secret|bearer\s+[a-z0-9]|token\s*[:=]|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN)",
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
        self.h1 = 0
        self.imgs_without_alt = 0
        self.refs = []
        self.forms = []
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
        elif tag == "h1":
            self.h1 += 1
        elif tag == "img" and "alt" not in a:
            self.imgs_without_alt += 1
        if tag == "form":
            self.forms.append(a)
        for key in ("href", "src", "action"):
            if key in a and a[key]:
                self.refs.append(a[key])

    def handle_data(self, data):
        if self._in_title and data.strip():
            self.title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False


def resolve(ref, page_path):
    ref = ref.split("#", 1)[0].split("?", 1)[0]
    if not ref or re.match(r"^([a-z][a-z0-9+.-]*:|//)", ref, re.I):
        return None  # empty, or another origin (reported above as off-site)
    if ref.startswith("/"):
        target = os.path.join(ROOT, ref.lstrip("/"))
    else:
        target = os.path.join(os.path.dirname(page_path), ref)
    if ref.endswith("/"):
        target = os.path.join(target, "index.html")
    return os.path.normpath(target)


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
                if url not in ALLOWED_URLS:
                    problems.append(f"{rel(path)}: points off-site: {url}")
        if BACKEND_RE.search(text):
            problems.append(f"{rel(path)}: mentions a backend host")
        if not is_license and SECRET_RE.search(text):
            problems.append(f"{rel(path)}: looks like a secret: {SECRET_RE.search(text).group(0)}")
        if ext == ".js" and NETWORK_JS_RE.search(text):
            problems.append(f"{rel(path)}: script makes or allows a network call: {NETWORK_JS_RE.search(text).group(0)}")

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
            for form in p.forms:
                if form.get("action", "") != "":
                    problems.append(f"{rel(path)}: form has an action ({form.get('action')}) without a CISO ruling")
            for ref in p.refs:
                target = resolve(ref, path)
                if target and not os.path.exists(target):
                    problems.append(f"{rel(path)}: broken link {ref}")

    headers = open(os.path.join(ROOT, "_headers"), encoding="utf-8").read()
    if "form-action 'none'" not in headers:
        problems.append("_headers: CSP lost form-action 'none'")
    if not re.search(r"^\s+X-Robots-Tag:\s*noindex\s*$", headers, re.M):
        problems.append("_headers: X-Robots-Tag: noindex missing")
    csp = re.search(r"Content-Security-Policy:(.*)", headers)
    if not csp or "default-src 'none'" not in csp.group(1):
        problems.append("_headers: CSP default-src 'none' missing")
    elif re.search(r"https?:|\*", csp.group(1)):
        problems.append("_headers: CSP allows another origin")
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
