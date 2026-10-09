// Transactional email through Amazon SES (rule 69.5), the one named service.
// Privacy terms: https://aws.amazon.com/privacy/
//
// - Plain text plus a minimal HTML copy: no images, no remote resources, no
//   tracking pixels, no link rewriting. No SES configuration set is named,
//   so SES has no open/click tracking to apply.
// - Every email carries a one-click delete link.
// - The SES key exists only as Worker secrets (SES_ACCESS_KEY_ID,
//   SES_SECRET_ACCESS_KEY), created after the CISO's yes; never in this repo.
//   Without them nothing is sent ("send.disabled"); nothing is live today.
// - Tests pass env.MAILER to capture messages instead of sending.
//
// Wording is a draft, [COPY] for the CBO; what it must contain is set by rule 69.5.

import { hex } from "./util.js";
import { log } from "./log.js";

const SITE = "https://ronna.mom";

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Lines are strings or { link }. (Test the type: strings have a legacy .link() method.)
function html(lines) {
  const body = lines
    .map((l) => (typeof l === "object" ? `<p><a href="${escapeHtml(l.link)}">${escapeHtml(l.link)}</a></p>` : `<p>${escapeHtml(l)}</p>`))
    .join("");
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5">${body}</body></html>`;
}

function text(lines) {
  return lines.map((l) => (typeof l === "object" ? l.link : l)).join("\n\n");
}

export function confirmMessage(to, confirmToken, deleteToken) {
  const lines = [
    "Confirm your place on the MOM waitlist:",
    { link: `${SITE}/confirm/#t=${confirmToken}` },
    "The link works for 24 hours.",
    "If this wasn't you, ignore this email. The address is deleted in 7 days and nothing else happens.",
    "Remove this address from the list at once:",
    { link: `${SITE}/off/#d=${deleteToken}` },
    `RonnaOps · Privacy: ${SITE}/privacy/`,
  ];
  return { to, subject: "Confirm your place on the MOM waitlist", text: text(lines), html: html(lines) };
}

export function deleteMessage(to, deleteToken) {
  const lines = [
    "You asked to leave the MOM waitlist. One click removes the address at once:",
    { link: `${SITE}/off/#d=${deleteToken}` },
    "If this wasn't you, ignore this email; nothing changes.",
    `RonnaOps · Privacy: ${SITE}/privacy/`,
  ];
  return { to, subject: "Leave the MOM waitlist", text: text(lines), html: html(lines) };
}

export async function send(env, message) {
  if (env.MAILER) {
    await env.MAILER(message);
    log("send.ok");
    return;
  }
  if (!env.SES_ACCESS_KEY_ID || !env.SES_SECRET_ACCESS_KEY || !env.SES_REGION || !env.MAIL_FROM) {
    log("send.disabled");
    return;
  }
  const host = `email.${env.SES_REGION}.amazonaws.com`;
  const body = JSON.stringify({
    FromEmailAddress: env.MAIL_FROM,
    Destination: { ToAddresses: [message.to] },
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: { Text: { Data: message.text, Charset: "UTF-8" }, Html: { Data: message.html, Charset: "UTF-8" } },
      },
    },
  });
  const signed = await signV4({
    method: "POST",
    host,
    path: "/v2/email/outbound-emails",
    query: "",
    headers: { "content-type": "application/json" },
    body,
    region: env.SES_REGION,
    service: "ses",
    accessKeyId: env.SES_ACCESS_KEY_ID,
    secretAccessKey: env.SES_SECRET_ACCESS_KEY,
    date: new Date(),
  });
  try {
    const res = await fetch(`https://${host}/v2/email/outbound-emails`, { method: "POST", headers: signed, body });
    if (res.ok) log("send.ok");
    else log("send.error", res.status === 429 ? "throttled" : "rejected");
  } catch {
    log("send.error", "send");
  }
}

// AWS Signature Version 4. Returns the headers to send (including
// Authorization). Verified against AWS's published "get-vanilla" test vector.
export async function signV4({ method, host, path, query, headers, body, region, service, accessKeyId, secretAccessKey, date }) {
  const amzDate = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host, "x-amz-date": amzDate };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const payloadHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const canonical = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))].join("\n");
  let k = new TextEncoder().encode("AWS4" + secretAccessKey);
  for (const part of [day, region, service, "aws4_request"]) k = await hmac(k, part);
  const signature = hex(await hmac(k, toSign));
  const out = {};
  for (const n of names) if (n !== "host") out[n] = all[n];
  out.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}
