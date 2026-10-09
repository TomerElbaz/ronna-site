// ronna-site-signup: the waitlist Worker for ronna.mom.
// Built to CISO rules 69, 72 and 74 (docs/SIGNUP_DESIGN.md). Its only
// binding is its own D1 database (DB); it has no binding to, and never
// calls, any MOM product resource (rule 69.1).
//
// Public routes (JSON POST only, same origin only):
//   /api/signup, /api/confirm, /api/delete-request, /api/delete,
//   /api/invite/lookup, /api/invite/redeem
// Family routes, behind the family Access application (FAMILY_AUD):
//   /api/family/status, /enrol, /name, /mint, /revoke
// Operator routes, behind the operator Access application (OPERATOR_AUD):
//   /api/operator/family/create, /family/enrolment-code, /family/leave,
//   /family/codes, /revoke, /delete
// Codes and tokens are read only from request bodies, never from URLs (rule 72.3).

import {
  DAY, HOUR, codeHash, dayKey, holdUntilFloor, hourKey, json, newCode, newId, newToken,
  normaliseCode, normaliseEmail, now, sha256Hex, validDisplayName,
} from "./util.js";
import { log } from "./log.js";
import { LIMITS, bump, ipHash, peek } from "./limits.js";
import { verifyAccess } from "./access.js";
import { confirmMessage, deleteMessage, send } from "./mail.js";

const CONFIRM_TTL = 24 * HOUR;   // rule 69.3
const PENDING_TTL = 7 * DAY;     // rule 69.3
const RESEND_GAP = HOUR;         // one confirm email per address per hour
const CODE_TTL = 30 * DAY;       // rule 72.7
const ENROL_TTL = 7 * DAY;       // rule 74.1
const MAX_LIVE_CODES = 5;        // rule 72.1
const MAX_OWNERS = 2;            // rule 74.1
const MAX_BODY = 2048;

// Rule 72.5: one reply for every bad code.
const BAD_CODE = { ok: false, message: "This invite isn't valid." };
const SAME_ANSWER = { ok: true }; // rule 69.4: the page shows "Check your inbox"

const tokenHash = (t) => sha256Hex("ronna-token:" + t);

// ---------- request plumbing ----------

async function readJson(request, env) {
  if (request.method !== "POST") return { error: json({ ok: false }, 405) };
  const origin = env.SITE_ORIGIN || "https://ronna.mom";
  if (request.headers.get("Origin") !== origin) return { error: json({ ok: false }, 403) };
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    return { error: json({ ok: false }, 415) };
  }
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: json({ ok: false }, 413) };
  try {
    const body = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return { body };
  } catch {
    return { error: json({ ok: false }, 400) };
  }
}

async function first(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).first();
}

async function all(env, sql, ...args) {
  return (await env.DB.prepare(sql).bind(...args).all()).results || [];
}

// ---------- signup and confirm (rule 69) ----------

// Mints a confirm token (and a delete token for the email's one-click link),
// unless one went out in the last hour or the global cap is reached. Extends
// the reservation of a code held by this signup to the new token's expiry.
async function sendConfirm(env, ctx, email, t) {
  const last = await first(env, "SELECT MAX(created_at) AS at FROM tokens WHERE email = ? AND kind = 'confirm'", email);
  if (last && last.at && t - last.at < RESEND_GAP) {
    log("signup.throttled");
    return;
  }
  if ((await bump(env, "signup_emails", dayKey(t), "global")) > LIMITS.signupEmailsPerDay) {
    log("signup.capped");
    return;
  }
  const confirmToken = newToken();
  const deleteToken = newToken();
  const expires = t + CONFIRM_TTL;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tokens WHERE email = ? AND kind = 'confirm'").bind(email),
    env.DB.prepare("INSERT INTO tokens (token_hash, email, kind, created_at, expires_at) VALUES (?, ?, 'confirm', ?, ?)")
      .bind(await tokenHash(confirmToken), email, t, expires),
    env.DB.prepare("INSERT INTO tokens (token_hash, email, kind, created_at, expires_at) VALUES (?, ?, 'delete', ?, NULL)")
      .bind(await tokenHash(deleteToken), email, t),
    env.DB.prepare(
      "UPDATE invite_codes SET reserved_until = ? WHERE status = 'reserved' " +
        "AND code_id = (SELECT invite_code_id FROM signups WHERE email = ?)",
    ).bind(expires, email),
  ]);
  ctx.waitUntil(send(env, confirmMessage(email, confirmToken, deleteToken)));
  log("signup.accepted");
}

async function signup(request, env, ctx) {
  const started = Date.now();
  const { body, error } = await readJson(request, env);
  if (error) return error;
  const email = normaliseEmail(body.email);
  if (!email) {
    log("signup.implausible");
    return json({ ok: false, error: "email" }, 400);
  }
  const t = now(env);
  const reply = async () => {
    await holdUntilFloor(started, env);
    return json(SAME_ANSWER, 202);
  };
  if (typeof body.website === "string" && body.website !== "") return reply(); // honeypot
  const ip = await ipHash(env, request, t);
  const perHour = await bump(env, "signup_ip", hourKey(t), ip);
  const perDay = await bump(env, "signup_ip_day", dayKey(t), ip);
  if (perHour > LIMITS.signupPerIpHour || perDay > LIMITS.signupPerIpDay) {
    log("signup.limited");
    return reply();
  }
  const row = await first(env, "SELECT status FROM signups WHERE email = ?", email);
  if (row && row.status === "confirmed") return reply(); // nothing sent, same answer
  if (!row) {
    await env.DB.prepare("INSERT OR IGNORE INTO signups (email, status, created_at) VALUES (?, 'pending', ?)").bind(email, t).run();
  }
  await sendConfirm(env, ctx, email, t);
  return reply();
}

async function confirm(request, env) {
  const { body, error } = await readJson(request, env);
  if (error) return error;
  if (typeof body.token !== "string" || body.token.length < 20 || body.token.length > 100) {
    log("confirm.invalid");
    return json({ ok: false });
  }
  const t = now(env);
  const h = await tokenHash(body.token);
  const tokenEmail = "(SELECT email FROM tokens WHERE token_hash = ?1 AND kind = 'confirm' AND expires_at > ?2)";
  // One atomic batch (rule 72.6): confirm, spend the reserved code if it is
  // still this signup's, drop the mark if not (rule 74.4), use the token once.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE signups SET status = 'confirmed', confirmed_at = ?2 WHERE status = 'pending' AND email = ${tokenEmail}`).bind(h, t),
    env.DB.prepare(
      `UPDATE invite_codes SET status = 'used', used_at = ?2 WHERE status = 'reserved' AND reserved_until > ?2 ` +
        `AND code_id = (SELECT invite_code_id FROM signups WHERE email = ${tokenEmail})`,
    ).bind(h, t),
    env.DB.prepare(
      `UPDATE signups SET invited_by_family_id = NULL, invite_code_id = NULL WHERE email = ${tokenEmail} ` +
        "AND invite_code_id IS NOT NULL AND NOT EXISTS " +
        "(SELECT 1 FROM invite_codes c WHERE c.code_id = signups.invite_code_id AND c.status = 'used' AND c.used_at = ?2)",
    ).bind(h, t),
    env.DB.prepare("DELETE FROM tokens WHERE token_hash = ?1 AND kind = 'confirm' AND expires_at > ?2 RETURNING email").bind(h, t),
  ]);
  const used = results[3].results || [];
  if (used.length !== 1) {
    log("confirm.invalid");
    return json({ ok: false });
  }
  if (results[1].meta.changes) log("invite.spent");
  if (results[2].meta.changes) log("invite.mark_dropped");
  const email = used[0].email;
  const mine = await first(env, "SELECT confirmed_at FROM signups WHERE email = ? AND status = 'confirmed'", email);
  if (!mine) {
    log("confirm.invalid");
    return json({ ok: false });
  }
  // Place on the list from confirmed_at alone; invites never change it (rule 72.12).
  const place = await first(
    env,
    "SELECT COUNT(*) + 1 AS place FROM signups WHERE status = 'confirmed' AND (confirmed_at < ? OR (confirmed_at = ? AND email < ?))",
    mine.confirmed_at, mine.confirmed_at, email,
  );
  log("confirm.ok");
  return json({ ok: true, place: place.place });
}

// ---------- deletion (rule 69.9, 72.11) ----------

async function deleteRequest(request, env, ctx) {
  const started = Date.now();
  const { body, error } = await readJson(request, env);
  if (error) return error;
  const email = normaliseEmail(body.email);
  if (!email) return json({ ok: false, error: "email" }, 400);
  const t = now(env);
  const ip = await ipHash(env, request, t);
  if ((await bump(env, "delete_ip", hourKey(t), ip)) > LIMITS.deleteRequestsPerIpHour) {
    log("delete_request.limited");
  } else {
    const row = await first(env, "SELECT 1 AS here FROM signups WHERE email = ?", email);
    const recent = await first(
      env, "SELECT COUNT(*) AS n FROM tokens WHERE email = ? AND kind = 'delete' AND created_at > ?", email, t - DAY,
    );
    if (row && recent.n < LIMITS.deleteEmailsPerAddressDay + 1) {
      const deleteToken = newToken();
      await env.DB.prepare("INSERT INTO tokens (token_hash, email, kind, created_at, expires_at) VALUES (?, ?, 'delete', ?, NULL)")
        .bind(await tokenHash(deleteToken), email, t).run();
      ctx.waitUntil(send(env, deleteMessage(email, deleteToken)));
    }
    log("delete_request.accepted");
  }
  await holdUntilFloor(started, env);
  return json(SAME_ANSWER, 202);
}

async function removeByEmailSql(env, emailExpr, ...args) {
  // Release a code this signup was holding, then delete the row; its tokens
  // go with it (ON DELETE CASCADE), and so do its invited-by link and code ID.
  return env.DB.batch([
    env.DB.prepare(
      "UPDATE invite_codes SET status = 'unused', reserved_until = NULL WHERE status = 'reserved' " +
        `AND code_id = (SELECT invite_code_id FROM signups WHERE email = ${emailExpr})`,
    ).bind(...args),
    env.DB.prepare(`DELETE FROM signups WHERE email = ${emailExpr} RETURNING 1 AS gone`).bind(...args),
  ]);
}

async function del(request, env) {
  const { body, error } = await readJson(request, env);
  if (error) return error;
  if (typeof body.token !== "string" || body.token.length < 20 || body.token.length > 100) {
    log("delete.invalid");
    return json({ ok: false });
  }
  const h = await tokenHash(body.token);
  const results = await removeByEmailSql(env, "(SELECT email FROM tokens WHERE token_hash = ?1 AND kind = 'delete')", h);
  if ((results[1].results || []).length !== 1) {
    log("delete.invalid");
    return json({ ok: false });
  }
  log("delete.ok");
  return json({ ok: true });
}

// ---------- invitations (rules 72, 74) ----------

// Rule 72.8: 10 requests an hour per salted IP hash; 10 failures in an hour
// lock that hash for a full hour from the tenth failure (so a lock taken at
// 10:55 still holds at 11:05, after the hourly allowance has reset). The lock
// is a counter row whose value is the time it ends; nothing else is kept.
async function inviteGate(env, request, t) {
  const ip = await ipHash(env, request, t);
  const hour = hourKey(t);
  const lock = await first(env, "SELECT MAX(count) AS until FROM counters WHERE name = 'invite_lock' AND subject = ?", ip);
  const locked = !!(lock && lock.until && lock.until > t);
  const count = await bump(env, "invite_ip", hour, ip);
  return { ip, hour, t, blocked: locked || count > LIMITS.invitePerIpHour, locked };
}

async function badCode(env, gate, started, event) {
  log(event);
  if (!gate.locked) {
    const fails = await bump(env, "invite_fail", gate.hour, gate.ip);
    if (fails === LIMITS.inviteFailuresToLock) {
      await env.DB.prepare(
        "INSERT INTO counters (name, bucket, subject, count) VALUES ('invite_lock', ?, ?, ?) " +
          "ON CONFLICT (name, bucket, subject) DO UPDATE SET count = excluded.count",
      ).bind(gate.hour, gate.ip, gate.t + HOUR).run();
      log("invite.locked");
    }
  }
  await holdUntilFloor(started, env);
  return json(BAD_CODE); // same status, body and floor for every bad code (rule 72.5)
}

const USABLE_CODE =
  "SELECT c.code_id, c.family_id, f.display_first_name AS name FROM invite_codes c JOIN families f ON f.family_id = c.family_id " +
  "WHERE c.code_hash = ? AND c.expires_at > ? AND f.status = 'active' AND f.display_first_name IS NOT NULL " +
  "AND (c.status = 'unused' OR (c.status = 'reserved' AND c.reserved_until <= ?))";

async function inviteLookup(request, env) {
  const started = Date.now();
  const { body, error } = await readJson(request, env);
  if (error) return error;
  const t = now(env);
  const gate = await inviteGate(env, request, t);
  if (gate.blocked) return badCode(env, gate, started, "invite.lookup_bad");
  const norm = normaliseCode(body.code);
  const row = norm ? await first(env, USABLE_CODE, await codeHash(norm), t, t) : null;
  if (!row) return badCode(env, gate, started, "invite.lookup_bad");
  log("invite.lookup_ok");
  await holdUntilFloor(started, env);
  return json({ ok: true, invitedBy: row.name }); // the chosen first name, nothing else (rule 72.4)
}

async function inviteRedeem(request, env, ctx) {
  const started = Date.now();
  const { body, error } = await readJson(request, env);
  if (error) return error;
  const t = now(env);
  const gate = await inviteGate(env, request, t);
  if (gate.blocked) return badCode(env, gate, started, "invite.redeem_bad");
  const norm = normaliseCode(body.code);
  const ch = norm ? await codeHash(norm) : null;
  const usable = ch ? await first(env, USABLE_CODE, ch, t, t) : null;
  if (!usable) return badCode(env, gate, started, "invite.redeem_bad");
  if ((await peek(env, "redeems", dayKey(t), "global")) >= LIMITS.redeemsPerDay) {
    log("invite.capped");
    await holdUntilFloor(started, env);
    return json(BAD_CODE);
  }
  const email = normaliseEmail(body.email);
  if (!email) return json({ ok: false, error: "email" }, 400);
  const reply = async () => {
    await holdUntilFloor(started, env);
    return json(SAME_ANSWER, 202);
  };
  if (typeof body.website === "string" && body.website !== "") return reply(); // honeypot

  const existing = await first(env, "SELECT status, invite_code_id FROM signups WHERE email = ?", email);
  if (existing && existing.status === "confirmed") return reply(); // nothing reserved, same answer (rule 69.4)
  if (existing && existing.invite_code_id) {
    await sendConfirm(env, ctx, email, t);
    return reply();
  }
  // Reserve: one statement, so of two at once exactly one wins (rule 72.6).
  const reserved = await env.DB.prepare(
    "UPDATE invite_codes SET status = 'reserved', reserved_until = ?2 WHERE code_hash = ?1 AND expires_at > ?3 " +
      "AND (status = 'unused' OR (status = 'reserved' AND reserved_until <= ?3)) " +
      "AND family_id IN (SELECT family_id FROM families WHERE status = 'active') RETURNING code_id, family_id",
  ).bind(ch, t + CONFIRM_TTL, t).all();
  const won = (reserved.results || [])[0];
  if (!won) return badCode(env, gate, started, "invite.redeem_bad");
  await bump(env, "redeems", dayKey(t), "global");
  await env.DB.batch([
    // A lapsed reservation now held by this person: the earlier signup loses its link.
    env.DB.prepare(
      "UPDATE signups SET invited_by_family_id = NULL, invite_code_id = NULL WHERE invite_code_id = ? AND email <> ? AND status = 'pending'",
    ).bind(won.code_id, email),
    env.DB.prepare(
      "INSERT INTO signups (email, status, created_at, invited_by_family_id, invite_code_id) VALUES (?1, 'pending', ?2, ?3, ?4) " +
        "ON CONFLICT (email) DO UPDATE SET invited_by_family_id = excluded.invited_by_family_id, invite_code_id = excluded.invite_code_id " +
        "WHERE signups.status = 'pending' AND signups.invite_code_id IS NULL",
    ).bind(email, t, won.family_id, won.code_id),
  ]);
  log("invite.reserved");
  await sendConfirm(env, ctx, email, t);
  return reply();
}

// ---------- family routes (behind Access, FAMILY_AUD) ----------

function codeView(rows, t) {
  // Rule 72.9: the inviter sees only used or unused; reserved shows as unused;
  // revoked and expired codes drop off. Never an invitee's email or anything else.
  return rows
    .filter((r) => r.status === "used" || ((r.status === "unused" || r.status === "reserved") && r.expires_at > t))
    .map((r) => ({ id: r.code_id, state: r.status === "used" ? "used" : "unused", expiresAt: r.expires_at }));
}

async function family(request, env, route) {
  const sub = await verifyAccess(request, env, "family");
  if (!sub) {
    log("access.refused", "jwt");
    return json({ ok: false }, 403);
  }
  const { body, error } = await readJson(request, env);
  if (error) return error;
  const t = now(env);
  const fam = await first(
    env,
    "SELECT f.family_id, f.display_first_name AS name FROM family_owners o JOIN families f ON f.family_id = o.family_id " +
      "WHERE o.owner_access_id = ? AND f.status = 'active'",
    sub,
  );

  if (route === "enrol") {
    if (fam) return json({ ok: true, enrolled: true });
    const norm = normaliseCode(body.code);
    if (!norm) {
      log("family.enrol_refused");
      return json({ ok: false });
    }
    const h = await codeHash(norm);
    const results = await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO family_owners (family_id, owner_access_id) SELECT e.family_id, ?2 FROM enrolment_codes e " +
          "JOIN families f ON f.family_id = e.family_id WHERE e.code_hash = ?1 AND e.expires_at > ?3 AND f.status = 'active' " +
          `AND (SELECT COUNT(*) FROM family_owners o WHERE o.family_id = e.family_id) < ${MAX_OWNERS}`,
      ).bind(h, sub, t),
      env.DB.prepare(
        "DELETE FROM enrolment_codes WHERE code_hash = ?1 AND family_id IN (SELECT family_id FROM family_owners WHERE owner_access_id = ?2)",
      ).bind(h, sub),
    ]);
    if (!results[0].meta.changes) {
      log("family.enrol_refused");
      return json({ ok: false });
    }
    log("family.enrolled");
    return json({ ok: true, enrolled: true });
  }

  if (!fam) return json({ ok: true, enrolled: false });

  if (route === "status") {
    const rows = await all(env, "SELECT code_id, status, expires_at FROM invite_codes WHERE family_id = ? ORDER BY created_at", fam.family_id);
    return json({ ok: true, enrolled: true, name: fam.name, codes: codeView(rows, t) });
  }
  if (route === "name") {
    const name = validDisplayName(body.name);
    if (!name) return json({ ok: false, error: "name" }, 400);
    await env.DB.prepare("UPDATE families SET display_first_name = ? WHERE family_id = ? AND status = 'active'").bind(name, fam.family_id).run();
    log("family.named");
    return json({ ok: true, name });
  }
  if (route === "mint") {
    if (!fam.name) {
      log("invite.mint_refused_name");
      return json({ ok: false, error: "name" });
    }
    if ((await bump(env, "mints", dayKey(t), sub)) > LIMITS.mintsPerOwnerDay) {
      log("invite.mint_refused_daily");
      return json({ ok: false, error: "daily" });
    }
    const code = newCode();
    const codeId = newId("code_");
    // One statement: the cap check and the insert can't be split by a second click.
    const res = await env.DB.prepare(
      "INSERT INTO invite_codes (code_id, code_hash, family_id, status, created_at, expires_at) " +
        "SELECT ?1, ?2, ?3, 'unused', ?4, ?5 WHERE " +
        `(SELECT COUNT(*) FROM invite_codes WHERE family_id = ?3 AND status IN ('unused', 'reserved') AND expires_at > ?4) < ${MAX_LIVE_CODES} ` +
        "AND EXISTS (SELECT 1 FROM families WHERE family_id = ?3 AND status = 'active')",
    ).bind(codeId, await codeHash(normaliseCode(code)), fam.family_id, t, t + CODE_TTL).run();
    if (!res.meta.changes) {
      log("invite.mint_refused_cap");
      return json({ ok: false, error: "cap" });
    }
    log("invite.minted");
    // Shown to the inviter once (rule 72.2): only this response carries the code.
    return json({ ok: true, code, id: codeId, expiresAt: t + CODE_TTL });
  }
  if (route === "revoke") {
    const res = await env.DB.prepare(
      "UPDATE invite_codes SET status = 'revoked', revoked_at = ? WHERE code_id = ? AND family_id = ? AND status IN ('unused', 'reserved')",
    ).bind(t, String(body.id || ""), fam.family_id).run();
    if (res.meta.changes) log("invite.revoked");
    return json({ ok: res.meta.changes === 1 });
  }
  return json({ ok: false }, 404);
}

// ---------- operator routes (behind Access, OPERATOR_AUD: Tomer only) ----------

async function leaveFamily(env, familyId, t) {
  // Rules 72.11 and 74.1: revoke unused codes, erase the display name and
  // owner rows, empty invited-by on invitees, in one transaction.
  return env.DB.batch([
    env.DB.prepare("UPDATE invite_codes SET status = 'revoked', revoked_at = ? WHERE family_id = ? AND status IN ('unused', 'reserved')").bind(t, familyId),
    env.DB.prepare("UPDATE families SET status = 'left', left_at = ?, display_first_name = NULL WHERE family_id = ?").bind(t, familyId),
    env.DB.prepare("DELETE FROM family_owners WHERE family_id = ?").bind(familyId),
    env.DB.prepare("DELETE FROM enrolment_codes WHERE family_id = ?").bind(familyId),
    env.DB.prepare("UPDATE signups SET invited_by_family_id = NULL, invite_code_id = NULL WHERE invited_by_family_id = ?").bind(familyId),
  ]);
}

async function operator(request, env, route) {
  const sub = await verifyAccess(request, env, "operator");
  if (!sub) {
    log("access.refused", "jwt");
    return json({ ok: false }, 403);
  }
  const { body, error } = await readJson(request, env);
  if (error) return error;
  const t = now(env);
  const familyId = typeof body.familyId === "string" ? body.familyId : "";

  if (route === "family/create") {
    const id = newId("fam_");
    await env.DB.prepare("INSERT INTO families (family_id, status, created_at) VALUES (?, 'active', ?)").bind(id, t).run();
    log("family.created");
    return json({ ok: true, familyId: id });
  }
  if (route === "family/enrolment-code") {
    const fam = await first(env, "SELECT 1 AS ok FROM families WHERE family_id = ? AND status = 'active'", familyId);
    if (!fam) return json({ ok: false });
    const code = newCode();
    await env.DB.prepare("INSERT INTO enrolment_codes (code_hash, family_id, expires_at) VALUES (?, ?, ?)")
      .bind(await codeHash(normaliseCode(code)), familyId, t + ENROL_TTL).run();
    log("family.enrolment_code");
    // Shown once, to Tomer, who hands it over himself; never emailed (rule 74.1).
    return json({ ok: true, code, expiresAt: t + ENROL_TTL });
  }
  if (route === "family/leave") {
    const res = await leaveFamily(env, familyId, t);
    if (res[1].meta.changes) log("family.left");
    return json({ ok: res[1].meta.changes === 1 });
  }
  if (route === "family/codes") {
    const rows = await all(env, "SELECT code_id, status, expires_at FROM invite_codes WHERE family_id = ? ORDER BY created_at", familyId);
    return json({ ok: true, codes: codeView(rows, t) });
  }
  if (route === "revoke") {
    const res = body.all === true
      ? await env.DB.prepare("UPDATE invite_codes SET status = 'revoked', revoked_at = ? WHERE family_id = ? AND status IN ('unused', 'reserved')").bind(t, familyId).run()
      : await env.DB.prepare("UPDATE invite_codes SET status = 'revoked', revoked_at = ? WHERE code_id = ? AND status IN ('unused', 'reserved')").bind(t, String(body.codeId || "")).run();
    if (res.meta.changes) log("invite.revoked");
    return json({ ok: true, revoked: res.meta.changes });
  }
  if (route === "delete") {
    // Rule 69.9: a reply asking for deletion, done by hand within 7 days.
    const email = normaliseEmail(body.email);
    if (email) await removeByEmailSql(env, "?1", email);
    log("operator.delete");
    return json({ ok: true });
  }
  return json({ ok: false }, 404);
}

// ---------- daily run ----------

export async function cleanup(env, t) {
  const today = dayKey(t);
  await env.DB.batch([
    // Rule 69.3: unconfirmed rows deleted after 7 days (tokens cascade); release their codes first.
    env.DB.prepare(
      "UPDATE invite_codes SET status = 'unused', reserved_until = NULL WHERE status = 'reserved' " +
        "AND code_id IN (SELECT invite_code_id FROM signups WHERE status = 'pending' AND created_at <= ?)",
    ).bind(t - PENDING_TTL),
    env.DB.prepare("DELETE FROM signups WHERE status = 'pending' AND created_at <= ?").bind(t - PENDING_TTL),
    env.DB.prepare("DELETE FROM tokens WHERE kind = 'confirm' AND expires_at <= ?").bind(t),
    // Rule 72.6: lapsed reservations are released; the lapsed signup loses its link.
    env.DB.prepare(
      "UPDATE signups SET invited_by_family_id = NULL, invite_code_id = NULL WHERE status = 'pending' AND invite_code_id IN " +
        "(SELECT code_id FROM invite_codes WHERE status = 'reserved' AND reserved_until <= ?)",
    ).bind(t),
    env.DB.prepare("UPDATE invite_codes SET status = 'unused', reserved_until = NULL WHERE status = 'reserved' AND reserved_until <= ?").bind(t),
    env.DB.prepare("DELETE FROM enrolment_codes WHERE expires_at <= ?").bind(t),
    env.DB.prepare("DELETE FROM invite_codes WHERE status IN ('unused', 'revoked') AND expires_at <= ?").bind(t - CODE_TTL),
    // Rules 69.6 and 72.8: yesterday's salt and counters go.
    env.DB.prepare("DELETE FROM salts WHERE day < ?").bind(today),
    env.DB.prepare("DELETE FROM counters WHERE bucket < ?").bind(today),
  ]);
  log("cron.cleaned");
}

// ---------- entry points ----------

const PUBLIC = {
  "/api/signup": signup,
  "/api/confirm": confirm,
  "/api/delete-request": deleteRequest,
  "/api/delete": del,
  "/api/invite/lookup": inviteLookup,
  "/api/invite/redeem": inviteRedeem,
};

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname; // the path only; query strings are never read
    try {
      if (PUBLIC[path]) return await PUBLIC[path](request, env, ctx);
      if (path.startsWith("/api/family/")) return await family(request, env, path.slice("/api/family/".length));
      if (path.startsWith("/api/operator/")) return await operator(request, env, path.slice("/api/operator/".length));
      return json({ ok: false }, 404);
    } catch {
      log("request.error", "db");
      return json({ ok: false }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanup(env, now(env)));
  },
};
