// lib/role-ask-flag.mjs — the ROLE_ASK kill switch. Same two-key shape as FIT_SEND_MODE.
//
//   ROLE_ASK          off (default) | shadow | on
//   ROLE_ASK_COHORT   comma-separated addresses. EMPTY MEANS NOBODY, never everybody.
//
// off     askFor is never called; the email is byte-identical to one rendered without this feature
// shadow  the question is computed and PERSISTED to finds.composed._ask, and NOT rendered
// on      the question renders, for the listed addresses only
//
// Every malformed, blank or unset value resolves to off. NOTE: this controls the QUESTION only. The
// fit meter is removed unconditionally and is deliberately NOT coupled to this flag.
export const ROLE_ASK_MODES = ["off", "shadow", "on"];

export function roleAskMode() {
  const raw = String(process.env.ROLE_ASK ?? "").trim().toLowerCase();
  return ROLE_ASK_MODES.includes(raw) ? raw : "off";
}

export function roleAskCohort() {
  return new Set(String(process.env.ROLE_ASK_COHORT ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** "off" | "shadow" | "on", for this person. */
export function roleAskFor(email) {
  const mode = roleAskMode();
  if (mode === "off") return "off";
  const who = String(email ?? "").trim().toLowerCase();
  if (!who) return "off";
  return roleAskCohort().has(who) ? mode : "off";
}
