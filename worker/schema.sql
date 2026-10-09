-- D1 schema for ronna-site-waitlist, the waitlist Worker's own database.
-- CISO rules 69, 72 and 74. Nothing here is shared with, or readable by,
-- any MOM product resource (rule 69.1).
--
-- Times are integer milliseconds since the epoch, UTC.

PRAGMA foreign_keys = ON;

-- Rule 69.2: per row only email, status, created and confirmed times.
-- Rule 72.9 adds invited-by family ID and code ID for invitees.
CREATE TABLE IF NOT EXISTS signups (
  email                TEXT PRIMARY KEY,                       -- trimmed, lower-cased
  status               TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
  created_at           INTEGER NOT NULL,
  confirmed_at         INTEGER,
  invited_by_family_id TEXT,                                   -- empty unless invited
  invite_code_id       TEXT                                    -- empty unless invited
);
CREATE INDEX IF NOT EXISTS signups_confirmed ON signups (status, confirmed_at);
CREATE INDEX IF NOT EXISTS signups_invite ON signups (invite_code_id);

-- Rule 69.3: only token hashes are stored. Confirm tokens expire after 24 h;
-- delete tokens last as long as the row. Deleting a signup deletes its tokens.
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,                                 -- SHA-256, hex
  email      TEXT NOT NULL REFERENCES signups (email) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('confirm', 'delete')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER                                           -- empty for delete tokens
);
CREATE INDEX IF NOT EXISTS tokens_email ON tokens (email, kind);

-- Rule 72.9, inviter side: family ID, display first name, status, times.
CREATE TABLE IF NOT EXISTS families (
  family_id          TEXT PRIMARY KEY,                         -- opaque, never a name
  display_first_name TEXT,                                     -- one word, max 20; erased on leaving
  status             TEXT NOT NULL CHECK (status IN ('active', 'left')),
  created_at         INTEGER NOT NULL,
  left_at            INTEGER
);

-- Rule 74.1: owner-to-family link, Access user ID (JWT sub), at most 2 per family.
CREATE TABLE IF NOT EXISTS family_owners (
  family_id       TEXT NOT NULL REFERENCES families (family_id) ON DELETE CASCADE,
  owner_access_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (family_id, owner_access_id)
);

-- Rule 74.1: enrolment codes, rule 72's format, hash only, 7 days, single use.
CREATE TABLE IF NOT EXISTS enrolment_codes (
  code_hash  TEXT PRIMARY KEY,
  family_id  TEXT NOT NULL REFERENCES families (family_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- Rule 72.9: code hashes, status, times.
CREATE TABLE IF NOT EXISTS invite_codes (
  code_id        TEXT PRIMARY KEY,                             -- opaque
  code_hash      TEXT NOT NULL UNIQUE,                         -- SHA-256 of the normalised code
  family_id      TEXT NOT NULL REFERENCES families (family_id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('unused', 'reserved', 'used', 'revoked')),
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,                             -- created_at + 30 days
  reserved_until INTEGER,
  used_at        INTEGER,
  revoked_at     INTEGER
);
CREATE INDEX IF NOT EXISTS invite_codes_family ON invite_codes (family_id, status);

-- Rules 69.6 and 72.8: a random salt per UTC day, deleted the next day.
CREATE TABLE IF NOT EXISTS salts (
  day  TEXT PRIMARY KEY,                                       -- YYYY-MM-DD
  salt TEXT NOT NULL
);

-- Counters only. `bucket` is a time window (hour or day); `subject` is a
-- salted IP hash, an Access user ID, or 'global'. Old buckets are deleted daily.
CREATE TABLE IF NOT EXISTS counters (
  name    TEXT NOT NULL,
  bucket  TEXT NOT NULL,
  subject TEXT NOT NULL,
  count   INTEGER NOT NULL,
  PRIMARY KEY (name, bucket, subject)
);
