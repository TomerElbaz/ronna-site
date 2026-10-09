# Waitlist signup design — FOR CISO

Status: **design only, for the CISO's ruling.** Nothing here is built. The site
today collects nothing: the form's action is empty, its submit is held in the
browser, and the Content-Security-Policy blocks form posts and all outside
connections. No part of this design is switched on until the CISO approves it
in the CPO chat, and each change it implies to `public/_headers` is listed in
section 10 so it can be approved line by line.

Author: Web build desk (Claude Code, cloud), 9 Oct 2026, on the CPO's order of
03:24. Lives in `docs/`, which Cloudflare Pages does not publish.

Scope: ronna.mom's own waitlist only. This design never reads from, writes to
or calls the MOM product's systems, and nothing in it depends on them.

---

## 1. Summary

| Question | Proposal |
|---|---|
| Where emails live | Cloudflare D1, bound only to this site's Pages Functions. Encrypted per row; looked up by a keyed hash. No third-party store. |
| How people confirm | Double opt-in. A random single-use token, sent by email, valid 48 hours, opened at `/confirm/`. Only the token's hash is stored. |
| Who sends the email | One transactional sender, chosen by the CISO from section 4. Preferred: Cloudflare's own email sending, if available on the account; otherwise Amazon SES with no tracking configured. |
| What the email contains | Plain text plus a minimal HTML copy. One link. No images, no pixels, no link tracking, no marketing. |
| Bots and abuse | Cloudflare rate limiting (per IP and per address), a honeypot field, uniform replies, and double opt-in itself. No CAPTCHA vendor. |
| Deletion | Self-serve through `/off/` (emailed single-use link) and on request to the privacy contact. Hard delete, including tokens. |
| Logging | Event names and counts only. Never the email, the token or the IP. Email and token never appear in any URL the server sees. |
| `/invite/` later | Same token scheme, issued for a named address, single use, 7 days. Open question who issues it (section 9). |
| Outside services | Cloudflare (hosting, functions, database, rate limiting, secrets, DNS); one email sender; GitHub (source only, no subscriber data). Full list in section 11. |

---

## 2. Data stored, and where

**Store: Cloudflare D1** (a SQLite database run by Cloudflare), one database,
bound only to this site's Pages Functions (the `functions/` folder of this
repo, served on `ronna.mom/api/...`). Nothing else has the binding.

Why D1 rather than Cloudflare KV: it gives a unique index (one row per
address), atomic single-use updates on tokens, and real deletes. KV is
eventually consistent, which makes "used exactly once" hard to guarantee.

**Region:** set a D1 location or jurisdiction hint the CISO chooses (for
example EU). *Verify before build* what D1 offers on the account at that time.

**Table `signups`, one row per address:**

| Field | What it holds |
|---|---|
| `id` | Random 128-bit id. Not derived from the email. |
| `email_hash` | HMAC-SHA-256 of the normalised address (trimmed, lower-cased) with a secret key. Unique index. Used to find a row without decrypting anything. |
| `email_enc` | The address encrypted with AES-256-GCM under a second secret key, with a random nonce per row. Decrypted only to send an email. |
| `audience` | `home` or `business`, from the page's switch. Optional; the CISO may drop it. |
| `status` | `pending` or `confirmed`. |
| `created_at`, `confirmed_at` | Timestamps, to the minute. |
| `place` | Place on the list, assigned at confirmation. |

**Table `tokens`:**

| Field | What it holds |
|---|---|
| `token_hash` | SHA-256 of the token. The token itself is never stored. Primary key. |
| `signup_id` | The row it belongs to. |
| `purpose` | `confirm`, `delete` or `invite`. |
| `expires_at` | Creation plus 48 hours (`confirm`, `delete`) or 7 days (`invite`). |
| `used_at` | Empty until used; set once. |

**Not stored, anywhere:** IP address, user agent, referrer, cookies, device
data, name, phone, location. No analytics.

**Keys:** the HMAC key, the encryption key and the sender's API key live as
encrypted environment variables (secrets) on the Pages project, set in the
Cloudflare dashboard by the CISO's delegate. **Never in this repo.** Rotation:
the encryption key can be rotated by re-encrypting rows in place; rotating the
HMAC key means recomputing `email_hash`, which needs the old key once.

**Retention:**
- `pending` rows and their tokens are deleted 48 hours after creation if not
  confirmed. Cleanup runs at the start of each signup request (no scheduled job).
- Used and expired tokens are deleted the same way.
- `confirmed` rows stay until the person asks to leave, or until the waitlist
  closes, when the whole table is deleted (the CISO sets that date).
- Point-in-time recovery: D1 keeps a restorable history (Time Travel) for a
  fixed window (*verify the window for the account's plan*; it has been 7 days
  on Free and 30 on Paid). A deleted address therefore remains recoverable by
  an operator for that window, then is gone. The privacy page must say so.

---

## 3. Double opt-in through `/confirm/`

**Flow:**
1. The visitor enters an email on `/` or `/what/` and submits.
2. The page sends `POST /api/signup` with a JSON body `{email, audience,
   website}` (`website` is the honeypot, section 5). The email is in the body
   only, never in a URL.
3. The function always replies the same way, `202 {"ok": true}`, whether the
   address is new, pending, already confirmed or rate-limited. The page shows
   "Check your email." That way nobody can learn whether an address is on the list.
4. If the address is new, or pending with no live token, the function creates
   or keeps the `pending` row, mints a `confirm` token and sends one email. If
   the address is already confirmed, it sends nothing.
5. The email's link is `https://ronna.mom/confirm/#t=<token>`.
6. `/confirm/` shows a **Confirm** button. Only a click on it sends `POST
   /api/confirm` with `{token}`. Opening the link alone confirms nothing.
7. The function hashes the token, and in one statement marks it used *only if*
   it exists, has purpose `confirm`, is unused and unexpired. If exactly one
   row changed, the signup becomes `confirmed`, gets its `place`, and the reply
   carries the place number for the page to show. Anything else gets one
   generic reply: "That link has expired or was already used."

**Token format:** 32 bytes from the runtime's cryptographic random source
(`crypto.getRandomValues`), written as base64url: 43 characters, 256 bits of
entropy. Only its SHA-256 is stored.

**Expiry and use:** 48 hours, single use. "Send the link again" mints a new
token and voids the old one. At most 3 confirm emails per address per 24
hours.

**Why the token sits after `#`:** a URL fragment is never sent to the server,
so it never reaches Cloudflare's request logs or any proxy. The page reads it
and sends it in a POST body. The page then removes it from the address bar
(`history.replaceState`). With `Referrer-Policy: no-referrer` on `/confirm/`
and `Cache-Control: no-store` (both already in place), it does not leak onward
either.

**Why a button, not a plain link:** mail security scanners open links in
incoming mail, and some run scripts. A GET that confirms would let a scanner
confirm an address its owner never meant to sign up. A POST behind a button
click holds back nearly all of them.

**Requests are checked:** the functions accept only `POST`, only
`Content-Type: application/json`, and only an `Origin` of `https://ronna.mom`.
That blocks cross-site form posts. Bodies over 2 KB are refused. All database
queries use bound parameters.

---

## 4. The confirmation email

**Sender, one of the following, chosen by the CISO:**

| Option | Vendor | For | Against |
|---|---|---|---|
| **A. Cloudflare email sending** | Cloudflare, Inc. | Keeps everything inside Cloudflare; no new vendor. | *Verify availability before choosing.* Cloudflare's long-standing Email Routing only sends to pre-verified addresses, which is no use here; its general sending service was announced as a beta and may not be open to this account. |
| **B. Amazon SES** | Amazon Web Services, Inc. | Mature, cheap, regional. Open and click tracking exist only if a "configuration set" with tracking is attached, so with none attached there is no tracking at all, by construction. | A new vendor, and an AWS account to secure. |
| C. Postmark | ActiveCampaign, LLC | Very good deliverability for transactional mail; tracking is off unless turned on. | A new vendor; keeps message content for a retention period that has to be set. |

**Recommendation:** A if it's available to the account when we build. If not,
B, in the region the CISO picks, with no configuration set and no event
publishing. Whichever is chosen is the **only** outside service that ever sees
an address, and only for the moment of sending. Its retention of sent-message
logs has to be checked and set to the minimum.

**Sending domain:** a subdomain such as `mail.ronna.mom`, with SPF, DKIM and
DMARC set to `p=reject` in Cloudflare DNS. *The sender address is [COPY]
for the CBO.*

**Content:**
- From: RonnaOps, at the address above. Subject: [COPY].
- Plain-text part plus a minimal HTML part saying the same thing.
- One sentence on what this is. **One link**, the confirm URL, written out in
  full in the plain-text part.
- One line: "If this wasn't you, ignore this email. The address will be
  deleted in 48 hours and nothing else happens."
- Footer: RonnaOps and a link to `https://ronna.mom/privacy/`.
- **Never:** remote images, tracking pixels, link redirects or rewriting,
  open or click tracking, web beacons, marketing content, or attachments.
- No `List-Unsubscribe` header, since this is a one-off transactional
  message, not a list mailing. Later list mailings (launch news) would need it
  and a one-click unsubscribe; that is a separate design.

**The delete email** (section 6) follows the same rules, with its own single link.

---

## 5. Rate limiting and bot protection, without a CAPTCHA vendor

Defences, in layers:

1. **Double opt-in.** A bot that submits addresses gets nothing confirmed; at
   most it causes confirm emails, which the next layers cap.
2. **Cloudflare WAF rate-limiting rule** on `POST /api/*`, for example 5
   requests per 10 minutes per IP, then a block for 10 minutes. Configured in
   the dashboard, not in code. (The Free plan allows a small number of such
   rules; *verify the current limit*.)
3. **Per-address limits in the function**, using the Pages Functions rate
   limiting binding keyed by `email_hash` (never by the address itself): at
   most 3 confirm emails and 3 delete emails per address per 24 hours.
4. **Honeypot.** A text field named `website`, hidden from people with CSS and
   `aria-hidden`, and skipped by Tab. Bots that fill every field get the usual
   `202` and nothing is sent.
5. **Uniform replies.** Every outcome returns the same status and body, so a
   bot learns nothing to tune against.
6. **Cloudflare Bot Fight Mode** (a free, site-wide setting) as an option
   for the CISO. It challenges known bots before they reach the page.

**No CAPTCHA.** The form's human-check slot stays empty. If abuse shows up
despite the layers above, the fallback is Cloudflare Turnstile. It is
Cloudflare's own product, so no new vendor, but it loads a script and a frame
from `challenges.cloudflare.com`. That would need its own CISO ruling and two
CSP changes (section 10).

**Monitoring:** daily counts of signups, confirmations and blocked requests
(section 7). If confirm emails sent far outnumber confirmations, tighten the
limits.

---

## 6. Deletion on request

**Self-serve, through `/off/`** ("Take me off the list"):
1. The visitor enters an email; the page sends `POST /api/delete-request`.
2. The reply is always the same: "If that address is on the list, we've sent
   a link."
3. If a row exists, a `delete` token is minted (48 hours, single use) and an
   email sent with `https://ronna.mom/off/#t=<token>`.
4. That page shows a **Delete** button. The click sends `POST /api/delete`
   with the token, and the function **hard-deletes** the signup row and all
   its tokens. It then replies "Done. The address is off the list."

**By request:** a person can write to the privacy contact (address [COPY],
for counsel and the CISO). An operator runs one documented delete by
address, which hashes the address and deletes by `email_hash`. The request is
answered and nothing else is kept.

**What remains after deletion:** nothing in D1 except Time Travel's window
(section 2). The email sender's sent-message log keeps whatever its own
retention allows; set it to the minimum. Aggregate counts (section 7) carry
no identity.

**Pending rows** are deleted automatically after 48 hours (section 2), so an
address someone else typed without permission is gone without any action.

---

## 7. What is logged

**Rule: never the email, never the token, never the IP, in any log we control.**

**Allowed:** one line per request, with event and outcome, for example
`signup accepted`, `signup limited`, `confirm ok`, `confirm expired`,
`delete ok`, `send failed (provider code)`. Daily counts of the same.

**How that holds:**
- **URLs:** emails and tokens are only ever in POST bodies, and tokens in
  links sit after `#`. Cloudflare's own request records (analytics, any
  Logpush) see paths like `/api/signup` and `/confirm/`, nothing more.
- **Code:** functions log through one helper that accepts only a fixed list
  of event names and numbers. A test fails the build if any `console.*` call
  passes a request body, an email-shaped string or a token.
- **Errors:** caught and logged as an event name and an error class, never
  the message from a database or the sender, which could echo input.
- **Function logs:** Cloudflare's function logs (if turned on) keep what the
  code prints plus request metadata. The above keeps both clean. Logpush to
  any outside destination stays off.
- **IP addresses** are seen by Cloudflare at the edge, as for any visit, and
  used by the rate-limit rule. We don't store them and our code doesn't log them.

---

## 8. Changes the site would need (once approved)

- `functions/api/signup.*`, `confirm.*`, `delete-request.*`, `delete.*`: the
  four endpoints above. They hold no secrets in code and are covered by tests
  that run without a network.
- `/` and `/what/`: the form posts JSON with `fetch` to `/api/signup` and
  shows the existing "Check your email." step. Add the honeypot. The
  human-check slot is removed, or kept empty for the Turnstile fallback.
- `/confirm/`: reads `#t`, shows **Confirm**, posts, then shows the place
  number from the reply. The existing preview note is removed at launch.
- `/off/`: the request form plus the `#t` **Delete** step.
- `/privacy/`: updated by the CBO and counsel to match this design: the
  sender vendor, the 48-hour pending deletion, and the Time Travel window.
- Tests: the browser test keeps "nothing leaves the site". Same-origin
  `/api/` calls are the only connections allowed, and outside hosts stay forbidden.

---

## 9. `/invite/` later

**Same mechanism, purpose `invite`:**
- Issued for one named address. Single use, valid 7 days, only the hash stored.
- The link is `https://ronna.mom/invite/#t=<token>`. The page shows
  **Accept**, posts the token, and the function checks it the same atomic way.
- On success the page shows the next step.

**Open question for the CPO and CISO: who issues invites, and what "next
step" is.** This site must not call the MOM product's systems, so two shapes fit:
1. **The site only invites people from its own list.** An operator marks
   chosen `confirmed` rows, each gets an invite email, and accepting simply
   records `accepted_at`. What happens after that is outside this site.
2. **The product issues invites itself** and its emails link to `/invite/`
   only as a landing page. The page then sends the person on, with the token
   still after `#`, to an address the CPO names. The site stores and checks
   nothing for invites.

Either way: no invite token in a URL path or query, `no-referrer` and
`no-store` on `/invite/` (as on `/confirm/`), and invites carry no personal
data beyond the address they were sent to.

---

## 10. Header changes this design would need

Each is a separate line for the CISO to approve or refuse:

| Header | Today | With this design | Why |
|---|---|---|---|
| CSP `connect-src` | `'none'` | `'self'` | The pages post JSON to `ronna.mom/api/...`. Still no outside host. |
| CSP `form-action` | `'none'` | `'none'` (unchanged) | Posting is done by `fetch`, not native form submits. |
| `/invite/*` `Cache-Control` | none | `no-store` | Same reason as `/confirm/*`. |
| CSP `script-src`, `frame-src` | `'self'`, none | add `https://challenges.cloudflare.com` **only if** the Turnstile fallback is approved | Turnstile's script and frame. |

`Referrer-Policy`, `Permissions-Policy`, `frame-ancestors`, `nosniff` and
`noindex` stay as drafted in issue #15.

---

## 11. Every outside service

| Service | Vendor | What it does here | Sees subscriber data? |
|---|---|---|---|
| Cloudflare Pages | Cloudflare, Inc. | Hosts the site from `public/`. | No (static files). |
| Cloudflare Pages Functions | Cloudflare, Inc. | Runs the four `/api/` endpoints on ronna.mom. | Yes, in memory while handling a request. |
| Cloudflare D1 | Cloudflare, Inc. | Stores signups (encrypted) and token hashes. | Yes, encrypted at rest by us, and by Cloudflare beneath. |
| Cloudflare WAF rate limiting, Bot Fight Mode | Cloudflare, Inc. | Blocks floods and known bots at the edge. | IP addresses, as for any visit; not stored by us. |
| Cloudflare secrets (Pages environment variables) | Cloudflare, Inc. | Hold the two keys and the sender's API key. | No (keys only). |
| Cloudflare DNS | Cloudflare, Inc. | Serves ronna.mom and the mail records (SPF, DKIM, DMARC). | No. |
| **Email sender: one of** Cloudflare email sending / Amazon SES / Postmark | Cloudflare, Inc. / Amazon Web Services, Inc. / ActiveCampaign, LLC | Delivers confirm and delete emails. | Yes: the address and the email it is sent, for that sender's log retention. |
| GitHub | GitHub, Inc. (Microsoft) | Hosts this repo; pushes to `main` trigger deploys. | No. Code and docs only, never subscriber data or keys. |
| Cloudflare Turnstile (**fallback only, not proposed**) | Cloudflare, Inc. | Human check if the layers in section 5 aren't enough. | A browser challenge; no address. |
| Domain registrar for ronna.mom | *To confirm: whoever holds the registration* | Holds the domain. | No. |

**Not used:** analytics of any kind, a CAPTCHA vendor, a mailing-list or CRM
service, outside font or script hosts, tracking pixels, or any service owned by
the MOM product.

---

## 12. Decisions for the CISO

1. Approve D1 as the only store, with per-row encryption and a keyed hash, and choose its region.
2. Choose the email sender (A, B or C) and its log retention.
3. Approve the token scheme: 256-bit random, hash stored, single use, 48 hours (7 days for invites), `#` fragment plus a button.
4. Approve the bot layers without a CAPTCHA, and whether Bot Fight Mode is on.
5. Approve the deletion paths and the Time Travel disclosure.
6. Approve the logging rule and the test that enforces it.
7. Keep or drop `audience` (Home or Business) in the stored row.
8. Approve the header changes in section 10, line by line.
9. With the CPO: who issues invites (section 9).
10. Set when the whole list is deleted after the waitlist closes.
