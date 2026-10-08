#!/usr/bin/env python3
"""Local preview of public/ that behaves like Cloudflare Pages where it matters
for the self-test: applies the /* headers from public/_headers and serves
404.html with status 404 for unknown paths.

Usage: python3 tests/serve.py [port]   (default 8080)
"""
import http.server
import os
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public"))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


def site_headers():
    out, block = [], None
    for line in open(os.path.join(ROOT, "_headers"), encoding="utf-8"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            block = line.strip()
            continue
        if block == "/*":
            name, value = line.strip().split(":", 1)
            out.append((name, value.strip()))
    return out


HEADERS = site_headers()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        for name, value in HEADERS:
            if name == "Strict-Transport-Security":
                continue  # plain http locally
            if name == "Content-Security-Policy":
                value = value.replace("; upgrade-insecure-requests", "")
            self.send_header(name, value)
        super().end_headers()

    def send_error(self, code, message=None, explain=None):
        if code != 404:
            return super().send_error(code, message, explain)
        body = open(os.path.join(ROOT, "404.html"), "rb").read()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
