// CISO rule 69 as tests (hard, rule 70). One `describe` per point.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DAY, HOUR, call, captureLogs, makeEnv, runCron, tokenFrom } from "./harness.mjs";
import { confirmMessage, deleteMessage, send, signV4 } from "../../worker/src/mail.js";
import { LIMITS } from "../../worker/src/limits.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".git") continue;
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

async function signupAndToken(env, mail, email, opts) {
  const before = mail.length;
  const r = await call(env, "/api/signup", { email }, opts);
  const m = mail.slice(before).find((x) => x.to === email);
  return { r, confirm: m && tokenFrom(m, "confirm"), del: m && tokenFrom(m, "delete") };
}

describe("69.1 own Worker and own D1, no MOM binding", () => {
  const toml = read("worker/wrangler.toml");
  it("no-mom-binding: exactly one binding, its own D1, and nothing else", () => {
    const bindingTables = toml.match(/^\[\[?[a-z0-9_.]+\]\]?$/gm) || [];
    assert.deepEqual(bindingTables.sort(), ["[[d1_databases]]", "[triggers]", "[vars]"].sort());
    assert.match(toml, /binding = "DB"/);
    assert.match(toml, /database_name = "ronna-site-waitlist"/);
    assert.equal((toml.match(/binding\s*=/g) || []).length, 1);
    const config = toml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").toLowerCase();
    assert.doesNotMatch(config, /(?<!\.)\bmom\b|mom-|tenant|service\s*=|kv_namespaces|queues|durable_objects|r2_buckets|services|analytics_engine|hyperdrive|vectorize|ai\]/);
  });
  it("reachable only through ronna.mom, default subdomain off", () => {
    assert.match(toml, /^workers_dev = false$/m);
    const patterns = [...toml.matchAll(/pattern = "([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(patterns, ["ronna.mom/api/*"]);
  });
  it("the Worker fetches only SES and Cloudflare Access certs", () => {
    const src = readdirSync(path.join(root, "worker/src")).map((f) => read(`worker/src/${f}`)).join("\n");
    // Every fetch call in the Worker, by its URL template. Exactly two exist.
    const calls = [...src.matchAll(/(?<!async )\bfetch(?:Impl)?\(([^,)]*)/g)].map((m) => m[1].trim()); // not the Worker's own fetch handler
    assert.deepEqual(calls.sort(), [
      "`https://${host}/v2/email/outbound-emails`", // Amazon SES (host = email.<region>.amazonaws.com)
      "`https://${team}/cdn-cgi/access/certs`",     // Cloudflare Access signing keys
    ].sort());
    assert.match(src, /const host = `email\.\$\{env\.SES_REGION\}\.amazonaws\.com`/);
    assert.doesNotMatch(src.toLowerCase(), /\bmom-tenant|tenant-0/);
  });
});

describe("69.2 per row only email, status and times; no name, IP or user agent", () => {
  it("signups has rule 69's four columns plus rule 72.9's two", () => {
    const { env } = makeEnv();
    const cols = env.DB.rows("PRAGMA table_info(signups)").map((c) => c.name);
    assert.deepEqual(cols, ["email", "status", "created_at", "confirmed_at", "invited_by_family_id", "invite_code_id"]);
  });
  it("no IP, user agent or name is stored anywhere after a signup", async () => {
    const { env } = makeEnv();
    await call(env, "/api/signup", { email: "row@example.com", name: "Ignored Person" }, { ip: "198.51.100.23" });
    const dump = env.DB.dump();
    assert.ok(!dump.includes("198.51.100.23"));
    assert.ok(!dump.includes("unique-ua-marker"));
    assert.ok(!dump.includes("Ignored Person"));
    assert.ok(dump.includes("row@example.com"));
  });
});

describe("69.3 confirm token", () => {
  it("is 256 bits (≥128), and only its hash is stored", async () => {
    const { env, mail } = makeEnv();
    const { confirm } = await signupAndToken(env, mail, "tok@example.com");
    assert.equal(Buffer.from(confirm, "base64url").length, 32);
    assert.ok(!env.DB.dump().includes(confirm));
  });
  it("expires after 24 hours", async () => {
    const { env, mail, clock } = makeEnv();
    const { confirm } = await signupAndToken(env, mail, "late@example.com");
    clock.t += 24 * HOUR + 1;
    const r = await call(env, "/api/confirm", { token: confirm });
    assert.equal(r.body.ok, false);
  });
  it("works once only, even when used twice at once", async () => {
    const { env, mail } = makeEnv();
    const { confirm } = await signupAndToken(env, mail, "once@example.com");
    const [a, b] = await Promise.all([call(env, "/api/confirm", { token: confirm }), call(env, "/api/confirm", { token: confirm })]);
    assert.equal([a.body.ok, b.body.ok].filter(Boolean).length, 1);
    const again = await call(env, "/api/confirm", { token: confirm });
    assert.equal(again.body.ok, false);
    assert.equal(env.DB.rows("SELECT status FROM signups")[0].status, "confirmed");
  });
  it("unconfirmed rows are deleted after 7 days, with their tokens", async () => {
    const { env, mail, clock } = makeEnv();
    await signupAndToken(env, mail, "gone@example.com");
    clock.t += 7 * DAY - 1000;
    await runCron(env);
    assert.equal(env.DB.rows("SELECT * FROM signups").length, 1);
    clock.t += 2000;
    await runCron(env);
    assert.equal(env.DB.rows("SELECT * FROM signups").length, 0);
    assert.equal(env.DB.rows("SELECT * FROM tokens").length, 0);
  });
});

describe("69.4 same answer every time", () => {
  it("new, pending, confirmed, plausible-but-undeliverable, limited and capped all get the same reply", async () => {
    const { env, mail } = makeEnv({ minReplyMs: 150 });
    const { confirm } = await signupAndToken(env, mail, "known@example.com", { ip: "192.0.2.1" });
    await call(env, "/api/confirm", { token: confirm });
    const replies = [];
    replies.push(await call(env, "/api/signup", { email: "fresh@example.com" }, { ip: "192.0.2.2" }));
    replies.push(await call(env, "/api/signup", { email: "fresh@example.com" }, { ip: "192.0.2.3" })); // pending
    replies.push(await call(env, "/api/signup", { email: "known@example.com" }, { ip: "192.0.2.4" })); // confirmed
    replies.push(await call(env, "/api/signup", { email: "nobody@no-such-domain.invalid" }, { ip: "192.0.2.5" }));
    for (let i = 0; i < LIMITS.signupPerIpHour; i++) await call(env, "/api/signup", { email: `x${i}@example.com` }, { ip: "192.0.2.6" });
    replies.push(await call(env, "/api/signup", { email: "limited@example.com" }, { ip: "192.0.2.6" })); // limited
    for (const r of replies) {
      assert.equal(r.status, 202);
      assert.equal(r.text, JSON.stringify({ ok: true }));
    }
    const times = replies.map((r) => r.ms);
    assert.ok(Math.min(...times) >= 145, `floor held: ${times}`);
    assert.ok(Math.max(...times) - Math.min(...times) < 80, `timing spread: ${times}`);
    assert.equal(mail.filter((m) => m.to === "known@example.com").length, 1); // nothing sent to a confirmed address
  });
  it("delete-request replies the same whether or not the address is on the list", async () => {
    const { env, mail } = makeEnv();
    await signupAndToken(env, mail, "on@example.com");
    const a = await call(env, "/api/delete-request", { email: "on@example.com" }, { ip: "192.0.2.9" });
    const b = await call(env, "/api/delete-request", { email: "off@example.com" }, { ip: "192.0.2.10" });
    assert.equal(a.status, b.status);
    assert.equal(a.text, b.text);
  });
});

describe("69.5 one email service, key never in the repo, plain mail with a delete link", () => {
  it("emails carry plain links to ronna.mom only, no images or tracking, and a one-click delete link", () => {
    for (const m of [confirmMessage("a@example.com", "T".repeat(43), "D".repeat(43)), deleteMessage("a@example.com", "D".repeat(43))]) {
      assert.doesNotMatch(m.html, /<img|<script|<link|pixel|track|utm_|style=["'][^"']*url\(/i);
      const links = [...(m.text + m.html).matchAll(/https?:\/\/[^\s"<]+/g)].map((x) => x[0]);
      for (const l of links) assert.match(l, /^https:\/\/ronna\.mom\//);
      assert.match(m.text, /https:\/\/ronna\.mom\/off\/#d=D{43}/);
    }
  });
  it("names no SES configuration set, so SES can't add tracking", () => {
    assert.doesNotMatch(read("worker/src/mail.js"), /ConfigurationSetName/);
  });
  it("sends nothing without the Worker secrets (nothing is live)", async () => {
    const logs = captureLogs();
    try {
      await send({ SES_REGION: "eu-west-1", MAIL_FROM: "x@y.z" }, confirmMessage("a@example.com", "t", "d"));
    } finally {
      logs.stop();
    }
    assert.ok(logs.lines.some((l) => l.includes("send.disabled")));
  });
  it("no key in the repo: no AWS key IDs or secrets anywhere, and wrangler.toml lists the secrets by name only", () => {
    const files = walk(root).filter((f) => /\.(js|mjs|py|toml|json|md|html|css|sql|txt)$/.test(f) && !f.includes("package-lock"));
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      assert.doesNotMatch(text, /\bAKIA[0-9A-Z]{16}\b/, f);
      assert.doesNotMatch(text, /SES_SECRET_ACCESS_KEY\s*=\s*"/, f);
    }
  });
  it("SigV4 signing matches AWS's published get-vanilla vector", async () => {
    // AWS's documented example credentials, not a real key.
    const h = await signV4({
      method: "GET", host: "example.amazonaws.com", path: "/", query: "", headers: {}, body: "",
      region: "us-east-1", service: "service", accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", date: new Date("2015-08-30T12:36:00Z"),
    });
    assert.match(h.authorization, /Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31$/);
  });
});

describe("69.6 rate limits on a salted IP hash, counters only, plus a global cap", () => {
  it("a sixth signup from one IP in an hour sends nothing", async () => {
    const { env, mail } = makeEnv();
    for (let i = 0; i < LIMITS.signupPerIpHour; i++) await call(env, "/api/signup", { email: `r${i}@example.com` }, { ip: "192.0.2.50" });
    assert.equal(mail.length, LIMITS.signupPerIpHour);
    await call(env, "/api/signup", { email: "r-extra@example.com" }, { ip: "192.0.2.50" });
    assert.equal(mail.length, LIMITS.signupPerIpHour);
  });
  it("the salt is random per day and yesterday's goes; only hashes and counts are kept", async () => {
    const { env, clock } = makeEnv();
    await call(env, "/api/signup", { email: "s1@example.com" }, { ip: "192.0.2.60" });
    const day1 = env.DB.rows("SELECT subject FROM counters WHERE name = 'signup_ip'")[0].subject;
    clock.t += DAY;
    await runCron(env);
    assert.equal(env.DB.rows("SELECT * FROM salts").length, 0);
    await call(env, "/api/signup", { email: "s2@example.com" }, { ip: "192.0.2.60" });
    const day2 = env.DB.rows("SELECT subject FROM counters WHERE name = 'signup_ip'").map((r) => r.subject);
    assert.ok(!day2.includes(day1));
    assert.match(day2[0], /^[0-9a-f]{64}$/);
    assert.ok(!env.DB.dump().includes("192.0.2.60"));
  });
  it("a global cap stops confirm emails for the day", async () => {
    const { env, mail } = makeEnv();
    for (let i = 0; i <= LIMITS.signupEmailsPerDay; i++) {
      await call(env, "/api/signup", { email: `cap${i}@example.com` }, { ip: `10.0.${Math.floor(i / 250)}.${i % 250}` });
    }
    assert.equal(mail.length, LIMITS.signupEmailsPerDay);
  });
});

describe("69.7 logs hold counts and error kinds only", () => {
  it("logs-clean: no email, token or IP in any log line", async () => {
    const { env, mail } = makeEnv();
    const logs = captureLogs();
    try {
      const { confirm, del } = await signupAndToken(env, mail, "secret-person@example.com", { ip: "198.51.100.77" });
      await call(env, "/api/confirm", { token: confirm });
      await call(env, "/api/confirm", { token: "bogus-token-value-123456789" });
      await call(env, "/api/delete-request", { email: "secret-person@example.com" }, { ip: "198.51.100.77" });
      await call(env, "/api/delete", { token: del });
      await call(env, "/api/signup", { email: "not an email" });
      var tokens = [confirm, del];
    } finally {
      logs.stop();
    }
    const all = logs.lines.join("\n");
    for (const needle of ["secret-person", "198.51.100.77", ...tokens]) assert.ok(!all.includes(needle), needle);
    for (const line of logs.lines) {
      const o = JSON.parse(line);
      assert.ok(Object.keys(o).every((k) => k === "event" || k === "kind"));
      assert.notEqual(o.event, "log.refused");
    }
  });
});

describe("69.9 deletion", () => {
  it("the delete link removes the row and its tokens at once", async () => {
    const { env, mail } = makeEnv();
    const { del } = await signupAndToken(env, mail, "bye@example.com");
    const r = await call(env, "/api/delete", { token: del });
    assert.equal(r.body.ok, true);
    assert.equal(env.DB.rows("SELECT * FROM signups").length, 0);
    assert.equal(env.DB.rows("SELECT * FROM tokens").length, 0);
  });
  it("a reply asking for deletion is done by hand through the operator route", async () => {
    const { env, mail, clock } = makeEnv();
    await signupAndToken(env, mail, "byhand@example.com");
    const { accessClaims, signJwt } = await import("./harness.mjs");
    const jwt = await signJwt(accessClaims("operator", "tomer-sub", clock.t));
    await call(env, "/api/operator/delete", { email: "ByHand@Example.com " }, { jwt });
    assert.equal(env.DB.rows("SELECT * FROM signups").length, 0);
  });
});

describe("requests: JSON POST from ronna.mom only", () => {
  it("refuses other origins, other methods, other content types and big bodies", async () => {
    const { env } = makeEnv();
    assert.equal((await call(env, "/api/signup", { email: "a@example.com" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await call(env, "/api/signup", null, { method: "GET" })).status, 405);
    assert.equal((await call(env, "/api/signup", null, { contentType: "text/plain", rawBody: "email=a@example.com" })).status, 415);
    assert.equal((await call(env, "/api/signup", null, { rawBody: JSON.stringify({ email: "a@example.com", pad: "x".repeat(3000) }) })).status, 413);
    assert.equal(env.DB.rows("SELECT * FROM signups").length, 0);
  });
});
