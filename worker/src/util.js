// Small helpers shared by every route. Web platform APIs only (the Workers
// runtime and Node 22 both provide them); no dependencies.

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

// Crockford base32 (rule 72.2): no I, L, O or U.
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function now(env) {
  // Tests may pin the clock through env.CLOCK; production uses the real time.
  return env.CLOCK ? env.CLOCK() : Date.now();
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// Rule 69.3: 256-bit token (above the 128-bit floor), base64url.
export function newToken() {
  return base64url(randomBytes(32));
}

// Opaque IDs (code_id, family_id): 80 random bits in Crockford base32.
export function newId(prefix) {
  return prefix + crockford(randomBytes(10));
}

// 10 random bytes = 80 bits = exactly 16 Crockford characters.
export function crockford(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

// Rule 72.2: 80 random bits from the crypto RNG, 16 characters, groups of 4.
export function newCode() {
  const raw = crockford(randomBytes(10));
  return raw.match(/.{4}/g).join("-");
}

// Normalise a typed or pasted code: upper-case, drop separators, read I/L as 1
// and O as 0 (Crockford). Returns null unless exactly 16 valid characters remain.
export function normaliseCode(input) {
  if (typeof input !== "string") return null;
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (s.length !== 16) return null;
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null;
  return s;
}

export async function codeHash(normalised) {
  return sha256Hex("ronna-code:" + normalised);
}

// Rule 69.4: a plausible address is something@something.tld, at most 254 chars.
export function normaliseEmail(input) {
  if (typeof input !== "string") return null;
  const e = input.trim().toLowerCase();
  if (e.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
  return e;
}

// Rule 72.4 / 74.5: one word, letters plus - and ', at most 20 characters.
export function validDisplayName(input) {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (s.length < 1 || s.length > 20) return null;
  if (!/^[\p{L}][\p{L}'-]*$/u.test(s)) return null;
  return s;
}

export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function hourKey(ms) {
  return new Date(ms).toISOString().slice(0, 13);
}

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

// Rules 69.4 and 72.5: public replies are held to a fixed floor so that every
// path takes the same time. env.MIN_REPLY_MS sets it (default 400 ms).
export async function holdUntilFloor(startedAt, env) {
  const floor = Number(env.MIN_REPLY_MS ?? 400);
  const wait = startedAt + floor - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
