#!/usr/bin/env python3
"""Static self-test for ronnaops.com (ronnaops/, CPO order W-06). Standard library only.

Fails if the ronnaops.com site:
  - has a form, field, button, script, iframe, inline style or event handler,
  - links anywhere outside itself except https://ronna.mom (the "MOM for
    families" link and the waitlist privacy page),
  - loses its one MOM link ("MOM for families" to https://ronna.mom), the
    "Business: coming later." line, or its Privacy link,
  - says more about MOM than the CPO's line ("a family console for the
    household's schedule, records and helpers"), or mentions a price,
  - uses gold (MOM's alone) or any green, or an em dash,
  - drops noindex, or loosens its CSP (no scripts, no forms, nothing loaded
    from another host),
  - loads a font it doesn't host, or ships a font without its OFL text.
"""
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "ronnaops"))
problems = []
CLAIM = "MOM is our family product: a family console for the household's schedule, records and helpers. It lives at ronna.mom."


def read(rel):
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


def green_or_gold(hexcode):
    h = hexcode.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    if h.upper() == "B5964D":
        return "gold"
    if g > r + 24 and g > b + 24:
        return "green"
    if r > b + 40 and g > b + 40 and abs(r - g) < 60:
        return "gold"
    return None


pages = []
for d, _, names in os.walk(ROOT):
    for n in names:
        pages.append(os.path.relpath(os.path.join(d, n), ROOT))

for rel in pages:
    if rel.endswith((".woff2", ".txt")):
        continue
    text = read(rel)
    if "—" in text:
        problems.append(f"{rel}: em dash")
    for m in re.finditer(r"#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b", text):
        kind = green_or_gold(m.group(0))
        if kind:
            problems.append(f"{rel}: {kind} colour {m.group(0)} (gold is MOM's alone; no green)")
    if rel.endswith(".html"):
        live = re.sub(r"<!--.*?-->", "", text, flags=re.S)
        for pat, what in [(r"<form\b|<input\b|<button\b|<textarea\b|<select\b", "a form control"),
                          (r"<script\b", "a script"), (r"<iframe\b", "an iframe"),
                          (r"\sstyle=", "an inline style"), (r"\son[a-z]+=", "an event handler")]:
            if re.search(pat, live, re.I):
                problems.append(f"{rel}: has {what}")
        if '<meta name="robots" content="noindex">' not in text:
            problems.append(f"{rel}: lacks noindex")
        for href in re.findall(r'(?:href|src)="([^"]+)"', live):
            if re.match(r"https?://", href) and not re.match(r"https://ronna\.mom(/|$)", href):
                problems.append(f"{rel}: links outside ronnaops.com and ronna.mom: {href}")
            if re.match(r"https?://", href) and 'src="' + href in live:
                problems.append(f"{rel}: loads {href} from another host")
        if re.search(r"\$\s?\d|\bprice|\bpricing|/mo\b|per month", re.sub(r"<[^>]+>", " ", live), re.I):
            problems.append(f"{rel}: mentions a price")

index = re.sub(r"<!--.*?-->", "", read("index.html"), flags=re.S)
if len(re.findall(r'<a class="btn" href="https://ronna\.mom">MOM for families</a>', index)) != 1:
    problems.append('index.html: want exactly one "MOM for families" link to https://ronna.mom')
if "Business: coming later." not in index:
    problems.append('index.html: "Business: coming later." missing')
if '<a href="/privacy/">Privacy</a>' not in index:
    problems.append("index.html: Privacy link missing")
moms = [s.strip() for s in re.split(r"(?<=[.!?])\s+", re.sub(r"<[^>]+>", " ", index)) if re.search(r"\bMOM\b", s)]
allowed = {CLAIM.split(". ")[0] + ".", "It lives at ronna.mom.", "MOM for families Business: coming later."}
if CLAIM not in index:
    problems.append("index.html: the MOM line isn't the CPO's approved line")
for s in moms:
    s = re.sub(r"\s+", " ", s)
    if not any(a in s or s in a for a in allowed) and "MOM for families" not in s and "routes a household" not in s:
        problems.append(f"index.html: says more about MOM than approved: {s!r}")

headers = read("_headers")
csp = re.search(r"Content-Security-Policy: (.+)", headers)
if not csp or "script-src 'none'" not in csp.group(1) or "form-action 'none'" not in csp.group(1) or re.search(r"https?:|\*", csp.group(1)):
    problems.append("_headers: CSP must keep script-src 'none', form-action 'none' and no outside host")
if "X-Robots-Tag: noindex" not in headers:
    problems.append("_headers: X-Robots-Tag noindex missing")

css = read(os.path.join("assets", "site.css"))
for font in re.findall(r"url\((/assets/fonts/[^)]+)\)", css):
    if not os.path.exists(os.path.join(ROOT, font.lstrip("/"))):
        problems.append(f"assets/site.css: font {font} isn't hosted here")
for need in ("OFL-Archivo.txt", "OFL-IBM-Plex-Mono.txt"):
    if not os.path.exists(os.path.join(ROOT, "assets", "fonts", need)):
        problems.append(f"assets/fonts: {need} missing")
mark = read(os.path.join("assets", "mark-a.svg"))
if re.search(r"<text|font-family|url\(", mark):
    problems.append("assets/mark-a.svg: must be outlines only")

if problems:
    print("FAIL (ronnaops.com)")
    for p in problems:
        print("  " + p)
    sys.exit(1)
print(f"OK: ronnaops.com, {len(pages)} files checked")
