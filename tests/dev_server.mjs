// Local preview and test server for ronna.mom. No dependencies.
// - Serves public/ the way Cloudflare Pages does where it matters here:
//   public/_headers rules (a header set by several matching rules is joined
//   with ", "), public/_redirects, and 404.html for unknown paths.
// - Routes /api/* to the waitlist Worker (worker/src/index.js) running in
//   this process on an in-memory database (tests/worker/harness.mjs), so the
//   pages talk to the real Worker code. Nothing is sent: email is captured.
//
// As a command:  node tests/dev_server.mjs [port]
//   prints captured emails' links to the terminal (local only), and stands in
//   for Cloudflare Access on /api/family/* and /api/operator/* with dev-only
//   sign-ins, so the family page can be tried by hand.
// From tests:    import { startServer } and pass emulateAccess: false.
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";
import { accessClaims, makeEnv, signJwt } from "./worker/harness.mjs";

const ROOT = path.normalize(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public"));
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/vnd.microsoft.icon", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8", ".json": "application/json",
};

function parseHeaders() {
  const rules = [];
  let current = null;
  for (const line of readFileSync(path.join(ROOT, "_headers"), "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    const i = line.indexOf(":");
    current.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return rules;
}

function parseRedirects() {
  const out = new Map();
  const file = path.join(ROOT, "_redirects");
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const parts = line.split("#")[0].trim().split(/\s+/);
    if (parts.length >= 2) out.set(parts[0], [parts[1], Number(parts[2] || 302)]);
  }
  return out;
}

export function headersFor(rules, urlPath) {
  const merged = new Map();
  for (const rule of rules) {
    const p = rule.pattern;
    const hit = p === "/*" || p === urlPath || (p.endsWith("/*") && (urlPath + "/").startsWith(p.slice(0, -1)));
    if (!hit) continue;
    for (const [k, v] of rule.headers) {
      const key = k.toLowerCase();
      merged.set(key, merged.has(key) ? `${merged.get(key)}, ${v}` : v);
    }
  }
  merged.delete("strict-transport-security"); // plain http locally
  if (merged.has("content-security-policy")) {
    merged.set("content-security-policy", merged.get("content-security-policy").replace("; upgrade-insecure-requests", ""));
  }
  return merged;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export async function startServer({ port = 0, env, emulateAccess = false, minReplyMs, trustTestIp = false } = {}) {
  const setup = env ? { env } : makeEnv({ minReplyMs: minReplyMs ?? 400 });
  const workerEnv = setup.env;
  if (!env) delete workerEnv.CLOCK; // real time for a running server
  const rules = parseHeaders();
  const redirects = parseRedirects();
  const devJwt = emulateAccess
    ? {
        family: await signJwt(accessClaims("family", "dev-owner", Date.now(), { exp: Math.floor(Date.now() / 1000) + 86400 })),
        operator: await signJwt(accessClaims("operator", "dev-operator", Date.now(), { exp: Math.floor(Date.now() / 1000) + 86400 })),
      }
    : null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    const urlPath = decodeURIComponent(url.pathname);
    const extra = headersFor(rules, urlPath);

    if (urlPath.startsWith("/api/")) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      // Tests only: let each browser context act as its own visitor, so per-IP limits don't collide.
      const testIp = trustTestIp && req.headers["x-test-client-ip"];
      headers.delete("x-test-client-ip");
      headers.set("CF-Connecting-IP", testIp || req.socket.remoteAddress || "127.0.0.1");
      if (devJwt && urlPath.startsWith("/api/family/")) headers.set("Cf-Access-Jwt-Assertion", devJwt.family);
      if (devJwt && urlPath.startsWith("/api/operator/")) headers.set("Cf-Access-Jwt-Assertion", devJwt.operator);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body });
      const waits = [];
      const reqEnv = { ...workerEnv, SITE_ORIGIN: `http://${req.headers.host}` };
      const response = await worker.fetch(request, reqEnv, { waitUntil: (p) => waits.push(p) });
      const out = { "content-type": response.headers.get("content-type") || "application/json" };
      response.headers.forEach((v, k) => { out[k] = v; });
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
      await Promise.all(waits);
      return;
    }

    const send = (status, file, more = {}) => {
      const headers = Object.fromEntries(extra);
      headers["content-type"] = TYPES[path.extname(file)] || "application/octet-stream";
      res.writeHead(status, { ...headers, ...more });
      res.end(readFileSync(file));
    };

    if (redirects.has(urlPath)) {
      const [to, code] = redirects.get(urlPath);
      res.writeHead(code, { ...Object.fromEntries(extra), location: to, "content-length": "0" });
      return res.end();
    }
    let file = path.normalize(path.join(ROOT, urlPath));
    if (!file.startsWith(ROOT)) return send(404, path.join(ROOT, "404.html"));
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!urlPath.endsWith("/")) {
        res.writeHead(308, { location: urlPath + "/" });
        return res.end();
      }
      file = path.join(file, "index.html");
    }
    if (!existsSync(file) || path.basename(file).startsWith("_")) return send(404, path.join(ROOT, "404.html"));
    send(200, file);
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    server,
    port: server.address().port,
    env: workerEnv,
    mail: setup.mail,
    close: () => new Promise((r) => server.close(r)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.argv[2] || 8080);
  const s = await startServer({ port, emulateAccess: true });
  s.env.MAILER = async (m) => {
    const links = (m.text.match(/https:\/\/ronna\.mom\/\S+/g) || []).map((l) => l.replace("https://ronna.mom", `http://127.0.0.1:${port}`));
    console.log(`\n[dev] email to ${m.to}: ${m.subject}\n${links.map((l) => "  " + l).join("\n")}\n`);
  };
  console.log(`ronna.mom preview on http://127.0.0.1:${port} (Worker in-process, in-memory database, nothing sent).`);
  console.log("Dev only: /api/family/* and /api/operator/* get stand-in Access sign-ins.");
}
