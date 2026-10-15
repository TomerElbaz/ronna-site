// Rate limits (rules 69.6, 72.8, 74.3). Counters only.
// The client IP is used in memory to compute SHA-256(daily salt || IP) and is
// never stored or logged. The salt is random per UTC day and its row is
// deleted by the daily run, so yesterday's hashes can't be recomputed.

import { dayKey, hourKey, hex, randomBytes, sha256Hex } from "./util.js";

export const LIMITS = {
  signupPerIpHour: 5,        // rule 69.6 (CISO may tune)
  signupPerIpDay: 20,
  signupEmailsPerDay: 500,   // global cap on confirm emails
  deleteRequestsPerIpHour: 5,
  deleteEmailsPerAddressDay: 3,
  invitePerIpHour: 10,       // rule 72.8
  inviteFailuresToLock: 10,  // rule 72.8: 10 failures in an hour lock the hash for the hour
  redeemsPerDay: 200,        // rule 74.3: site-wide
  mintsPerOwnerDay: 20,      // rule 74.3
};

export async function ipHash(env, request, t) {
  const day = dayKey(t);
  await env.DB.prepare("INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)")
    .bind(day, hex(randomBytes(32))).run();
  const row = await env.DB.prepare("SELECT salt FROM salts WHERE day = ?").bind(day).first();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return sha256Hex(row.salt + "|" + ip);
}

export async function bump(env, name, bucket, subject) {
  const row = await env.DB.prepare(
    "INSERT INTO counters (name, bucket, subject, count) VALUES (?, ?, ?, 1) " +
      "ON CONFLICT (name, bucket, subject) DO UPDATE SET count = count + 1 RETURNING count",
  ).bind(name, bucket, subject).first();
  return row.count;
}

export async function peek(env, name, bucket, subject) {
  const row = await env.DB.prepare(
    "SELECT count FROM counters WHERE name = ? AND bucket = ? AND subject = ?",
  ).bind(name, bucket, subject).first();
  return row ? row.count : 0;
}

export const buckets = { hour: hourKey, day: dayKey };
