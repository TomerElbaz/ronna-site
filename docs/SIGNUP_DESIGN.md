# Waitlist signup design — FOR CISO

Status: **design only, revised to meet CISO rule 69 (9 Oct 2026, 03:26).**
Nothing here is built. The site today collects nothing: the form's action is
empty, its submit is held in the browser, and the Content-Security-Policy
blocks form posts and all outside connections. Nothing in this design is
switched on until the CISO approves it in the CPO chat.

Author: Web build desk (Claude Code, cloud). Lives in `docs/`, which
Cloudflare Pages does not publish.

Scope: the ronna.mom waitlist only. `/invite/` is **out of scope** (rule 69.10).

---

## 0. Rule 69, point by point

| # | Rule | Where it is met |
|---|---|---|
| 1 | Own Worker and own D1, never any MOM binding; neither side can read the other | §1 |
| 2 | Per row only: email, status, created and confirmed times; no name, IP or user agent | §2 |
| 3 | Token ≥128 random bits, only its hash stored, 24 h expiry, single use; unconfirmed rows deleted after 7 days | §3 |
| 4 | Same answer every time ("Check your inbox"); no way to learn who is on the list | §4 |
| 5 | One transactional email service, named, with a link to its privacy terms; CISO yes before its key exists; key is a Worker secret, never in the repo; plain links, no pixels, no link rewriting, one-click delete link | §5 |
| 6 | Rate limits per salted IP hash (salt rotated daily, counters only), plus a global cap; Cloudflare's own bot check if one is needed | §6 |
| 7 | Logs never hold the email, token or IP; counts and error kinds only | §7 |
| 8 | Page: no analytics, no third-party scripts or fonts, strict CSP, a two-line notice above the button | §8 |
| 9 | Delete link removes the row at once; a reply asking for deletion is done by hand within 7 days | §9 |
| 10 | `/invite/` out of scope | Not designed here. `/invite/` stays the static placeholder it is today. |

---

## 1. Own Worker, own D1 (rule 1)

- **One Cloudflare Worker that belongs to this site alone**, called
  `ronna-site-signup` here. Its code would live in this repo under `worker/`
  (not yet written).
- It is reachable **only through routes on `ronna.mom`**:
  `ronna.mom/api/signup`, `/api/confirm`, `/api/delete`. Its default Cloudflare
  subdomain is turned off, so it has no other address.
- **One D1 database that belongs to it alone**, called `ronna-site-waitlist`
  here.
- **Bindings:** the Worker has exactly one D1 binding, to `ronna-site-waitlist`,
  plus its secrets (§5, §6). It has **no binding to any MOM product resource**:
  not the MOM product's tenant database named in rule 69, and no other MOM
  database, KV namespace, queue, service binding or Worker. It never calls the
  MOM product over the network either.
- **Neither side can read the other:** no MOM product resource is bound to
  `ronna-site-waitlist` or to this Worker, and this Worker is bound to none of
  theirs. Deploys use a Cloudflare API token **scoped to this Worker, its route
  and this one D1 database**, so a leaked deploy token can't reach anything else.
  If the CISO wants the separation enforced by the account itself as well,
  the Worker and D1 can live in a **separate Cloudflare account** that holds
  only the `ronna.mom` zone. This doc recommends that.
- **The static site stays on Cloudflare Pages**, serving `public/` as today.
  The Worker only answers `/api/*`.

---

## 2. What each row holds (rule 2)

**Table `signups`: four columns, nothing else.**

| Column | Holds |
|---|---|
| `email` | The address, trimmed and lower-cased. Primary key. |
| `status` | `pending` or `confirmed`. |
| `created_at` | When the signup was made (UTC, to the second). |
| `confirmed_at` | When it was confirmed; empty while pending. |

Not stored anywhere: name, IP address, user agent, referrer, cookies,
Home/Business choice, device data. The place number shown on `/confirm/` is
**computed** (confirmed rows with an earlier `confirmed_at`, plus one), not
stored.

**Supporting table `tokens`** (needed so that only a hash is kept, rule 3):

| Column | Holds |
|---|---|
| `token_hash` | SHA-256 of the token. Primary key. The token itself is never stored. |
| `email` | The row it belongs to. Deleted with that row. |
| `kind` | `confirm` or `delete`. |
| `expires_at` | 24 h after creation for `confirm`; empty for `delete` (valid while the row exists). |

It holds no personal data beyond the `email` key that ties it to its row.
**Question for the CISO:** does this supporting table fit rule 2? If not, §3's
alternative removes it for confirm tokens.

**Rate-limit tables** (§6) hold salted IP hashes and counts only, for one day.

D1 encrypts data at rest on Cloudflare's side. No application-level encryption
is added, because rule 2 keeps the row to the bare address and the lookup has
to be by address. The CISO may ask for it; it would add a key and a hash column.

---

## 3. Confirm token (rule 3)

- **Token:** 32 bytes (256 bits, above the 128-bit floor) from
  `crypto.getRandomValues`, written as base64url (43 characters).
- **Stored:** only its SHA-256, in `tokens`.
- **Expiry:** 24 hours.
- **Single use:** confirming runs one statement that **deletes** the token row
  where the hash matches, the kind is `confirm` and it hasn't expired, and
  returns its `email`. A token can be deleted only once, so a second use finds
  nothing.
- **Link:** `https://ronna.mom/confirm/#t=<token>`. The token sits after `#`,
  so it is never sent in a request line and never reaches Cloudflare's request
  logs. The page reads it, clears it from the address bar, and posts it in a
  request body when the person clicks **Confirm**. A click is needed because
  mail scanners open links, and a plain link that confirmed would let a scanner
  confirm someone.
- **Unconfirmed rows** (`pending`) are **deleted 7 days** after `created_at`,
  with their tokens. A daily scheduled run of the Worker (a Cron Trigger)
  does this, and also deletes expired tokens and the previous day's
  rate-limit data (§6).
- "Send the link again" within those 7 days mints a new token and deletes the
  old one. At most one live confirm token per address; resends are throttled
  (§6).

*Alternative, only if the CISO wants no `tokens` table for confirms:* a
stateless token, an HMAC over `email | created_at` with a Worker secret.
Nothing is stored, but single use then depends on `status` flipping to
`confirmed`, and 24-hour expiry depends on the timestamp in the token. This doc
recommends the stored-hash version above, because single use is exact there.

---

## 4. Same answer every time (rule 4)

- The page validates only the shape of the address (something@something.tld)
  before sending. Anything that passes is **plausible** and goes to the Worker.
- For every plausible address the Worker returns the **same status, the same
  body and roughly the same time**: `202` with `{"ok": true}`. The page then
  shows the same "Check your inbox" step. This holds whether the address is:
  - **new:** a `pending` row is made and a confirm email sent;
  - **pending:** a new token is sent, unless one went out in the last hour;
  - **confirmed:** nothing is sent;
  - **plausible but undeliverable, or rate-limited, or over the global cap:**
    nothing is sent.
- Timing: the Worker answers after a fixed short delay floor (for example
  400 ms), whichever path ran. The email itself is sent after the reply goes
  back, so a slow send doesn't show.
- `/off/` (self-serve deletion request, §9) answers the same way, with "If
  that address is on the list, we've sent a link."
- **Copy note for the CPO:** rule 69 says "Check your inbox"; the page's
  current in-page step, quoted by the CPO earlier, says "Check your email."
  The rule is that the answer is identical; the exact words are the CPO's and
  the CBO's to settle.

---

## 5. The email service (rule 5)

**One service: Amazon Simple Email Service (Amazon SES)**, from Amazon Web
Services, Inc.
- Privacy terms: AWS Privacy Notice, <https://aws.amazon.com/privacy/>
- Data protection terms: AWS Data Privacy FAQ, <https://aws.amazon.com/compliance/data-privacy-faq/>
- Region: one region the CISO picks (for example `eu-west-1`).

Why SES:
- Open and click tracking exist in SES only through a "configuration set"
  with tracking turned on. **None will be created**, so there is no pixel and
  no link rewriting by construction, not by a setting someone can flip.
- It sends plain transactional mail with a domain we authenticate (SPF, DKIM,
  DMARC `p=reject` on a subdomain such as `mail.ronna.mom`).

*Cloudflare's own email sending was considered. It would keep everything
inside Cloudflare, but its availability to this account was not confirmed, and
rule 69 asks for one named service. Switching later would need a new CISO yes.*

**The key:**
- An AWS IAM user or role allowed **only** `ses:SendEmail` from the one
  verified identity.
- Its key is created **only after the CISO's yes**, and stored as a **Worker
  secret** (set in the Cloudflare dashboard, or through the CLI's secret
  command, by the CISO's delegate). **Never in this repo**, never in a file,
  never in chat.
- The repo's existing self-test already fails on secret-shaped strings in
  published files. When `worker/` exists, the same scan covers it.

**Every email is plain:**
- A plain-text part, plus a minimal HTML part with the same words. No images,
  no remote resources, **no tracking pixels, no link rewriting**, no
  attachments, no marketing.
- **The confirm email** carries two links, both written out in full:
  1. Confirm: `https://ronna.mom/confirm/#t=<token>`
  2. **Delete: `https://ronna.mom/off/#d=<delete token>`.** One click
     removes the address (§9).
- It also says: "If this wasn't you, ignore this email; the address is
  deleted in 7 days."
- Headers carry `List-Unsubscribe: <https://ronna.mom/api/delete?d=...>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), so mail apps
  can offer one-click delete too. *For the CISO:* this header form does put
  the delete token in a URL the server sees. The Worker logs no URLs (§7), but
  the CISO may prefer to drop the header and rely on the body link.
- From: `RonnaOps <list@mail.ronna.mom>` (the address is [COPY] for the CBO).
  Replies go to a mailbox that a person reads (§9).

---

## 6. Rate limits and bot check (rule 6)

**Per IP, using a salted hash, with counters only:**
- **Salt:** each UTC day the Worker makes a random 32-byte salt and stores it
  in `salts (day, salt)`. Rows older than today are deleted by the daily run,
  so yesterday's hashes can't be recomputed.
- **Key:** `SHA-256(salt || client IP)`. The IP itself is used only in memory
  to compute this, and is never stored or logged.
- **Counter:** `ip_counts (day, ip_hash, count)`, incremented per request to
  `/api/*`. Deleted with the day.
- **Limits** (starting values, for the CISO to set): 5 signup requests per IP
  hash per hour, 20 per day. Over the limit means the same `202` answer (§4)
  and nothing sent.

**Global cap:**
- `global_counts (day, kind, count)` for `signup_emails` and `delete_emails`.
- Cap (starting value): 500 confirm emails per day. Over it, the same answer
  and nothing sent, plus an `over-global-cap` count in the logs (§7) for
  someone to look at.

**Per-address throttle, with no new storage:** at most one confirm email per
address per hour, read from the existing token's creation time.

**Edge rule:** a Cloudflare WAF rate-limiting rule on `ronna.mom/api/*` as an
outer fence. It is Cloudflare's own, needs no code and stores nothing for us.

**Bot check, only if needed: Cloudflare Turnstile** (Cloudflare's own, per
rule 6), in the form's existing human-check slot. Not proposed for launch.
If turned on, the Worker verifies the token server-side, and the CSP gains
`https://challenges.cloudflare.com` in `script-src` and `frame-src` on that
ruling only.

---

## 7. Logs (rule 7)

- The Worker logs **only** fixed event names and counts, plus error kinds,
  through one helper that accepts nothing else. For example:
  `signup.accepted`, `signup.limited.ip`, `signup.limited.global`,
  `confirm.ok`, `confirm.invalid`, `delete.ok`, `send.error.throttled`,
  `send.error.rejected`, `db.error.timeout`.
- **Never:** the email, a token, an IP or its hash, request bodies, URLs with
  query strings, or the raw text of an error message from the database or SES,
  which could echo input.
- **Enforced by test**, when `worker/` exists: the self-test fails if any log
  call passes anything other than a known event name and numbers, and a unit
  test feeds a known address and token through every path and checks that the
  captured log output contains neither.
- Cloudflare's own logs: the token sits after `#` and the address travels in
  a POST body, so Cloudflare's request records see only paths like
  `/api/signup`. Worker log streaming to any outside destination stays off.

---

## 8. The page (rule 8)

What the site does today already meets the first three points:
- **No analytics.**
- **No third-party scripts or fonts.** Fonts are self-hosted. The link checker
  fails on any outside host, and the browser test fails if any request leaves
  the site.
- **Strict CSP**, drafted in issue #15. This design changes one line:
  `connect-src 'none'` → `connect-src 'self'`, so the page can post to
  `ronna.mom/api/*`. Still no outside host.

**New: a two-line notice above the button**, on `/` and `/what/`. Draft
wording, [COPY] for the CBO:

> We keep only your email and when you joined.
> Delete it any time with the link in every email, or at ronna.mom/off.

It will be added when the form is connected, and its two lines checked in
the browser test.

---

## 9. Deletion (rule 9)

**Delete link, removing the row at once:**
- Every email carries `https://ronna.mom/off/#d=<delete token>`. The delete
  token is minted with the row, and only its hash is stored (`kind = delete`).
- Opening the link runs the deletion straight away (one click). The page
  posts the token, and the Worker deletes the `signups` row and all its
  `tokens` rows in one transaction. The page then says it is done.
- A mail scanner that opens the link would also delete the row. The only
  harm is that the person signs up again; no data is exposed. The CISO may
  prefer a confirm button here as on `/confirm/`, at the cost of the one-click rule.
- `/off/` without a token: a form that sends a fresh delete link to the
  address, with the same answer every time (§4).

**Reply asking for deletion:** replies to the sender address reach a mailbox
that a named person reads. Within **7 days** they delete the address by hand,
using one documented admin command, and answer from that mailbox.

**What is gone, and when:**
- The row and its tokens leave `signups` and `tokens` **at once**.
- D1 keeps point-in-time recovery (Time Travel) for a fixed window, last
  known as 7 days on the Free plan and 30 on Paid. *Verify on the account.* For
  that window an operator could restore a database copy that still holds the
  row.
- SES keeps sending logs per its own terms. No message content is stored by
  us.
- The privacy page must say all of this. **For the CISO:** does "at once" in
  rule 9 accept the restore window, or should restores be forbidden by
  procedure?

---

## 10. Every outside service

| Service | Vendor | Why | Sees an address? |
|---|---|---|---|
| Cloudflare Pages | Cloudflare, Inc. | Serves the static site (`public/`). | No. |
| Cloudflare Worker `ronna-site-signup` | Cloudflare, Inc. | Runs `/api/signup`, `/api/confirm`, `/api/delete`. | Yes, in memory while handling a request. |
| Cloudflare D1 `ronna-site-waitlist` | Cloudflare, Inc. | Stores the four-column rows and token hashes. | Yes, at rest. |
| Cloudflare WAF rate limiting; Turnstile only if needed | Cloudflare, Inc. | Outer rate fence; bot check if ever required. | No. |
| Cloudflare DNS | Cloudflare, Inc. | `ronna.mom` and the mail records (SPF, DKIM, DMARC). | No. |
| **Amazon SES** | Amazon Web Services, Inc. ([privacy](https://aws.amazon.com/privacy/)) | Sends the confirm and delete emails. | Yes, to send; kept in its logs per its terms. |
| A mailbox for replies | *To name: who runs it* | Hand-handled deletion requests (§9). | Yes, the replies. |
| GitHub | GitHub, Inc. | Hosts this repo. | No. Code only, never addresses or keys. |

**Not used:** analytics, a CAPTCHA vendor, a mailing-list or CRM service,
outside fonts or scripts, tracking of any kind, or **any MOM product resource**.

---

## 11. Open points for the CISO

1. Does the supporting `tokens` table fit rule 2 (§2), or take the stateless alternative for confirms (§3)?
2. Separate Cloudflare account for the Worker and D1 (§1): yes or no.
3. Amazon SES, and its region (§5). Your yes comes before any key exists.
4. Keep or drop the `List-Unsubscribe` header, since it puts a token in a server-seen URL (§5).
5. Rate-limit numbers and the global cap (§6).
6. One-click delete versus a button on `/off/` (§9).
7. Whether the D1 restore window is acceptable under rule 9, and how the privacy page words it (§9).
8. Who runs the reply mailbox (§9, §10).
