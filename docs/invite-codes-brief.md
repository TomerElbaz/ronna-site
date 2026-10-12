# Invite codes for waitlist members: brief (w02)

FOR the CPO, then the CISO. **Brief only. Nothing is built or deployed.** Branch `claude/elegant-fermi-az6y0a`, based on 3a8d961.

How to read the marks:
- **VERIFIED** means the Worker already does this at 3a8d961 (`worker/`, tested in `tests/worker/`), under CISO rules 69, 72 and 74.
- **ASSUMED** means this is a new choice for this feature. It is not built and needs a yes.

**The one big change.** Today only a family owner who has signed in through Cloudflare Access can mint codes (rule 72.1, VERIFIED). A waitlist member has no sign-in and no stored name, only an email row (rule 69.2, VERIFIED). This feature reuses the existing code machinery but changes who holds codes, and therefore what the friend is told. Rule 72 needs an amendment for that (§6).

## 1. The codes

- **How they're made:**
  - 80 random bits from `crypto.getRandomValues`, written as 16 Crockford base32 characters in groups of 4, for example `7K3Q-X9PD-M2TA-B4RN`.
  - Only the code's SHA-256 is stored.
  - **VERIFIED** (`newCode` in `worker/src/util.js`, rule 72.2).
- **When:** minted at the moment the member confirms their email, and never before. An address that never confirms gets no codes. **ASSUMED.**
- **How many:** 3 per member, minted once, with no top-up. **ASSUMED.**
  - 3 is a placeholder for the CPO.
  - Families get 5 live codes (**VERIFIED**, `MAX_LIVE_CODES`).
- **Expiry:** 30 days from minting. **VERIFIED** (`CODE_TTL`, rule 72.7).
- **Each code works once:**
  - It is reserved when the friend submits their email and spent when the friend confirms.
  - If the friend doesn't confirm within 24 h, the code is released.
  - **VERIFIED** (rule 72.6). Of two people submitting at once, exactly one wins.
- **Friends who join get their own 3 codes when they confirm:** everyone is treated the same. **ASSUMED.**

## 2. Data stored, and where

- **Where:** only in D1 `ronna-site-waitlist`, the site's own database on Cloudflare, which Cloudflare encrypts at rest. Nothing goes to MOM or anywhere else. **VERIFIED** (`wrangler.toml`, `schema.sql`, test `no-mom-binding`).
- **Member:** the existing `signups` row, which holds only email, status, created time and confirmed time. **VERIFIED.**
- **Member's codes:**
  - `invite_codes` rows hold an opaque ID, the code hash, status (unused, reserved, used or revoked), and the created, expiry, reserved-until, used and revoked times. **VERIFIED.**
  - New: an owner column pointing at the member's `signups` row, deleted along with it, in place of `family_id`. **ASSUMED.**
  - That is a schema change: `family_id` is `NOT NULL` today, and each code would carry exactly one of the two owners.
- **Friend:**
  - Their own `signups` row with the same four fields, plus `invite_code_id`, which links back to the code and so to the member. **VERIFIED.**
  - `invited_by_family_id` stays empty, because the member is not a family. **ASSUMED.**
- **Never stored:** the code itself, any name for the member or the friend, or an IP address. IPs exist only as salted daily hashes, and only as counters. **VERIFIED.**
- **Deletion:**
  - When a friend deletes their row, the link goes with it. **VERIFIED.**
  - When a member deletes their row, their codes go with it, and their friends' `invite_code_id` is emptied. A friend holding a reservation can still confirm, but without the link. **ASSUMED.** This mirrors what already happens when a family leaves (rule 72.11, **VERIFIED**).

## 3. What is sent out

- **Nothing is emailed to a friend because of a code.** **VERIFIED** (rule 72.12, test `invite-sends-no-email`).
- **Codes are not emailed to the member either.** They appear on screen only (§5). **ASSUMED.**
- **The member shares the code themselves,** either as a link or by having the friend type it:
  - The link is `https://ronna.mom/invite/#code=XXXX-XXXX-XXXX-XXXX`.
  - The code sits after `#`, so it never reaches a server-logged URL. It is sent only in a request body, and the page sets `no-referrer`.
  - **VERIFIED** (rule 72.3, test `invite-code-never-in-url`).
- **The friend's only email** is the existing confirm email, sent through **Amazon SES, us-east-2**, after they type their own address. **VERIFIED** (`mail.js`; region per rule 73(3)). It is not live: no SES key exists.
- **No other service is involved.** **VERIFIED** (design doc §10).

## 4. Abuse limits

- **Guessing codes:**
  - There are 2^80 possible codes, and invite routes allow 10 requests an hour per salted IP hash.
  - 10 bad codes in an hour lock that hash for the rest of the hour.
  - Every bad code gets the same reply, "This invite isn't valid.", with the same status and timing.
  - **VERIFIED** (`limits.js`, rules 72.5 and 72.8, test `lock-after-10-failures`).
- **Redeem cap:** 200 redeems a day site-wide. **VERIFIED** (`redeemsPerDay`).
- **Spam signups through codes:** friends go through the same limits as any signup. **VERIFIED.**
  - 5 an hour and 20 a day per IP hash.
  - 500 confirm emails a day site-wide.
  - 1 confirm email per address per hour.
- **Farming codes:**
  - Codes come only after a confirmed inbox, 3 per inbox, so each batch of codes costs a working inbox.
  - On top of that, a site-wide cap of 300 member codes minted a day (100 members). Over the cap, the member still joins but gets no codes, and the page says invites aren't available right now. **ASSUMED.**
- **A code is worth little to an abuser:** an invite does not move anyone up the list. **VERIFIED** (test `place-ignores-invites`). If codes ever gate entry, this section needs a fresh review.

## 5. What each person sees

- **Member, on `/confirm/` right after confirming:**
  - Their place on the list. **VERIFIED.**
  - Their 3 codes, each with **Copy** and its share link, and the line "This is the only time you'll see these codes." **ASSUMED.** The show-once rule is **VERIFIED** for families (rule 72.2).
- **Member, afterwards: nothing.** **ASSUMED.**
  - There is no account and no status page.
  - The member is never told whether a code was used, or who joined.
  - Rule 72.9 already limits an inviter to seeing used or unused, never who (**VERIFIED**). This brief goes one step simpler and shows not even that.
- **Friend, on `/invite/`:**
  - A valid code shows an email box and "Joining with a code doesn't move you up the list." **VERIFIED.**
  - No inviter name is shown, because members have no stored name. **ASSUMED.** Today the page shows "Invited by" and a family's chosen first name (**VERIFIED**).
  - A bad code shows "This invite isn't valid." **VERIFIED.**
  - After that come the normal confirm email and `/confirm/`, which shows the friend's own place and, under §1, their own 3 codes.

## 6. Open questions for the CISO

1. **Amend rule 72.1?** It would let a confirmed waitlist member hold codes, minted automatically at confirm with no sign-in. Today only a family owner who has signed in through Access can.
2. **Owner link:** may a member's codes reference their `signups` row, deleted along with it, under rules 69.2 and 72.9?
3. **The who-invited-whom link:**
   - Keep the friend's `invite_code_id` after they confirm, as built? That stores a link between two email addresses.
   - Or empty it once the code is spent? That is more private, but then only the code's `used` status records that an invite worked.
4. **Rule 72.4 assumes a first name.** May the invite page show no inviter name at all?
5. **Numbers:** 3 codes per member, 30-day expiry, and a cap of 300 member codes minted a day.
6. **Shown once, no way back:** a member who closes the page loses their codes. Is that acceptable, or should a view link (a third hash-only token type, like the delete link) come later?
7. **Member deletion:** it removes their codes and empties their friends' links, mirroring rule 72.11. Agreed?

*Note for the CPO:* this brief assumes the families' rule-72 codes stay as they are, alongside the new member codes.
