#!/usr/bin/env python3
"""Link checker for the ronna.mom site in public/. Standard library only.

Reads every reference in the published tree (a/link href, script/img src,
form action, CSS url(), and the Open Graph / Twitter share tags) and fails if:
  - an internal link does not resolve to a file, after public/_redirects,
  - a #fragment points at an id that is not on the target page,
  - a link goes to any outside host not in ALLOWED_OUTSIDE_HOSTS,
  - a link uses another scheme (mailto:, tel:, javascript:, data:),
  - a page is linked from nowhere, unless it is in EXPECTED_ORPHANS.

Run from the repo root:  python3 tests/check_links.py
"""
import os
import re
import sys
from html.parser import HTMLParser
from urllib.parse import urlsplit

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public"))

# Our own host: absolute URLs to it (needed by share tags) count as internal.
OWN_HOSTS = {"ronna.mom"}

# Outside hosts a link may point at. The footer will need two later; the CPO
# names them and they go here on that word only. None today.
ALLOWED_OUTSIDE_HOSTS = set()

# Pages nothing on the site links to, on purpose.
EXPECTED_ORPHANS = {
    "404.html": "served by Pages for unknown paths",
    "confirm/index.html": "opened from the confirm email's link",
    "invite/index.html": "opened from an invite link",
}

SHARE_URL_TAGS = {"og:url", "og:image", "twitter:image"}
CSS_URL_RE = re.compile(r"""url\(\s*['"]?([^'")]+)['"]?\s*\)""")

problems = []


class Refs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs = []
        self.ids = set()

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.add(a["id"])
        if tag == "a" and a.get("name"):
            self.ids.add(a["name"])
        if tag in ("a", "link") and a.get("href"):
            self.refs.append(a["href"])
        if tag in ("script", "img", "iframe", "source") and a.get("src"):
            self.refs.append(a["src"])
        if tag == "form" and a.get("action"):
            self.refs.append(a["action"])
        if tag == "meta" and (a.get("property") in SHARE_URL_TAGS or a.get("name") in SHARE_URL_TAGS) and a.get("content"):
            self.refs.append(a["content"])


def redirects():
    out = {}
    path = os.path.join(ROOT, "_redirects")
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            parts = line.split("#", 1)[0].split()
            if len(parts) >= 2:
                out[parts[0]] = parts[1]
    return out


def file_for(url_path, redirect_map):
    for _ in range(5):  # follow a short redirect chain
        if url_path in redirect_map:
            url_path = redirect_map[url_path]
        else:
            break
    rel = url_path.lstrip("/")
    if rel == "" or rel.endswith("/"):
        rel += "index.html"
    full = os.path.normpath(os.path.join(ROOT, rel))
    if not full.startswith(ROOT) or not os.path.isfile(full):
        return None
    return full


def main():
    redirect_map = redirects()
    pages, ids, refs = [], {}, []  # refs: (source file, ref)
    for d, _, names in os.walk(ROOT):
        for n in names:
            path = os.path.join(d, n)
            rel = os.path.relpath(path, ROOT)
            if n.endswith(".html"):
                parser = Refs()
                parser.feed(open(path, encoding="utf-8").read())
                pages.append(rel)
                ids[path] = parser.ids
                refs += [(rel, r) for r in parser.refs]
            elif n.endswith(".css"):
                refs += [(rel, r) for r in CSS_URL_RE.findall(open(path, encoding="utf-8").read())]

    linked = set()
    for src, ref in refs:
        parts = urlsplit(ref)
        if parts.scheme and parts.scheme not in ("http", "https"):
            problems.append(f"{src}: link with scheme {parts.scheme}: {ref}")
            continue
        if parts.netloc:
            host = parts.hostname or ""
            if host in OWN_HOSTS:
                pass  # internal, checked below by path
            elif host in ALLOWED_OUTSIDE_HOSTS:
                continue
            else:
                problems.append(f"{src}: link to an outside host ({host}): {ref}")
                continue
        if not parts.path and not parts.netloc:
            target = os.path.join(ROOT, src)  # "#fragment" on the same page
        else:
            path = parts.path
            if not path.startswith("/"):
                base = "/" + os.path.dirname(src).replace(os.sep, "/")
                path = os.path.normpath(os.path.join(base, path)) + ("/" if path.endswith("/") else "")
            target = file_for(path, redirect_map)
            if not target:
                problems.append(f"{src}: broken link {ref}")
                continue
        if os.path.relpath(target, ROOT) != src:
            linked.add(os.path.relpath(target, ROOT))  # a page linking to itself doesn't count
        if parts.fragment and target.endswith(".html") and parts.fragment not in ids.get(target, set()):
            problems.append(f"{src}: {ref} points at #{parts.fragment}, which is not on {os.path.relpath(target, ROOT)}")

    for page in pages:
        if page not in linked and page not in EXPECTED_ORPHANS:
            problems.append(f"{page}: no page links to it")

    if problems:
        print("FAIL")
        for p in problems:
            print("  " + p)
        return 1
    print(f"OK: {len(refs)} links on {len(pages)} pages resolve; no outside hosts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
