// Rules 69.7 and 72.10: logs hold counts and error kinds only, never an
// email, token, code, code hash, family or code ID, IP or its hash, or a name.
// Every log line goes through log(); it accepts only a known event name and,
// optionally, an error kind from a fixed list. Anything else is dropped and
// replaced with "log.refused", so a mistake can't leak data into the logs.

const EVENTS = new Set([
  "signup.accepted", "signup.limited", "signup.capped", "signup.throttled", "signup.implausible",
  "confirm.ok", "confirm.invalid",
  "delete.ok", "delete.invalid", "delete_request.accepted", "delete_request.limited",
  "invite.lookup_ok", "invite.lookup_bad", "invite.reserved", "invite.redeem_bad",
  "invite.locked", "invite.capped", "invite.spent", "invite.mark_dropped",
  "invite.minted", "invite.mint_refused_cap", "invite.mint_refused_daily", "invite.mint_refused_name",
  "invite.revoked", "family.enrolled", "family.enrol_refused", "family.named", "family.left",
  "family.created", "family.enrolment_code", "operator.delete",
  "access.refused", "send.ok", "send.error", "send.disabled",
  "cron.cleaned", "request.error", "log.refused",
]);

const KINDS = new Set([
  "db", "send", "timeout", "bad_request", "throttled", "rejected", "config", "jwt", "unknown",
]);

export function log(event, kind) {
  if (!EVENTS.has(event) || (kind !== undefined && !KINDS.has(kind))) {
    console.log(JSON.stringify({ event: "log.refused" }));
    return;
  }
  console.log(JSON.stringify(kind ? { event, kind } : { event }));
}

export const LOG_EVENTS = EVENTS;
export const LOG_KINDS = KINDS;
