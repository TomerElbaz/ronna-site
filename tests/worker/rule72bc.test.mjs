// CISO rules 72(b) and 72(c), member invite codes, as tests (hard, rule 70).
// The brief: docs/invite-codes-brief.md (cleared, CPO order w04). Rules 72 and
// 73 tests carry over unchanged in rule72.test.mjs and rule69.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DAY, HOUR, barrier, call, captureLogs, makeEnv, runCron, tokenFrom } from "./harness.mjs";
import { LIMITS } from "../../worker/src/limits.js";
import { codeHash, dayKey, normaliseCode } from "../../worker/src/util.js";

const BAD = JSON.stringify({ ok: false, message: "This invite isn't valid." });
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
let ipN = 0;
const freshIp = () => `198.51.${100 + Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

const lastMail = (mail, email) => [...mail].reverse().find((m) => m.to === email);
const signupRow = (env, email) => env.DB.rows("SELECT * FROM signups WHERE email = ?", email)[0];
const memberCodes = (env, email) => env.DB.rows("SELECT * FROM invite_codes WHERE member_email = ? ORDER BY created_at", email);

async function signup(env, email) {
  return call(env, "/api/signup", { email }, { ip: freshIp() });
}
async function confirmFor(env, mail, email) {
  return call(env, "/api/confirm", { token: tokenFrom(lastMail(mail, email), "confirm") }, { ip: freshIp() });
}
// A confirmed member: returns their codes (from the confirm reply) and delete token.
async function member(env, mail, email) {
  await signup(env, email);
  const del = tokenFrom(lastMail(mail, email), "delete");
  const r = await confirmFor(env, mail, email);
  assert.equal(r.body.ok, true);
  return { codes: r.body.codes, del, reply: r };
}
async function redeem(env, code, email, ip = freshIp()) {
  return call(env, "/api/invite/redeem", { code, email }, { ip });
}
async function lookup(env, code, ip = freshIp()) {
  return call(env, "/api/invite/lookup", { code }, { ip });
}

describe("72(b)(1), 72(c)(1) codes come only from the member's own confirm", () => {
  it("member-codes-at-confirm: three codes in rule 72's format, in the confirm reply, sent no-store", async () => {
    const { env, mail } = makeEnv();
    const s = await signup(env, "m@example.com");
    assert.equal(JSON.stringify(s.body), JSON.stringify({ ok: true }), "the signup reply carries no codes");
    assert.equal(env.DB.rows("SELECT * FROM invite_codes").length, 0, "nothing minted before confirm");
    const { codes, reply } = await member(env, mail, "m@example.com");
    assert.equal(codes.length, LIMITS.codesPerMember);
    assert.equal(LIMITS.codesPerMember, 3);
    for (const c of codes) assert.match(c, CODE_RE);
    assert.equal(new Set(codes).size, 3);
    assert.equal(reply.headers.get("cache-control"), "no-store", "confirm-no-store: the reply carrying codes");
    assert.equal(memberCodes(env, "m@example.com").length, 3);
  });
  it("member-codes-never-by-email: no route returns codes for a typed address, and a used confirm link mints nothing", async () => {
    const { env, mail } = makeEnv();
    const { codes } = await member(env, mail, "m@example.com");
    const replies = [
      await signup(env, "m@example.com"),
      await call(env, "/api/delete-request", { email: "m@example.com" }, { ip: freshIp() }),
      await call(env, "/api/confirm", { token: tokenFrom(mail[0], "confirm") }, { ip: freshIp() }),
      await call(env, "/api/invite/lookup", { email: "m@example.com" }, { ip: freshIp() }),
      await call(env, "/api/codes/revoke", { email: "m@example.com" }, { ip: freshIp() }),
    ];
    for (const r of replies) {
      assert.ok(!("codes" in (r.body || {})), "no codes in " + r.text);
      for (const c of codes) assert.ok(!r.text.includes(c) && !r.text.includes(c.replace(/-/g, "")));
    }
    assert.equal(memberCodes(env, "m@example.com").length, 3, "still exactly three");
  });
  it("member-code-hash-only: the database holds SHA-256 hashes, never a code", async () => {
    const { env, mail } = makeEnv();
    const { codes } = await member(env, mail, "m@example.com");
    const rows = memberCodes(env, "m@example.com");
    const hashes = await Promise.all(codes.map((c) => codeHash(normaliseCode(c))));
    assert.deepEqual(rows.map((r) => r.code_hash).sort(), hashes.sort());
    const dump = JSON.stringify(env.DB.rows("SELECT * FROM invite_codes")) + JSON.stringify(env.DB.rows("SELECT * FROM signups"));
    for (const c of codes) assert.ok(!dump.includes(c) && !dump.includes(c.replace(/-/g, "")));
  });
  it("member-max-3: at most 3 live codes per member, minted once", async () => {
    const { env, mail } = makeEnv();
    await member(env, mail, "m@example.com");
    // A fresh confirm token for a confirmed address can't be had (signup sends nothing), so no second mint.
    const before = mail.length;
    await signup(env, "m@example.com");
    assert.equal(mail.length, before);
    assert.equal(env.DB.rows("SELECT * FROM invite_codes WHERE member_email = 'm@example.com' AND status IN ('unused','reserved')").length, 3);
  });
});

describe("72(b)(2) 30 days, one use, revocable from the member's own link", () => {
  it("member-code-expiry-30-days", async () => {
    const { env, clock, mail } = makeEnv();
    const { codes } = await member(env, mail, "m@example.com");
    clock.t += 30 * DAY - 1000;
    assert.equal((await lookup(env, codes[0])).body.ok, true);
    clock.t += 2000;
    assert.equal((await lookup(env, codes[0])).text, BAD);
  });
  it("member-code-one-use: two friends at once, one reserves; once spent the code is a bad code", async () => {
    const { env, mail } = makeEnv();
    const { codes } = await member(env, mail, "m@example.com");
    const done = barrier(env, /^UPDATE invite_codes SET status = 'reserved'/);
    const [a, b] = await Promise.all([redeem(env, codes[0], "a@example.com"), redeem(env, codes[0], "b@example.com")]);
    assert.equal(done(), 2);
    assert.deepEqual([a.status, b.status].sort(), [200, 202]);
    const winner = a.status === 202 ? "a@example.com" : "b@example.com";
    assert.equal((await confirmFor(env, mail, winner)).body.ok, true);
    assert.equal(memberCodes(env, "m@example.com").filter((r) => r.status === "used").length, 1);
    assert.equal((await redeem(env, codes[0], "c@example.com")).text, BAD);
  });
  it("member-revoke-own-link: the delete link revokes the codes and keeps the address", async () => {
    const { env, mail } = makeEnv();
    const { codes, del } = await member(env, mail, "m@example.com");
    assert.equal((await call(env, "/api/codes/revoke", { token: "x".repeat(43) }, { ip: freshIp() })).body.ok, false);
    const r = await call(env, "/api/codes/revoke", { token: del }, { ip: freshIp() });
    assert.equal(r.body.ok, true);
    assert.ok(memberCodes(env, "m@example.com").every((row) => row.status === "revoked"));
    for (const c of codes) assert.equal((await lookup(env, c)).text, BAD);
    assert.equal(signupRow(env, "m@example.com").status, "confirmed", "the address stays");
    assert.equal((await call(env, "/api/delete", { token: del }, { ip: freshIp() })).body.ok, true, "the link still deletes afterwards");
  });
});

describe("72(b)(3)-(5) no name, no place in line, nothing sent to the invitee", () => {
  it("member-invite-shows-friend: the lookup gives no name and nothing else", async () => {
    const { env, mail } = makeEnv();
    const { codes } = await member(env, mail, "m@example.com");
    const r = await lookup(env, codes[0]);
    assert.equal(r.text, JSON.stringify({ ok: true, invitedBy: null }));
  });
  it("member-invite-sends-no-email: the friend gets only their own confirm email; the member gets nothing", async () => {
    const { env, mail } = makeEnv();
    const { codes } = await member(env, mail, "m@example.com");
    const toMember = mail.filter((m) => m.to === "m@example.com").length;
    await redeem(env, codes[0], "f@example.com");
    assert.equal(mail.filter((m) => m.to === "m@example.com").length, toMember);
    const toFriend = mail.filter((m) => m.to === "f@example.com");
    assert.equal(toFriend.length, 1);
    for (const c of codes) assert.ok(!toFriend[0].text.includes(c));
  });
  it("member-place-ignores-invites: place comes from confirmed_at alone", async () => {
    const { env, clock, mail } = makeEnv();
    const { codes } = await member(env, mail, "m@example.com");
    clock.t += 1000;
    await signup(env, "plain@example.com");
    await redeem(env, codes[0], "f@example.com");
    clock.t += 1000;
    const plain = await confirmFor(env, mail, "plain@example.com");
    clock.t += 1000;
    const friend = await confirmFor(env, mail, "f@example.com");
    assert.equal(plain.body.place, 2);
    assert.equal(friend.body.place, 3);
  });
});

describe("72(b)(6), 72(c)(2), 72(c)(3), 72(c)(7) owner, links and deletion", () => {
  it("member-owner-cascade: codes reference the member's row and are deleted with it; one owner each", async () => {
    const { env, mail } = makeEnv();
    await member(env, mail, "m@example.com");
    env.DB.rows("DELETE FROM signups WHERE email = 'm@example.com'");
    assert.equal(memberCodes(env, "m@example.com").length, 0);
    assert.throws(() => env.DB.rows("INSERT INTO invite_codes (code_id, code_hash, status, created_at, expires_at) VALUES ('c1','h1','unused',1,2)"));
    assert.throws(() => env.DB.rows("INSERT INTO invite_codes (code_id, code_hash, member_email, status, created_at, expires_at) VALUES ('c2','h2','nobody@example.com','unused',1,2)"));
  });
  it("member-link-emptied-on-spend: only the code's used status stays", async () => {
    const { env, mail } = makeEnv();
    const { codes } = await member(env, mail, "m@example.com");
    await redeem(env, codes[0], "f@example.com");
    assert.ok(signupRow(env, "f@example.com").invite_code_id, "while reserved the link exists");
    await confirmFor(env, mail, "f@example.com");
    const row = signupRow(env, "f@example.com");
    assert.equal(row.invite_code_id, null);
    assert.equal(row.invited_by_family_id, null);
    assert.equal(memberCodes(env, "m@example.com").filter((r) => r.status === "used").length, 1);
    assert.equal(env.DB.rows("SELECT COUNT(*) AS n FROM signups WHERE invite_code_id IS NOT NULL")[0].n, 0);
  });
  it("member-link-emptied-on-release: a lapsed reservation empties the link and frees the code", async () => {
    const { env, clock, mail } = makeEnv();
    const { codes } = await member(env, mail, "m@example.com");
    await redeem(env, codes[0], "f@example.com");
    clock.t += 24 * HOUR + 1000;
    await runCron(env);
    assert.equal(signupRow(env, "f@example.com").invite_code_id, null);
    assert.equal(memberCodes(env, "m@example.com").filter((r) => r.status === "unused").length, 3);
    // and taken over by someone else after lapse, before the daily run
    await redeem(env, codes[1], "g@example.com");
    clock.t += 24 * HOUR + 1000;
    await redeem(env, codes[1], "h@example.com");
    assert.equal(signupRow(env, "g@example.com").invite_code_id, null);
    assert.ok(signupRow(env, "h@example.com").invite_code_id);
  });
  it("member-delete-revokes-and-empties: the member's delete removes their codes and empties friends' links", async () => {
    const { env, mail } = makeEnv();
    const { codes, del } = await member(env, mail, "m@example.com");
    await redeem(env, codes[0], "f@example.com");
    assert.equal((await call(env, "/api/delete", { token: del }, { ip: freshIp() })).body.ok, true);
    assert.equal(memberCodes(env, "m@example.com").length, 0);
    assert.equal(signupRow(env, "f@example.com").invite_code_id, null);
    for (const c of codes.slice(1)) assert.equal((await lookup(env, c)).text, BAD);
  });
  it("deleted-member-friend-still-confirms: a friend holding a reservation confirms, without the link", async () => {
    const { env, mail } = makeEnv();
    const { codes, del } = await member(env, mail, "m@example.com");
    await redeem(env, codes[0], "f@example.com");
    await call(env, "/api/delete", { token: del }, { ip: freshIp() });
    const r = await confirmFor(env, mail, "f@example.com");
    assert.equal(r.body.ok, true);
    const row = signupRow(env, "f@example.com");
    assert.equal(row.status, "confirmed");
    assert.equal(row.invite_code_id, null);
    assert.equal(r.body.codes.length, 3, "the friend is a member now, with codes of their own");
  });
});

describe("72(c)(5) and the brief's limits", () => {
  it("member-cap-300: 300 member codes a day site-wide; over it the member joins without codes", async () => {
    const { env, mail } = makeEnv();
    assert.equal(LIMITS.memberCodesPerDay, 300);
    for (let i = 0; i < 100; i++) assert.equal((await member(env, mail, `m${i}@example.com`)).codes.length, 3);
    const over = await member(env, mail, "late@example.com");
    assert.equal(over.codes, undefined);
    assert.ok(over.reply.body.place > 0, "joins, with a place");
    assert.equal(signupRow(env, "late@example.com").status, "confirmed");
    assert.equal(env.DB.rows("SELECT COUNT(*) AS n FROM invite_codes")[0].n, 300);
  });
  it("member-redeems-cap-200: past 200 redeems a day site-wide a member code is refused and stays unused", async () => {
    const { env, clock, mail } = makeEnv();
    const { codes } = await member(env, mail, "m@example.com");
    env.DB.rows("INSERT INTO counters (name, bucket, subject, count) VALUES ('redeems', ?, 'global', ?)", dayKey(clock.t), LIMITS.redeemsPerDay);
    assert.equal(LIMITS.redeemsPerDay, 200);
    assert.equal((await redeem(env, codes[0], "f@example.com")).text, BAD);
    assert.ok(memberCodes(env, "m@example.com").every((r) => r.status === "unused"));
    assert.equal(signupRow(env, "f@example.com"), undefined);
  });
  it("member-lock-after-10: 10 bad codes lock that IP hash for the hour, even for a good member code", async () => {
    const { env, mail } = makeEnv();
    const { codes } = await member(env, mail, "m@example.com");
    const ip = "192.0.2.99";
    for (let i = 0; i < LIMITS.inviteFailuresToLock; i++) await lookup(env, "AAAA-AAAA-AAAA-AAA" + (i % 10), ip);
    assert.equal((await lookup(env, codes[0], ip)).text, BAD);
    assert.equal((await lookup(env, codes[0], "192.0.2.100")).body.ok, true);
  });
  it("member-logs-clean: no code, email, token or hash in any log line", async () => {
    const { env, mail } = makeEnv();
    const logs = captureLogs();
    let secrets = [];
    try {
      const { codes, del } = await member(env, mail, "secret-member@example.com");
      await redeem(env, codes[0], "secret-friend@example.com");
      await confirmFor(env, mail, "secret-friend@example.com");
      await call(env, "/api/codes/revoke", { token: del }, { ip: freshIp() });
      await call(env, "/api/delete", { token: del }, { ip: freshIp() });
      secrets = ["secret-member", "secret-friend", del, ...codes, ...codes.map((c) => c.replace(/-/g, "")),
        ...(await Promise.all(codes.map((c) => codeHash(normaliseCode(c)))))];
    } finally {
      logs.stop();
    }
    assert.ok(logs.lines.length > 5);
    for (const line of logs.lines) {
      assert.match(line, /^\{"event":"[a-z_.]+"(,"kind":"[a-z_]+")?\}$/);
      for (const s of secrets) assert.ok(!line.includes(s), `log line leaks: ${line}`);
    }
  });
});
