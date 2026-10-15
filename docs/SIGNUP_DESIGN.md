# Waitlist signup design — FOR CISO

Status: **cleared by the CISO with changes (rule 74, 9 Oct 2026, 05:28) and
built on the branch in `worker/`, with every point of rules 69, 72 and 74 as a
hard test (rule 70). Not deployed; no SES key exists.** §13 records rule 74's
changes and how each is built. Earlier sections are the design as cleared; where
§13 differs, §13 is what was built.

Author: Web build desk (Claude Code, cloud). Lives in `docs/`, which
Cloudflare Pages does not publish.

Scope: the ronna.mom waitlist, and invitations to it (§12, "Invitations,
half 1"). Rule 69.10 put `/invite/` out of scope; the CISO's rule 72 now sets
the terms for it, so §12 is designed to rule 72 on top of rule 69.

Per the CPO (04:30), signup and invites are built together, with every point
of rules 69 and 72 written as a test, once the CISO has read this design.

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
| 10 | `/invite/` out of scope | Superseded for invitations by rule 72; see §12. Nothing else of `/invite/` is designed. |

---

## 1. Own Worker, own D1 (rule 1)

- **One Cloudflare Worker that belongs to this site alone**, called
  `ronna-site-signup` here. Its code would live in this repo under `worker/`
  (not yet written).
- It is reachable **only through routes on `ronna.mom`**:
  `ronna.mom/api/signup`, `/api/confirm`, `/api/delete`, and for invitations
  (§12) `/api/invite/*` (public) and `/api/family/*` and `/api/operator/*`
  (both behind Cloudflare Access). Its default Cloudflare subdomain is turned
  off, so it has no other address.
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
- Region: `us-east-2` (US East, Ohio), set by CISO rule 73(3).

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
| Cloudflare Access (Zero Trust) | Cloudflare, Inc. | Signs in family owners and Tomer before they can mint or revoke invite codes (§12). | Yes: the owner's sign-in email, in Cloudflare's own Access logs (§12.9). |
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
9. Invitations: the points in §12.11.

---

## 12. Invitations, half 1 (rule 72, on top of rule 69)

Half 1 is the design. Half 2 is the build, done together with signup once
the CISO has read this, with every point below as a test (§12.10).

### 12.0 Rule 72, point by point

| # | Rule | Where it is met |
|---|---|---|
| 1 | Only an owner of an active family mints, through a route behind Cloudflare Access in the waitlist Worker; family is an opaque ID; nothing binds this Worker to MOM; max 5 live codes, a sixth refused | §12.1, §12.2 |
| 2 | ≥80 random bits from the crypto RNG; 16 Crockford base32 characters in groups of 4; only SHA-256 stored; shown once | §12.3 |
| 3 | Code never in a server-logged URL; `/invite/#code` or typed; POST body only; no-referrer; a test that no request URL contains a code | §12.4 |
| 4 | Invite page shows "Invited by" and a chosen first name (max 20 characters, no surname), nothing else | §12.5 |
| 5 | One reply for every bad code: "This invite isn't valid.", same status and timing | §12.5 |
| 6 | Reserved on submit, spent only at `/confirm/`, atomically; released if confirmation lapses | §12.6 |
| 7 | 30-day expiry; the inviter or Tomer can revoke at once | §12.7 |
| 8 | Rate limits per salted IP hash, 10 an hour, plus a global cap; 10 failures in an hour lock that hash for the hour | §12.8 |
| 9 | What is stored, for inviter and invitee; the inviter sees only used or unused | §12.2 |
| 10 | Logs: counts and error kinds only, never a code, hash, email, IP or name | §12.9 |
| 11 | Deletion: invitee's delete link removes the row and its link; a family leaving revokes unused codes, erases its display name, empties invited-by | §12.7 |
| 12 | MOM sends no invitations; the inviter shares the code; the referral line promises no move up the list | §12.5 |

### 12.1 Who mints, and where

- **Same Worker and D1** as signup (`ronna-site-signup`, `ronna-site-waitlist`),
  under every condition of rule 69. **Nothing binds this Worker to MOM**, and
  it never calls MOM. It learns nothing from the MOM product; whatever it
  knows about families is entered by Tomer (below).
- **Family pages:** `ronna.mom/family/` (a static page, `noindex`) and
  `ronna.mom/api/family/*` (Worker). Both sit behind **one Cloudflare Access
  application**, whose policy lets in only the sign-in emails Tomer lists for
  family owners. The Access allowlist lives in Cloudflare's dashboard, not
  in this repo.
- **Operator pages:** `ronna.mom/api/operator/*`, behind a **second Access
  application** that lets in only Tomer.
- **Every Access request is checked twice.** Access blocks it at the edge,
  and the Worker also verifies the `Cf-Access-Jwt-Assertion` token against
  Cloudflare's published Access signing keys, its audience tag and expiry. A
  request that skipped Access is refused even if a route were misconfigured.
- **Active families:** a family is "active" only while its row in `families`
  says so. Tomer sets that through the operator route, because this site
  can't and mustn't read the MOM product to find out.
- **Linking an owner to a family:** Tomer creates the family row, which gets a
  random opaque ID such as `fam_7K3QX9PDM2TAB4RN`, and a one-time
  **enrolment code** (same format as an invite code, hash only, 7 days, single
  use). He gives it to the owner by hand. The owner signs in through Access,
  enters it on `/family/`, and the Worker stores the owner's **Access user
  ID**, Cloudflare's opaque identifier for that sign-in, not their email,
  against the family. **This extra field is not in rule 72.9's list; see
  §12.11, point 1.**
- **Five live codes, a sixth refused:** "live" means unused or reserved, and
  not expired, revoked or spent. Minting a sixth while five are live returns
  a refusal and makes nothing. The check and the insert run in one
  transaction, so two clicks at once can't make six.

### 12.2 What is stored (rule 72.9)

**`families`, the inviter side:**

| Column | Holds |
|---|---|
| `family_id` | Random opaque ID. Never a name. |
| `display_first_name` | The first name the owner chose. 1 to 20 characters, one word (no spaces), letters plus `-` and `'`. Emptied when the family leaves. |
| `status` | `active` or `left`. |
| `created_at`, `left_at` | Times. |
| `owner_access_id` | *Proposed, needs the CISO's yes (§12.11, point 1):* the Access user ID that may act for this family. |

**`invite_codes`:**

| Column | Holds |
|---|---|
| `code_id` | Random opaque ID, used to refer to a code without its hash. |
| `code_hash` | SHA-256 of the normalised code (§12.3). Unique. |
| `family_id` | Who it belongs to. |
| `status` | `unused`, `reserved`, `used` or `revoked`. |
| `created_at`, `expires_at` | Times; `expires_at` is creation plus 30 days. |
| `reserved_until` | While reserved: when the reservation lapses (§12.6). |
| `used_at`, `revoked_at` | Times. |

**Invitee:** rule 69's `signups` row (email, status, created and confirmed
times), **plus `invited_by_family_id` and `invite_code_id`**, both empty for
people who signed up without a code. Rule 72.9 adds these two to rule 69.2.

**The inviter sees only used or unused.** `/family/` lists each code as
**used** or **unused**, with its expiry and a revoke button. Reserved shows
as unused. A revoked or expired code drops off the list. It never shows an
invitee's email, place or status, or any other detail.

### 12.3 The code (rule 72.2)

- **80 random bits** from `crypto.getRandomValues` (10 bytes), written as **16
  Crockford base32 characters** in **groups of 4**: `7K3Q-X9PD-M2TA-B4RN`.
  The alphabet is `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, which has no I, L, O
  or U.
- **Normalised before hashing:** upper-case it, drop hyphens and spaces, and
  read `I` and `L` as `1` and `O` as `0` (Crockford's rule), so a typed code
  matches the printed one.
- **Only `SHA-256(normalised code)` is stored.**
- **Shown once:** the mint response carries the code. `/family/` shows it
  with **Copy** and a line saying "This is the only time you'll see this
  code." The code isn't kept in the page's storage, and reloading shows it
  as **unused**, without the code.

### 12.4 The code stays out of logged URLs (rule 72.3)

- **Shared as** `https://ronna.mom/invite/#code=7K3Q-X9PD-M2TA-B4RN`, or typed
  into the box on `/invite/`. After `#`, the code is never sent to the server
  in a request line.
- `/invite/` reads the fragment, **clears it from the address bar at once**
  (`history.replaceState`), and sends the code **only in a POST body** to
  `/api/invite/lookup` and `/api/invite/redeem`.
- **No referrer:** `/invite/` keeps `<meta name="referrer"
  content="no-referrer">` (already in place), and `public/_headers` gains a
  `/invite/*` rule with `Referrer-Policy: no-referrer` and `Cache-Control:
  no-store`.
- **Test, `invite-code-never-in-url`:** the browser test opens
  `/invite/#code=<test code>`, walks lookup, submit and confirm, and records
  every request the browser makes. It fails if any request URL (path or
  query) contains the code in any form: grouped, ungrouped or lower-case. A
  Worker unit test also fails if any route reads a code from a URL.

### 12.5 The invite page (rules 72.4, 72.5, 72.12)

1. **Lookup.** The page posts the code to `/api/invite/lookup`.
   - If the code is **valid**, the Worker returns the inviter's display first
     name, and the page shows **"Invited by"** and that name, **nothing
     else** about the inviter. The name is inserted as text, never as HTML.
   - Every **bad** code (wrong, expired, revoked, used, or reserved by
     someone else) gets **one reply**: the same status (`200` with
     `{"ok": false}`), the same body and the same timing floor (for example
     400 ms whichever path ran). The page shows **"This invite isn't
     valid."**
2. **Join.** With a valid code, the page shows the email field, rule 69's
   two-line notice above the button, and the **referral line**:
   "An invite doesn't move you up the list." ([COPY] for the CBO; rule
   72.12 sets what it must say, not its words.)
3. **Submit.** The page posts `{code, email}` to `/api/invite/redeem`.
   - A bad code still gets "This invite isn't valid."
   - Otherwise the reply is rule 69's same answer, "Check your inbox", for
     every plausible address, new or already on the list.
4. **Place on the list ignores invites.** The place is computed from
   `confirmed_at` alone (§2), and a test checks that being invited never
   changes it.
5. **MOM sends no invitations.** No email is sent to an invitee because of a
   code. The only email an invitee gets is rule 69's confirm email, after
   they submit their own address. The inviter shares the code themselves.

### 12.6 Reserve on submit, spend at confirm (rule 72.6)

- **Reserve, on `/api/invite/redeem`,** in one statement: set the code
  `reserved` with `reserved_until` = confirm-token expiry (24 h, rule 69.3),
  only where it is `unused` (or `reserved` with `reserved_until` passed), not
  revoked and not expired.
  - **One of two concurrent requests wins.** The update matches one row once;
    the loser sees no row and gets "This invite isn't valid."
  - The pending signup records `invite_code_id` and `invited_by_family_id`.
  - If the email is already on the list, nothing is reserved, and the reply
    is still "Check your inbox" (rule 69.4).
- **Spend, at `/confirm/`,** inside the same transaction that uses the
  confirm token (§3): set the code `used` only where it is `reserved` for this
  signup's `invite_code_id` and the reservation hasn't lapsed. Again, exactly
  one wins.
- **Released if confirmation lapses:** a reservation whose `reserved_until`
  has passed counts as unused for reservation (above). The daily run (§3)
  also resets lapsed reservations to `unused`, provided the code hasn't
  expired.
  - If the person confirms after the lapse, they still join the waitlist (the
    signup is theirs), but **without the invited-by mark**, since the code
    wasn't spent.
  - If someone else reserved the code meanwhile, theirs stands.

### 12.7 Expiry, revoking, families leaving (rules 72.7, 72.11)

- **30-day expiry** from minting. An expired code is a bad code (§12.5).
- **Revoke at once:**
  - the owner, on `/family/`, for any of their unused codes;
  - Tomer, through `/api/operator/revoke`, for any code, or for all of a
    family's unused codes.
  Revoking takes effect on the next request.
  - **A reserved code revoked before confirmation:** the person can still
    confirm and join, but without the mark (§12.11, point 4).
- **Invitee deletes themselves** (rule 69's delete link): the `signups` row
  goes, taking `invited_by_family_id` and `invite_code_id` with it. The
  code's own row doesn't point back at the invitee, so nothing else
  connects them.
- **A family leaves** (Tomer marks it `left`), in one transaction:
  - all its unused and reserved codes become `revoked`;
  - `display_first_name` is **erased** (set empty);
  - `owner_access_id` is erased;
  - every invitee row with that `invited_by_family_id` has it **emptied**,
    along with `invite_code_id`.
  Tomer also removes the owner from the Access allowlist.

### 12.8 Rate limits (rule 72.8)

- **Same salted IP hash as rule 69.6:** a fresh random salt each day,
  deleted the next day, counters only.
- **10 requests an hour per IP hash** across `/api/invite/*`.
- **Global cap:** for example 200 redeems a day site-wide, for the CISO to
  set. Over the cap, every code gets "This invite isn't valid." and nothing is
  reserved.
- **Lockout:** 10 bad-code replies in an hour from one IP hash **lock that
  hash for the hour**. While locked, every request gets "This invite isn't
  valid." with the same timing, so the lock itself isn't visible. Counted in
  `invite_failures (hour, ip_hash, count)`, deleted after the hour.
- **Family routes** are rate-limited per Access user ID: for example 20 mints
  a day, well above the 5-live cap.
- **Guessing isn't practical:** 2^80 codes, with at most 10 tries per IP hash
  per hour, gives no realistic chance of hitting a live code.

### 12.9 Logs (rule 72.10)

- Same rule as §7: fixed event names, counts and error kinds only. For
  example `invite.minted`, `invite.mint_refused_cap`, `invite.lookup_bad`,
  `invite.reserved`, `invite.spent`, `invite.reservation_lapsed`,
  `invite.revoked`, `invite.locked`, `family.left`.
- **Never:** a code, a code hash, a code ID, a family ID, an email, an IP or
  its hash, or a display name. Enforced by the same log tests as §7.
- **For the CISO:** Cloudflare Access keeps its own sign-in logs, and they
  record the email each owner signed in with. Those are Cloudflare's logs,
  not ours, but they do hold an email. They can be kept short in the Access
  settings (§12.11, point 2).

### 12.10 Rules 72 and 69 as tests (built in half 2)

Each of these fails the build when its rule breaks:

| Test | Rule |
|---|---|
| `mint-requires-access-jwt`: no JWT, a forged one, or a wrong audience is refused | 72.1 |
| `mint-requires-active-family`: a `left` family, or an unknown Access user, can't mint | 72.1 |
| `mint-sixth-refused`: five live, the sixth refused, even with two at once | 72.1 |
| `no-mom-binding`: the Worker's config has exactly the D1 binding and secrets listed in §1 | 72.1, 69.1 |
| `code-shape`: 16 Crockford characters in 4 groups; ≥80 bits; RNG is `crypto.getRandomValues` | 72.2 |
| `code-hash-only`: after minting, the DB holds the hash and not the code | 72.2 |
| `code-shown-once`: the code appears only in the mint response | 72.2 |
| `invite-code-never-in-url` (browser) and `no-route-reads-code-from-url` (unit) | 72.3 |
| `invite-no-referrer`: `/invite/` sends `no-referrer`, by meta and by header | 72.3 |
| `invite-shows-only-first-name`: the page shows "Invited by" plus the name and nothing else; a name over 20 characters or with a space is refused at save | 72.4 |
| `bad-code-one-reply`: wrong, expired, revoked, used and reserved codes get the same status and body, with timing within a set tolerance | 72.5 |
| `reserve-one-wins` and `spend-one-wins`: two at once, one succeeds | 72.6 |
| `reservation-lapses`: after 24 h unconfirmed, the code can be reserved again | 72.6 |
| `expiry-30-days`, `revoke-at-once` (owner and Tomer) | 72.7 |
| `rate-10-an-hour`, `global-cap`, `lock-after-10-failures` | 72.8 |
| `inviter-sees-used-unused-only`: the family response holds no email or invitee detail | 72.9 |
| `logs-clean`: drives every path with known codes, emails, IPs and names, and fails if any appears in captured logs | 72.10, 69.7 |
| `invitee-delete-removes-link` and `family-leave-erases` | 72.11 |
| `invite-sends-no-email` and `place-ignores-invites` | 72.12 |
| …plus one test per point of rule 69 (§0) | 69 |

### 12.11 Open points for the CISO on invitations

1. **The owner-to-family link:** rule 72.9's list has no field linking an
   Access sign-in to a family, but rule 72.1 needs one. Proposed:
   `owner_access_id`, Cloudflare Access's opaque user ID (not an email),
   set by a one-time enrolment code Tomer hands the owner (§12.1). Approve,
   or name another way.
2. **Access sign-in logs** hold owners' emails, in Cloudflare's own logs
   (§12.9). Accept, and set their retention to the shortest available?
3. **The global redeem cap** and the per-owner mint limit (§12.8).
4. **A reserved code revoked before confirmation:** the person joins without
   the mark (proposed), or isn't allowed to confirm?
5. **Display-name rule:** one word, letters, `-` and `'`, max 20. Is that
   enough to keep surnames out, or should Tomer review names before they
   show?

---

## 13. Rule 74, and what was built

Built in `worker/` (Worker, schema, config) and wired into the pages
(`public/assets/site.js`, `/confirm/`, `/off/`, `/invite/`, `/family/`). Tests:
`tests/worker/rule69.test.mjs`, `tests/worker/rule72.test.mjs` (Worker) and
`tests/browser_check.mjs` (pages, end to end). Not deployed; no SES key.

| # | Rule 74 | Built as | Test |
|---|---|---|---|
| 1 | Owner link in `family_owners (family_id, owner_access_id)`, at most 2 per family; the Access user ID from the verified JWT's `sub`; enrolment codes in rule 72's format, hash only, 7 days, single use, handed over by Tomer himself, never emailed | Table as named, `owner_access_id` unique. `/api/family/enrol` links the signed-in `sub` in one transaction, which checks the code, its expiry, an active family and fewer than 2 owners, then deletes the code. Tomer gets the enrolment code once from `/api/operator/family/enrolment-code`; nothing emails it. | `74.1 enrolment codes…`, `74.1: the owner link is the verified JWT's sub…` |
| 1 | Separate Access applications for family and operator routes, each checking its own audience tag; an operator token refused on a family route and the reverse | `verifyAccess(request, env, "family" or "operator")` accepts only `FAMILY_AUD` or only `OPERATOR_AUD`, as well as checking the signature, issuer, expiry and `sub`. | `74.1: an operator token is refused on a family route, and a family token on an operator route`; `mint-requires-access-jwt` |
| 1 | When a family leaves, its owner rows are erased | `/api/operator/family/leave` deletes `family_owners` and `enrolment_codes` rows for it, in the same transaction as the rule 72.11 steps. | `family-leave-erases` |
| 2 | Zero Trust Free (Access logs 24 h); the family page says Cloudflare logs the sign-in email for a day | `/family/` opens with that notice. The plan is set at setup (README). | browser: `e2e family: rule 74.2 notice` |
| 3 | 200 redeems a day site-wide; 20 mints a day per owner | `LIMITS.redeemsPerDay = 200`, `LIMITS.mintsPerOwnerDay = 20` (`worker/src/limits.js`). | `global-cap`, `74.3: 20 mints a day per owner` |
| 4 | A reserved code revoked before confirmation: the person joins, without the mark | At confirm, the code is spent only if it is still `reserved` for this signup; otherwise the mark is cleared in the same batch. | `74.4: a reserved code revoked before confirmation…` |
| 5 | Display name: one word, letters plus `-` and `'`, max 20, inserted as text | `validDisplayName` (Unicode letters, so accented names work); pages insert it with `textContent`. | `display names…`; browser `invite-shows-only-first-name` (checks `innerHTML` is the bare name) |
| 6 | Operator application lets in Tomer only, with two-factor sign-in; the lockout stays invisible | Access configuration at setup (README, "When the CPO says go"); the Worker refuses any token without the operator audience. A locked hash gets the bad-code reply, with the same status, body and timing. | `bad-code-one-reply` (includes the locked case) |

**Choices made while building, for the CISO to see:**

1. **Lockout (72.8).** Ten failures in a clock hour lock the salted IP hash
   for a **full hour from the tenth failure**. Ten failures at 10:55 therefore
   still lock at 11:05, after the hourly allowance has reset. The lock is a
   counter row whose value is the time it ends. Test: `the lock lasts a full
   hour from the tenth failure, past the hourly reset`.
2. **Tokens and codes in hashes:** `SHA-256("ronna-token:" + token)` and
   `SHA-256("ronna-code:" + normalised code)`. The prefixes keep the two kinds
   apart.
3. **The "same answer" (69.4)** is the JSON reply `{"ok": true}` with status 202,
   held to a fixed time floor (400 ms). The page's words for it stay the CPO's
   quoted "Check your email." The CISO's text says "Check your inbox"; the
   CPO and CBO settle the words.
4. **`List-Unsubscribe` header (§11.4):** not sent, because that open point
   was not ruled on. Every email carries the one-click delete link in its body
   (69.5).
5. **The human-check slot** stays an empty box; no Turnstile. Rule 69.6 says
   a check is added only if needed.
6. **Delete link (69.9):** `/off/#d=…` deletes as soon as the page opens, which
   is one click from the email. A pending invitee who deletes releases their
   reserved code.
7. **Display names** accept any Unicode letters (for example "Zoë"), not only
   A to Z.
8. **Send** happens after the reply (`waitUntil`), so a slow SES call can't
   change the reply time. Without the secrets, `send()` logs `send.disabled`
   and sends nothing.

**How the tests prove they bite:** each of 15 deliberate breaks to the
Worker was caught by the test named for the rule it broke. The breaks were: a
sixth live code allowed; the reserve guard loosened; an email logged; a code
read from the URL; expired codes accepted; a reusable confirm token; 48-hour
tokens; no lockout; a family's name kept on leaving; operator tokens on
family routes; a signup limit of 50; three owners; the raw IP stored; the
bad-code timing floor skipped; and a revoked code still spent.
