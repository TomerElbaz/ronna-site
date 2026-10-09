// Cloudflare Access check (rules 72.1 and 74.1, 74.6). Access blocks requests
// at the edge; the Worker checks again, so a misrouted request can't get in:
//   - the Cf-Access-Jwt-Assertion header holds an RS256 JWT,
//   - signed by a key from the team's published Access certs,
//   - issued by the team domain, unexpired, and
//   - carrying the audience tag of *this* Access application. Family routes
//     accept only FAMILY_AUD; operator routes only OPERATOR_AUD. A token from
//     one application is refused on the other.
// Returns the Access user ID (the JWT's `sub`), or null.

const CERT_TTL_MS = 10 * 60 * 1000;
const SKEW_S = 60;
let certCache = { at: 0, team: "", keys: [] };

function b64urlToBytes(s) {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodePart(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function certs(env) {
  const team = env.ACCESS_TEAM_DOMAIN;
  const fresh = certCache.team === team && Date.now() - certCache.at < CERT_TTL_MS;
  if (fresh) return certCache.keys;
  const fetchImpl = env.ACCESS_FETCH || fetch;
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("certs");
  const body = await res.json();
  certCache = { at: Date.now(), team, keys: Array.isArray(body.keys) ? body.keys : [] };
  return certCache.keys;
}

export function clearAccessCertCache() {
  certCache = { at: 0, team: "", keys: [] };
}

export async function verifyAccess(request, env, app) {
  const aud = app === "family" ? env.FAMILY_AUD : app === "operator" ? env.OPERATOR_AUD : null;
  if (!aud || !env.ACCESS_TEAM_DOMAIN) return null;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  let keys;
  try {
    keys = await certs(env);
  } catch {
    return null;
  }
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]),
  );
  if (!ok) return null;

  const t = Math.floor((env.CLOCK ? env.CLOCK() : Date.now()) / 1000);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return null;
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < t) return null;
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > t) return null;
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 200) return null;
  return claims.sub;
}
