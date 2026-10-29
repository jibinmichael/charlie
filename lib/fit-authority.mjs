// lib/fit-authority.mjs — THE KILL SWITCH for the two-stage Fit Engine's send authority.
//
// This module exists so that the answer to "can the Fit Engine stop an email today?" is a single
// environment variable an operator can read, flip, and verify — not a code path someone has to trace.
//
// TWO KEYS, BOTH REQUIRED. Authority needs the mode AND the person:
//
//   FIT_SEND_MODE     off (default) | shadow | enforce
//   FIT_SEND_COHORT   comma-separated email addresses. EMPTY MEANS NOBODY.
//
// An empty cohort is not "everyone" — it is "no one". That is deliberate: the failure this guards
// against is a flag flipped on with no list behind it quietly gaining authority over every user.
// Both keys are in .env.example with this contract written beside them.
//
// FAIL CLOSED EVERYWHERE. An unset variable, an unrecognised value, a blank value, a missing email,
// a malformed cohort — every one of them resolves to `off`. There is no input that accidentally grants
// authority; you have to spell it correctly to get it.
//
// WHAT EACH MODE DOES
//   off      the engine is never called. Zero model calls, zero cost, and the send path is exactly
//            the existing gate.
//   shadow   the engine runs and its decision is RECORDED, but the send is decided by the gate alone.
//            This is the mode a first production week should run in.
//   enforce  the engine may VETO a send the existing gate approved. It can never create one — see
//            the wiring note in scheduler.mjs. The send set becomes (what v1 sends) MINUS (what the
//            engine rejects), which is strictly smaller than either.
//
// ENABLE / DISABLE, exactly:
//   enable   railway variables --set FIT_SEND_MODE=shadow  --set FIT_SEND_COHORT="a@x.com,b@y.com" -s charlie-engine
//            then redeploy or wait for the next cron; verify with `railway variables -s charlie-engine`
//   disable  railway variables --set FIT_SEND_MODE=off -s charlie-engine
//            takes effect on the next run. NO REDEPLOY IS NEEDED TO TURN IT OFF — that is the point.

/** The three modes, in the order of how much they are allowed to do. */
export const FIT_MODES = ["off", "shadow", "enforce"];

/** The configured mode, or "off" for anything unrecognised. Never throws. */
export function fitSendMode() {
  const raw = String(process.env.FIT_SEND_MODE ?? "").trim().toLowerCase();
  return FIT_MODES.includes(raw) ? raw : "off";
}

/** The cohort as a Set of lowercased addresses. Empty set means nobody, never everybody. */
export function fitSendCohort() {
  return new Set(
    String(process.env.FIT_SEND_COHORT ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * What the engine is allowed to do FOR THIS PERSON, right now.
 * @returns {"off"|"shadow"|"enforce"}
 */
export function fitAuthority(email) {
  const mode = fitSendMode();
  if (mode === "off") return "off";
  const who = String(email ?? "").trim().toLowerCase();
  if (!who) return "off";
  return fitSendCohort().has(who) ? mode : "off";
}

/** True only when the engine may actually change a send decision. */
export function fitCanVeto(email) {
  return fitAuthority(email) === "enforce";
}

/** One line an operator can grep in a run log to know what was live. */
export function fitAuthorityBanner() {
  const mode = fitSendMode();
  const n = fitSendCohort().size;
  return `[fit-authority] mode=${mode} cohort=${n} address(es)${mode !== "off" && n === 0 ? " — NOBODY (empty cohort is not everybody)" : ""}`;
}
