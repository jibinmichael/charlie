// voice/consent.mjs — the consent texts, versioned in code, and the two operations on them.
//
// THE TEXT IS A VERSIONED CONSTANT, NEVER EDITED IN PLACE. Consent recorded as a boolean loses the
// ability to say what a person agreed to. Every vv_consents row carries the version of the text that
// was on the screen, and a change to the wording is a new version with the old one left intact.
//
// THE WORDING BELOW IS A DRAFT PENDING LEGAL REVIEW. The version string says so. It must not be shown
// to a real candidate until the review has happened; the pilot flag is where that is checked.
//
// WITHDRAWAL IS A DATA OPERATION THAT CASCADES. Withdrawing the recording consent deletes the
// session and everything under it. Withdrawing pool reuse records a refusal that every pool read
// honours. Neither is a flag somebody has to remember to check.

export const CONSENT_TEXT_VERSION = "2026-09-22.draft";

export const SCOPES = ["recording", "retention", "pool"];

/** The exact words, per scope. `retention` interpolates the period the plan's mandate sets. */
export const CONSENT_TEXTS = {
  [CONSENT_TEXT_VERSION]: {
    recording:
      "I understand this conversation is with an AI agent called Charlie, that it is recorded, and that the recording, " +
      "a written transcript, and the evidence drawn from it will be shared with the hiring team for this role only.",
    retention:
      "I understand the recording, transcript, and evidence are kept for the period the hiring team has set, " +
      "and that I can ask for the transcript, dispute any part of it, or withdraw this consent at any time.",
    pool:
      "I agree that the evidence from this conversation may be shown, with its date and the role it was collected for, " +
      "to other hiring teams in future, and I understand I can withdraw this separately at any time.",
  },
};

/**
 * The consent texts to show for a session. A test session has no pool scope: there is no pool
 * contribution to consent to.
 * @param {'candidate'|'test'} kind
 * @returns {Array<{scope:string, text_version:string, text:string, required:boolean}>}
 */
export function consentTexts(kind, version = CONSENT_TEXT_VERSION) {
  const texts = CONSENT_TEXTS[version];
  if (!texts) throw new Error(`consent text version "${version}" does not exist`);
  const scopes = kind === "test" ? ["recording", "retention"] : SCOPES;
  return scopes.map((scope) => ({ scope, text_version: version, text: texts[scope], required: scope !== "pool" }));
}

/**
 * Did the session grant every required scope? Reads the LATEST row per scope, because a withdrawal
 * is a later row with granted=false.
 * @param {Array<{scope:string, granted:boolean, recorded_at:string}>} rows
 */
export function consentStatus(rows, kind) {
  const latest = {};
  for (const r of [...rows].sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)))) latest[r.scope] = r;
  const required = consentTexts(kind).filter((t) => t.required).map((t) => t.scope);
  const missing = required.filter((s) => !latest[s]?.granted);
  return { ok: missing.length === 0, missing, pool: latest.pool?.granted === true, latest };
}

/**
 * Record one scope's answer. Refuses an unknown scope, an unknown version, or a pool scope on a
 * test session.
 */
export async function recordConsent(store, { session, scope, text_version, granted, user_agent = null }) {
  if (!SCOPES.includes(scope)) throw new Error(`recordConsent: unknown scope "${scope}"`);
  if (!CONSENT_TEXTS[text_version]) throw new Error(`recordConsent: unknown text version "${text_version}"`);
  if (session.kind === "test" && scope === "pool") throw new Error("recordConsent: a test session has no pool scope");
  return store.insertConsent({ session_id: session.id, scope, text_version, granted: Boolean(granted), user_agent });
}

/**
 * Withdraw. `recording` deletes the session and everything under it (the cascade in voice/store.mjs).
 * `pool` records a refusal. `retention` is withdrawn by withdrawing `recording`.
 */
export async function withdrawConsent(store, { session, scope, user_agent = null }) {
  if (scope === "recording") {
    await store.deleteSession(session.id);
    return { deleted: true };
  }
  if (scope === "pool") {
    if (session.kind === "test") throw new Error("withdrawConsent: a test session has no pool scope");
    await store.insertConsent({ session_id: session.id, scope: "pool", text_version: CONSENT_TEXT_VERSION, granted: false, user_agent });
    return { deleted: false };
  }
  throw new Error(`withdrawConsent: scope "${scope}" is withdrawn by withdrawing "recording"`);
}
