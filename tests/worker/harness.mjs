// Test harness for the waitlist Worker. No network, no new dependencies:
// - D1: a D1-shaped wrapper over Node's built-in SQLite (node:sqlite), with
//   batch() run as one transaction, as D1 does, and foreign keys on.
// - Access: a test-only RSA key signs JWTs; the Worker fetches its "certs"
//   through env.ACCESS_FETCH, never the network.
// - Mail: env.MAILER captures messages instead of SES.
// - Logs: console.log is captured so tests can check what was logged.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import worker from "../../worker/src/index.js";
import { clearAccessCertCache } from "../../worker/src/access.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCHEMA = readFileSync(path.join(root, "worker", "schema.sql"), "utf8");
export const ORIGIN = "https://ronna.mom";
export const TEAM = "test-team.cloudflareaccess.com";
export const FAMILY_AUD = "aud-family-test";
export const OPERATOR_AUD = "aud-operator-test";

class Stmt {
  constructor(owner, sql, args = []) {
    this.owner = owner;
    this.db = owner.db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    for (const a of args) if (a === undefined) throw new Error("D1_TYPE_ERROR: undefined bound");
    return new Stmt(this.owner, this.sql, args);
  }
  // Tests can hold a statement at a barrier (owner.hook) to force a real race.
  async _gate() {
    if (this.owner.hook) await this.owner.hook(this.sql);
  }
  _exec() {
    const s = this.db.prepare(this.sql);
    const reads = /^\s*(select|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql);
    if (reads) {
      const results = s.all(...this.args).map((r) => ({ ...r }));
      const changes = /^\s*(select|with)\b/i.test(this.sql) ? 0 : results.length;
      return { success: true, results, meta: { changes } };
    }
    const info = s.run(...this.args);
    return { success: true, results: [], meta: { changes: Number(info.changes) } };
  }
  async run() { await this._gate(); return this._exec(); }
  async all() { await this._gate(); return this._exec(); }
  async first(col) {
    await this._gate();
    const r = this._exec().results[0];
    if (!r) return null;
    return col ? r[col] : r;
  }
}

export class TestD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(SCHEMA);
    this.db.exec("PRAGMA foreign_keys = ON;");
  }
  prepare(sql) {
    return new Stmt(this, sql);
  }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => s._exec());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql) {
    this.db.exec(sql);
  }
  // Every value stored anywhere, as one string, for "is X stored?" checks.
  dump() {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    return tables.map((t) => JSON.stringify(this.db.prepare(`SELECT * FROM ${t}`).all())).join("\n");
  }
  rows(sql, ...args) {
    return this.db.prepare(sql).all(...args).map((r) => ({ ...r }));
  }
}

// ---------- Access test keys ----------
const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"],
);
const otherPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"],
);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

export async function signJwt(claims, { forged = false, kid = "test-kid" } = {}) {
  const header = b64u(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
  const body = b64u(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", forged ? otherPair.privateKey : keyPair.privateKey, new TextEncoder().encode(header + "." + body),
  );
  return `${header}.${body}.${b64u(new Uint8Array(sig))}`;
}

export function accessClaims(app, sub, t, extra = {}) {
  const s = Math.floor(t / 1000);
  return { aud: [app === "family" ? FAMILY_AUD : OPERATOR_AUD], sub, iss: `https://${TEAM}`, iat: s, nbf: s, exp: s + 3600, ...extra };
}

// ---------- environment ----------
export function makeEnv({ start = Date.UTC(2026, 9, 9, 6, 0, 0), minReplyMs = 0 } = {}) {
  clearAccessCertCache();
  const clock = { t: start };
  const mail = [];
  const env = {
    DB: new TestD1(),
    SITE_ORIGIN: ORIGIN,
    MIN_REPLY_MS: String(minReplyMs),
    ACCESS_TEAM_DOMAIN: TEAM,
    FAMILY_AUD,
    OPERATOR_AUD,
    ACCESS_FETCH: async (url) => {
      if (url !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error("unexpected fetch " + url);
      return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { "content-type": "application/json" } });
    },
    MAILER: async (m) => { mail.push(m); },
    CLOCK: () => clock.t,
  };
  return { env, clock, mail };
}

// ---------- calling the Worker ----------
export async function call(env, pathname, body, { ip = "203.0.113.7", jwt, origin = ORIGIN, method = "POST", contentType = "application/json", rawBody, query = "" } = {}) {
  const headers = { "CF-Connecting-IP": ip, "User-Agent": "TestAgent/1.0 (unique-ua-marker)" };
  if (origin) headers.Origin = origin;
  if (contentType) headers["Content-Type"] = contentType;
  if (jwt) headers["Cf-Access-Jwt-Assertion"] = jwt;
  const req = new Request(`https://ronna.mom${pathname}${query}`, {
    method,
    headers,
    body: method === "GET" ? undefined : rawBody ?? JSON.stringify(body ?? {}),
  });
  const waits = [];
  const started = Date.now();
  const res = await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
  const ms = Date.now() - started;
  await Promise.all(waits);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text, ms };
}

export async function runCron(env) {
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}

// ---------- capturing logs ----------
export function captureLogs() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(" "));
  return { lines, stop: () => { console.log = orig; } };
}

// ---------- helpers ----------
export function tokenFrom(message, which) {
  const re = which === "confirm" ? /\/confirm\/#t=([A-Za-z0-9_-]+)/ : /\/off\/#d=([A-Za-z0-9_-]+)/;
  const m = message.text.match(re);
  return m && m[1];
}

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

// Sets up an active family with a named owner; returns { familyId, ownerJwt, ownerSub, operatorJwt }.
export async function setupFamily(env, clock, { name = "Dana", ownerSub = "owner-" + Math.random().toString(36).slice(2) } = {}) {
  const operatorJwt = await signJwt(accessClaims("operator", "tomer-sub", clock.t, { exp: Math.floor(clock.t / 1000) + 365 * 86400 }));
  const created = await call(env, "/api/operator/family/create", {}, { jwt: operatorJwt });
  const familyId = created.body.familyId;
  const enrol = await call(env, "/api/operator/family/enrolment-code", { familyId }, { jwt: operatorJwt });
  const ownerJwt = await signJwt(accessClaims("family", ownerSub, clock.t, { exp: Math.floor(clock.t / 1000) + 365 * 86400 }));
  const enrolled = await call(env, "/api/family/enrol", { code: enrol.body.code }, { jwt: ownerJwt });
  if (!enrolled.body.ok) throw new Error("enrol failed");
  if (name) await call(env, "/api/family/name", { name }, { jwt: ownerJwt });
  return { familyId, ownerJwt, ownerSub, operatorJwt };
}

// A barrier: the first `n` statements matching `pattern` wait until all n have arrived.
export function barrier(env, pattern, n = 2) {
  let arrived = 0;
  let release;
  const all = new Promise((r) => { release = r; });
  env.DB.hook = async (sql) => {
    if (!pattern.test(sql) || arrived >= n) return;
    arrived += 1;
    if (arrived === n) release();
    await all;
  };
  return () => { env.DB.hook = null; return arrived; };
}

export async function mint(env, ownerJwt) {
  const r = await call(env, "/api/family/mint", {}, { jwt: ownerJwt });
  return r.body;
}
