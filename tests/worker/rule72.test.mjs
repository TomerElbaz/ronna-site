// CISO rules 72 and 74 as tests (hard, rule 70): docs/SIGNUP_DESIGN.md §12.10.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAY, HOUR, accessClaims, barrier, call, captureLogs, makeEnv, mint, runCron, setupFamily, signJwt, tokenFrom,
} from "./harness.mjs";
import { LIMITS } from "../../worker/src/limits.js";
import { normaliseCode } from "../../worker/src/util.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readdirSync(path.join(root, "worker/src")).map((f) => readFileSync(path.join(root, "worker/src", f), "utf8")).join("\n");
const BAD = JSON.stringify({ ok: false, message: "This invite isn't valid." });
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

async function redeem(env, code, email, ip = "203.0.113.50") {
  return call(env, "/api/invite/redeem", { code, email }, { ip });
}
async function lookup(env, code, ip = "203.0.113.51") {
  return call(env, "/api/invite/lookup", { code }, { ip });
}
async function confirmFor(env, mail, email) {
  const m = [...mail].reverse().find((x) => x.to === email);
  return call(env, "/api/confirm", { token: tokenFrom(m, "confirm") });
}
const signupRow = (env, email) => env.DB.rows("SELECT * FROM signups WHERE email = ?", email)[0];
const codeRow = (env, id) => env.DB.rows("SELECT * FROM invite_codes WHERE code_id = ?", id)[0];

describe("72.1 / 74.1 minting is for owners of active families, behind Access", () => {
  it("mint-requires-access-jwt: no token, a forged one, a wrong audience or an expired one is refused", async () => {
    const { env, clock } = makeEnv();
    await setupFamily(env, clock, { ownerSub: "owner-a" });
    const t = clock.t;
    const cases = [
      undefined,
      await signJwt(accessClaims("family", "owner-a", t), { forged: true }),
      await signJwt(accessClaims("family", "owner-a", t, { aud: ["some-other-app"] })),
      await signJwt(accessClaims("family", "owner-a", t, { exp: Math.floor(t / 1000) - 3600 })),
      await signJwt(accessClaims("family", "owner-a", t, { iss: "https://elsewhere.cloudflareaccess.com" })),
      await signJwt(accessClaims("family", "owner-a", t), { kid: "unknown-kid" }),
      "not.a.jwt",
    ];
    for (const jwt of cases) assert.equal((await call(env, "/api/family/mint", {}, { jwt })).status, 403);
    assert.equal(env.DB.rows("SELECT * FROM invite_codes").length, 0);
  });
  it("74.1: an operator token is refused on a family route, and a family token on an operator route", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt, operatorJwt, familyId } = await setupFamily(env, clock);
    assert.equal((await call(env, "/api/family/mint", {}, { jwt: operatorJwt })).status, 403);
    assert.equal((await call(env, "/api/family/status", {}, { jwt: operatorJwt })).status, 403);
    assert.equal((await call(env, "/api/operator/family/create", {}, { jwt: ownerJwt })).status, 403);
    assert.equal((await call(env, "/api/operator/family/leave", { familyId }, { jwt: ownerJwt })).status, 403);
    assert.equal((await call(env, "/api/operator/family/enrolment-code", { familyId }, { jwt: ownerJwt })).status, 403);
  });
  it("mint-requires-active-family: an unknown Access user, or a family that left, can't mint", async () => {
    const { env, clock } = makeEnv();
    const stranger = await signJwt(accessClaims("family", "nobody", clock.t));
    assert.equal((await call(env, "/api/family/mint", {}, { jwt: stranger })).body.enrolled, false);
    const { ownerJwt, operatorJwt, familyId } = await setupFamily(env, clock);
    await call(env, "/api/operator/family/leave", { familyId }, { jwt: operatorJwt });
    const r = await call(env, "/api/family/mint", {}, { jwt: ownerJwt });
    assert.equal(r.body.code, undefined);
    assert.equal(env.DB.rows("SELECT * FROM invite_codes").length, 0);
  });
  it("mint-sixth-refused: five live codes, a sixth refused, even with six clicks at once", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const results = await Promise.all(Array.from({ length: 6 }, () => mint(env, ownerJwt)));
    assert.equal(results.filter((r) => r.ok).length, 5);
    assert.equal(results.filter((r) => !r.ok && r.error === "cap").length, 1);
    assert.equal((await mint(env, ownerJwt)).error, "cap");
  });
  it("74.1 enrolment codes: rule 72's format, hash only, 7 days, single use, at most 2 owners", async () => {
    const { env, clock } = makeEnv();
    const op = await signJwt(accessClaims("operator", "tomer-sub", clock.t, { exp: Math.floor(clock.t / 1000) + 30 * 86400 }));
    const familyId = (await call(env, "/api/operator/family/create", {}, { jwt: op })).body.familyId;
    assert.match(familyId, /^fam_[0-9A-HJKMNP-TV-Z]{16}$/);
    const owner = async (sub) => signJwt(accessClaims("family", sub, clock.t, { exp: Math.floor(clock.t / 1000) + 30 * 86400 }));
    const code1 = (await call(env, "/api/operator/family/enrolment-code", { familyId }, { jwt: op })).body.code;
    assert.match(code1, CODE_RE);
    assert.ok(!env.DB.dump().includes(code1) && !env.DB.dump().includes(normaliseCode(code1)));
    // single use, even with two owners racing
    const [a, b] = await Promise.all([
      call(env, "/api/family/enrol", { code: code1 }, { jwt: await owner("o1") }),
      call(env, "/api/family/enrol", { code: code1 }, { jwt: await owner("o2") }),
    ]);
    assert.equal([a.body.ok, b.body.ok].filter(Boolean).length, 1);
    // second owner with a fresh code
    const code2 = (await call(env, "/api/operator/family/enrolment-code", { familyId }, { jwt: op })).body.code;
    const second = a.body.ok ? "o2" : "o1";
    assert.equal((await call(env, "/api/family/enrol", { code: code2 }, { jwt: await owner(second) })).body.ok, true);
    // a third owner is refused
    const code3 = (await call(env, "/api/operator/family/enrolment-code", { familyId }, { jwt: op })).body.code;
    assert.equal((await call(env, "/api/family/enrol", { code: code3 }, { jwt: await owner("o3") })).body.ok, false);
    // expiry after 7 days
    const fam2 = (await call(env, "/api/operator/family/create", {}, { jwt: op })).body.familyId;
    const late = (await call(env, "/api/operator/family/enrolment-code", { familyId: fam2 }, { jwt: op })).body.code;
    clock.t += 7 * DAY + 1;
    assert.equal((await call(env, "/api/family/enrol", { code: late }, { jwt: await owner("o4") })).body.ok, false);
    assert.equal(env.DB.rows("SELECT * FROM family_owners WHERE family_id = ?", familyId).length, 2);
  });
  it("74.1: the owner link is the verified JWT's sub, stored as is; no email is stored for owners", async () => {
    const { env, clock } = makeEnv();
    const { familyId } = await setupFamily(env, clock, { ownerSub: "access-sub-123" });
    assert.deepEqual(env.DB.rows("SELECT * FROM family_owners"), [{ family_id: familyId, owner_access_id: "access-sub-123" }]);
    assert.doesNotMatch(env.DB.dump(), /@/);
  });
  it("74.3: 20 mints a day per owner, then refused", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    let ok = 0;
    for (let i = 0; i < LIMITS.mintsPerOwnerDay; i++) {
      const r = await mint(env, ownerJwt);
      if (r.ok) ok++;
      await call(env, "/api/family/revoke", { id: r.id }, { jwt: ownerJwt });
    }
    assert.equal(ok, 20);
    assert.equal((await mint(env, ownerJwt)).error, "daily");
    clock.t += DAY;
    assert.equal((await mint(env, ownerJwt)).ok, true);
  });
});

describe("72.2 the code", () => {
  it("code-shape: 16 Crockford base32 characters in groups of 4, from 80 random bits", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await mint(env, ownerJwt)).code);
    for (const c of codes) assert.match(c, CODE_RE);
    assert.equal(new Set(codes).size, 5);
    assert.match(src, /export function newCode\(\) \{\n  const raw = crockford\(randomBytes\(10\)\);/);
    assert.match(src, /crypto\.getRandomValues\(out\)/);
  });
  it("code-hash-only: the database holds the hash, never the code", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const { code } = await mint(env, ownerJwt);
    const dump = env.DB.dump();
    for (const form of [code, normaliseCode(code), code.toLowerCase()]) assert.ok(!dump.includes(form));
    assert.match(env.DB.rows("SELECT code_hash FROM invite_codes")[0].code_hash, /^[0-9a-f]{64}$/);
  });
  it("code-shown-once: only the mint response carries the code", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const { code } = await mint(env, ownerJwt);
    const status = await call(env, "/api/family/status", {}, { jwt: ownerJwt });
    assert.ok(!status.text.includes(code) && !status.text.includes(normaliseCode(code)));
  });
});

describe("72.3 the code never travels in a URL", () => {
  it("no-route-reads-code-from-url: the Worker never reads a query string, and a code in the URL is ignored", async () => {
    assert.doesNotMatch(src, /searchParams|\.search\b|location\./);
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const { code } = await mint(env, ownerJwt);
    const r = await call(env, "/api/invite/lookup", {}, { query: `?code=${code}` });
    assert.equal(r.text, BAD);
  });
});

describe("72.4 / 74.5 the invite page shows 'Invited by' and a first name, nothing else", () => {
  it("invite-shows-only-first-name: lookup returns only the chosen first name", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock, { name: "O'Neil" });
    const { code } = await mint(env, ownerJwt);
    const r = await lookup(env, code);
    assert.deepEqual(r.body, { ok: true, invitedBy: "O'Neil" });
  });
  it("display names: one word, letters plus - and ', at most 20 characters", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock, { name: null });
    for (const bad of ["Dana Smith", "D".repeat(21), "Dana2", "<b>Dana</b>", "", "Da na", "-Dana", "Dana!"]) {
      assert.equal((await call(env, "/api/family/name", { name: bad }, { jwt: ownerJwt })).status, 400, bad);
    }
    for (const good of ["Dana", "Anne-Marie", "D'Arcy", "Zoë", "A".repeat(20)]) {
      assert.equal((await call(env, "/api/family/name", { name: good }, { jwt: ownerJwt })).body.ok, true, good);
    }
  });
  it("a family must choose a name before it can mint", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock, { name: null });
    assert.equal((await mint(env, ownerJwt)).error, "name");
  });
});

describe("72.5 one reply for every bad code", () => {
  it("bad-code-one-reply: wrong, malformed, expired, revoked, used, reserved, locked and capped get the same status, body and timing", async () => {
    const { env, clock, mail } = makeEnv({ minReplyMs: 150 });
    const { ownerJwt } = await setupFamily(env, clock);
    const expired = (await mint(env, ownerJwt)).code;
    clock.t += 31 * DAY; // now it is expired; everything else is minted after
    const revoked = await mint(env, ownerJwt);
    await call(env, "/api/family/revoke", { id: revoked.id }, { jwt: ownerJwt });
    const used = (await mint(env, ownerJwt)).code;
    await redeem(env, used, "user@example.com", "198.51.100.1");
    await confirmFor(env, mail, "user@example.com");
    const reserved = (await mint(env, ownerJwt)).code;
    await redeem(env, reserved, "holder@example.com", "198.51.100.2");
    const valid = (await mint(env, ownerJwt)).code;

    const replies = [];
    const ip = (i) => `198.51.100.${10 + i}`;
    const cases = ["ZZZZ-ZZZZ-ZZZZ-ZZZZ", "not-a-code", expired, revoked.code, used, reserved];
    for (const [i, c] of cases.entries()) {
      replies.push(await lookup(env, c, ip(i)));
      replies.push(await redeem(env, c, `x${i}@example.com`, ip(i)));
    }
    // locked: 10 failures from one IP hash, then even a valid code gets the same reply
    for (let i = 0; i < LIMITS.inviteFailuresToLock; i++) await lookup(env, "ZZZZ-ZZZZ-ZZZZ-ZZZ" + (i % 10), "198.51.100.99");
    replies.push(await lookup(env, valid, "198.51.100.99"));
    for (const r of replies) {
      assert.equal(r.status, 200);
      assert.equal(r.text, BAD);
    }
    const times = replies.map((r) => r.ms);
    assert.ok(Math.min(...times) >= 145 && Math.max(...times) - Math.min(...times) < 80, `timing: ${times}`);
    assert.deepEqual((await lookup(env, valid, "198.51.100.200")).body, { ok: true, invitedBy: "Dana" });
  });
});

describe("72.6 / 74.4 reserve on submit, spend at /confirm/", () => {
  it("reserve-one-wins: two people submit the same code at once; exactly one reserves it", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const { code } = await mint(env, ownerJwt);
    // Hold both requests at the reserve statement, so both are past the read check
    // and only the statement's own guard can decide.
    const done = barrier(env, /^UPDATE invite_codes SET status = 'reserved'/);
    const [a, b] = await Promise.all([redeem(env, code, "a@example.com", "192.0.2.1"), redeem(env, code, "b@example.com", "192.0.2.2")]);
    assert.equal(done(), 2, "both requests reached the reserve statement together");
    assert.deepEqual([a.status, b.status].sort(), [200, 202]);
    assert.equal(env.DB.rows("SELECT * FROM signups WHERE invite_code_id IS NOT NULL").length, 1);
  });
  it("spend-one-wins: the code is spent only at confirm, once, atomically", async () => {
    const { env, clock, mail } = makeEnv();
    const { ownerJwt, familyId } = await setupFamily(env, clock);
    const { code, id } = await mint(env, ownerJwt);
    await redeem(env, code, "inv@example.com");
    assert.equal(codeRow(env, id).status, "reserved");
    const token = tokenFrom(mail.at(-1), "confirm");
    const [x, y] = await Promise.all([call(env, "/api/confirm", { token }), call(env, "/api/confirm", { token })]);
    assert.equal([x.body.ok, y.body.ok].filter(Boolean).length, 1);
    assert.equal(codeRow(env, id).status, "used");
    assert.equal(signupRow(env, "inv@example.com").invited_by_family_id, familyId);
    assert.equal(signupRow(env, "inv@example.com").invite_code_id, id);
  });
  it("reservation-lapses: unconfirmed after 24 h, the code can be reserved again; the late one joins without the mark", async () => {
    const { env, clock, mail } = makeEnv();
    const { ownerJwt, familyId } = await setupFamily(env, clock);
    const { code, id } = await mint(env, ownerJwt);
    await redeem(env, code, "slow@example.com", "192.0.2.10");
    clock.t += 24 * HOUR + 1000;
    assert.equal((await redeem(env, code, "quick@example.com", "192.0.2.11")).status, 202);
    assert.equal(signupRow(env, "slow@example.com").invite_code_id, null);
    await confirmFor(env, mail, "quick@example.com");
    assert.equal(signupRow(env, "quick@example.com").invited_by_family_id, familyId);
    assert.equal(codeRow(env, id).status, "used");
    // the slow one asks for a new link and confirms: on the list, no mark
    await call(env, "/api/signup", { email: "slow@example.com" }, { ip: "192.0.2.12" });
    assert.equal((await confirmFor(env, mail, "slow@example.com")).body.ok, true);
    assert.equal(signupRow(env, "slow@example.com").status, "confirmed");
    assert.equal(signupRow(env, "slow@example.com").invited_by_family_id, null);
  });
  it("the daily run releases lapsed reservations", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const { code, id } = await mint(env, ownerJwt);
    await redeem(env, code, "lapse@example.com");
    clock.t += 25 * HOUR;
    await runCron(env);
    assert.equal(codeRow(env, id).status, "unused");
    assert.equal(signupRow(env, "lapse@example.com").invite_code_id, null);
  });
  it("74.4: a reserved code revoked before confirmation: the person joins without the mark", async () => {
    const { env, clock, mail } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const { code, id } = await mint(env, ownerJwt);
    await redeem(env, code, "rev@example.com");
    await call(env, "/api/family/revoke", { id }, { jwt: ownerJwt });
    const r = await confirmFor(env, mail, "rev@example.com");
    assert.equal(r.body.ok, true);
    const row = signupRow(env, "rev@example.com");
    assert.equal(row.status, "confirmed");
    assert.equal(row.invited_by_family_id, null);
    assert.equal(row.invite_code_id, null);
    assert.equal(codeRow(env, id).status, "revoked");
  });
  it("an address already on the list reserves nothing and gets the same answer", async () => {
    const { env, clock, mail } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    await call(env, "/api/signup", { email: "member@example.com" });
    await confirmFor(env, mail, "member@example.com");
    const { code, id } = await mint(env, ownerJwt);
    const r = await redeem(env, code, "member@example.com");
    assert.equal(r.status, 202);
    assert.equal(r.text, JSON.stringify({ ok: true }));
    assert.equal(codeRow(env, id).status, "unused");
  });
});

describe("72.7 expiry and revoking", () => {
  it("expiry-30-days", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const { code } = await mint(env, ownerJwt);
    clock.t += 30 * DAY - 1000;
    assert.equal((await lookup(env, code)).body.ok, true);
    clock.t += 2000;
    assert.equal((await lookup(env, code, "203.0.113.90")).text, BAD);
  });
  it("revoke-at-once, by the owner and by Tomer", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt, operatorJwt } = await setupFamily(env, clock);
    const a = await mint(env, ownerJwt);
    const b = await mint(env, ownerJwt);
    await call(env, "/api/family/revoke", { id: a.id }, { jwt: ownerJwt });
    await call(env, "/api/operator/revoke", { codeId: b.id }, { jwt: operatorJwt });
    assert.equal((await lookup(env, a.code, "203.0.113.91")).text, BAD);
    assert.equal((await lookup(env, b.code, "203.0.113.92")).text, BAD);
  });
  it("an owner can't revoke another family's code", async () => {
    const { env, clock } = makeEnv();
    const one = await setupFamily(env, clock, { ownerSub: "fam-one" });
    const two = await setupFamily(env, clock, { ownerSub: "fam-two" });
    const c = await mint(env, one.ownerJwt);
    assert.equal((await call(env, "/api/family/revoke", { id: c.id }, { jwt: two.ownerJwt })).body.ok, false);
    assert.equal((await lookup(env, c.code)).body.ok, true);
  });
});

describe("72.8 / 74.3 rate limits", () => {
  it("rate-10-an-hour per salted IP hash on invite routes", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const { code } = await mint(env, ownerJwt);
    for (let i = 0; i < LIMITS.invitePerIpHour; i++) assert.equal((await lookup(env, code, "192.0.2.77")).body.ok, true);
    assert.equal((await lookup(env, code, "192.0.2.77")).text, BAD);
    assert.equal((await lookup(env, code, "192.0.2.78")).body.ok, true);
    clock.t += HOUR;
    assert.equal((await lookup(env, code, "192.0.2.77")).body.ok, true);
  });
  it("the lock lasts a full hour from the tenth failure, past the hourly reset", async () => {
    const { env, clock } = makeEnv({ start: Date.UTC(2026, 9, 9, 10, 55, 0) });
    const { ownerJwt } = await setupFamily(env, clock);
    const { code } = await mint(env, ownerJwt);
    for (let i = 0; i < LIMITS.inviteFailuresToLock; i++) await lookup(env, "ZZZZ-ZZZZ-ZZZZ-ZZZZ", "192.0.2.95");
    clock.t = Date.UTC(2026, 9, 9, 11, 5, 0); // new clock hour: the 10-an-hour allowance has reset
    assert.equal((await lookup(env, code, "192.0.2.95")).text, BAD); // still locked, same reply
    clock.t = Date.UTC(2026, 9, 9, 11, 55, 1);
    assert.equal((await lookup(env, code, "192.0.2.95")).body.ok, true); // an hour on, the lock is gone
  });
  it("lock-after-10-failures, for the hour, invisibly", async () => {
    const { env, clock } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const { code } = await mint(env, ownerJwt);
    for (let i = 0; i < LIMITS.inviteFailuresToLock - 1; i++) await lookup(env, "ZZZZ-ZZZZ-ZZZZ-ZZZZ", "192.0.2.88");
    assert.equal((await lookup(env, code, "192.0.2.88")).body.ok, true); // 9 failures: not yet
    clock.t += HOUR; // new hour, counts reset
    for (let i = 0; i < LIMITS.inviteFailuresToLock; i++) await lookup(env, "ZZZZ-ZZZZ-ZZZZ-ZZZZ", "192.0.2.88");
    assert.equal((await lookup(env, code, "192.0.2.88")).text, BAD); // locked, same reply
    assert.equal((await lookup(env, code, "192.0.2.89")).body.ok, true); // others unaffected
    clock.t += HOUR;
    assert.equal((await lookup(env, code, "192.0.2.88")).body.ok, true); // lock lasts the hour
  });
  it("global-cap: 200 redeems a day site-wide", async () => {
    const { env, clock } = makeEnv();
    const owners = [];
    for (let f = 0; f < 41; f++) owners.push(await setupFamily(env, clock, { ownerSub: `cap-owner-${f}` }));
    let accepted = 0;
    let n = 0;
    for (const o of owners) {
      for (let k = 0; k < 5; k++) {
        const { code } = await mint(env, o.ownerJwt);
        const r = await redeem(env, code, `cap${n}@example.com`, `10.1.${Math.floor(n / 200)}.${n % 200}`);
        if (r.status === 202) accepted++;
        n++;
      }
    }
    assert.equal(accepted, LIMITS.redeemsPerDay);
  });
});

describe("72.9 what is stored, and what the inviter sees", () => {
  it("inviter-sees-used-unused-only: never an invitee's email or detail", async () => {
    const { env, clock, mail } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const a = await mint(env, ownerJwt);
    const b = await mint(env, ownerJwt);
    await redeem(env, a.code, "invitee-one@example.com");
    await confirmFor(env, mail, "invitee-one@example.com");
    await redeem(env, b.code, "invitee-two@example.com", "203.0.113.60"); // reserved shows as unused
    const r = await call(env, "/api/family/status", {}, { jwt: ownerJwt });
    assert.doesNotMatch(r.text, /@|invitee/);
    const states = Object.fromEntries(r.body.codes.map((c) => [c.id, c.state]));
    assert.equal(states[a.id], "used");
    assert.equal(states[b.id], "unused");
    for (const c of r.body.codes) assert.deepEqual(Object.keys(c).sort(), ["expiresAt", "id", "state"]);
  });
  it("tables hold only rule 72.9's fields (plus rule 74.1's owner link)", () => {
    const { env } = makeEnv();
    const cols = (t) => env.DB.rows(`PRAGMA table_info(${t})`).map((c) => c.name);
    assert.deepEqual(cols("families"), ["family_id", "display_first_name", "status", "created_at", "left_at"]);
    assert.deepEqual(cols("family_owners"), ["family_id", "owner_access_id"]);
    assert.deepEqual(cols("invite_codes"), ["code_id", "code_hash", "family_id", "status", "created_at", "expires_at", "reserved_until", "used_at", "revoked_at"]);
    assert.deepEqual(cols("enrolment_codes"), ["code_hash", "family_id", "expires_at"]);
  });
});

describe("72.10 logs", () => {
  it("logs-clean: no code, hash, ID, email, IP or name in any log line", async () => {
    const { env, clock, mail } = makeEnv();
    const logs = captureLogs();
    let secrets = [];
    try {
      const { ownerJwt, familyId, operatorJwt } = await setupFamily(env, clock, { name: "Quentin", ownerSub: "sub-secret-1" });
      const m = await mint(env, ownerJwt);
      await lookup(env, m.code, "198.51.100.150");
      await redeem(env, m.code, "logcheck@example.com", "198.51.100.150");
      await confirmFor(env, mail, "logcheck@example.com");
      await lookup(env, "ZZZZ-ZZZZ-ZZZZ-ZZZZ", "198.51.100.150");
      await call(env, "/api/operator/family/leave", { familyId }, { jwt: operatorJwt });
      const hashes = env.DB.rows("SELECT code_hash FROM invite_codes").map((r) => r.code_hash);
      secrets = [m.code, normaliseCode(m.code), m.id, familyId, "Quentin", "logcheck", "198.51.100.150", "sub-secret-1", ...hashes];
    } finally {
      logs.stop();
    }
    const all = logs.lines.join("\n");
    for (const s of secrets) assert.ok(!all.includes(s), s);
    for (const line of logs.lines) assert.notEqual(JSON.parse(line).event, "log.refused");
  });
});

describe("72.11 / 74.1 deletion and families leaving", () => {
  it("invitee-delete-removes-link: the delete link removes the row and its invited-by link", async () => {
    const { env, clock, mail } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const { code, id } = await mint(env, ownerJwt);
    await redeem(env, code, "leaver@example.com");
    await confirmFor(env, mail, "leaver@example.com");
    const del = tokenFrom(mail.at(-1), "delete");
    assert.equal((await call(env, "/api/delete", { token: del })).body.ok, true);
    assert.equal(env.DB.rows("SELECT * FROM signups").length, 0);
    assert.doesNotMatch(env.DB.dump(), /leaver@example\.com/);
    assert.equal(codeRow(env, id).status, "used");
  });
  it("deleting a pending invitee releases the reserved code", async () => {
    const { env, clock, mail } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const { code, id } = await mint(env, ownerJwt);
    await redeem(env, code, "changed-mind@example.com");
    await call(env, "/api/delete", { token: tokenFrom(mail.at(-1), "delete") });
    assert.equal(codeRow(env, id).status, "unused");
  });
  it("family-leave-erases: unused codes revoked, display name and owners erased, invited-by emptied", async () => {
    const { env, clock, mail } = makeEnv();
    const { ownerJwt, operatorJwt, familyId } = await setupFamily(env, clock, { name: "Leaving" });
    const used = await mint(env, ownerJwt);
    const reserved = await mint(env, ownerJwt);
    const unused = await mint(env, ownerJwt);
    await redeem(env, used.code, "joined@example.com", "192.0.2.31");
    await confirmFor(env, mail, "joined@example.com");
    await redeem(env, reserved.code, "waiting@example.com", "192.0.2.32");
    await call(env, "/api/operator/family/leave", { familyId }, { jwt: operatorJwt });
    assert.equal(codeRow(env, unused.id).status, "revoked");
    assert.equal(codeRow(env, reserved.id).status, "revoked");
    const fam = env.DB.rows("SELECT * FROM families WHERE family_id = ?", familyId)[0];
    assert.equal(fam.status, "left");
    assert.equal(fam.display_first_name, null);
    assert.equal(env.DB.rows("SELECT * FROM family_owners WHERE family_id = ?", familyId).length, 0);
    assert.equal(env.DB.rows("SELECT * FROM signups WHERE invited_by_family_id = ?", familyId).length, 0);
    assert.doesNotMatch(env.DB.dump(), /Leaving/);
    // the waiting invitee can still confirm, without the mark
    assert.equal((await confirmFor(env, mail, "waiting@example.com")).body.ok, true);
    assert.equal(signupRow(env, "waiting@example.com").invited_by_family_id, null);
  });
});

describe("72.12 MOM sends no invitations; invites don't move anyone up", () => {
  it("invite-sends-no-email: minting and lookup send nothing; redeem mails only the invitee's own address", async () => {
    const { env, clock, mail } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    const { code } = await mint(env, ownerJwt);
    await lookup(env, code);
    assert.equal(mail.length, 0);
    await redeem(env, code, "self@example.com");
    assert.deepEqual(mail.map((m) => m.to), ["self@example.com"]);
    assert.doesNotMatch(mail[0].text, /invite|Dana/i);
  });
  it("place-ignores-invites: the place follows confirmation time only", async () => {
    const { env, clock, mail } = makeEnv();
    const { ownerJwt } = await setupFamily(env, clock);
    await call(env, "/api/signup", { email: "first@example.com" }, { ip: "192.0.2.41" });
    const { code } = await mint(env, ownerJwt);
    await redeem(env, code, "invited@example.com", "192.0.2.42");
    const p1 = await confirmFor(env, mail, "first@example.com");
    clock.t += 1000;
    const p2 = await confirmFor(env, mail, "invited@example.com");
    clock.t += 1000;
    await call(env, "/api/signup", { email: "third@example.com" }, { ip: "192.0.2.43" });
    const p3 = await confirmFor(env, mail, "third@example.com");
    assert.deepEqual([p1.body.place, p2.body.place, p3.body.place], [1, 2, 3]);
    assert.doesNotMatch(src, /invited_by_family_id[^;]*ORDER BY|ORDER BY[^;]*invited_by/);
  });
});
