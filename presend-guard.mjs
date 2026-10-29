// presend-guard.mjs — the ONE gate every send path MUST call as its last check before
// resend.emails.send(...). It stacks the deterministic no-repeat rule on top of gateRole (liveness
// + region reachability + language eligibility + fit floor). No send path may bypass it: the daily
// scheduler and every one-off sender route through preSendGuard so a rule lives in exactly one place
// and is enforced everywhere. Returns { decision: 'send' | 'digest' | 'drop', rule, reason, cov }.
//
// Deterministic on purpose: a rule an LLM "should
// notice" is a rule that leaks. These are code.

import { canonicalJobIdentity, roleKey, titleStem, companyKey } from "./charlie-store.mjs";
import { gateRole } from "./quality-gate.mjs";
import { auditRole } from "./send-audit.mjs";
import { seniorityVerdict, seniorityMode } from "./lib/role-level.mjs";
import { ghostVerdict, ghostMode } from "./lib/ghost-score.mjs";
import { levelOf } from "./market-report.mjs";

const COMPANY_COOLOFF_DAYS = Number(process.env.COMPANY_COOLOFF_DAYS || 21);

// THE UNBREAKABLE RULE: never send the same role to the same person twice. A RETITLED repost with a
// fresh scraped id defeats any company+title key AND the find-id dedup.
// So we check four vectors, primary first:
//   1. identity   — canonical apply_url (title-blind AND id-blind; the same requisition's page)
//   2. roleKey    — exact company::title
//   3. core       — company::titleStem (collapses seniority retitles: "Engineer II" == "Engineer")
//   4. cooloff    — same company emailed within COMPANY_COOLOFF_DAYS (soft: routes to digest, not drop,
//                   so a genuinely different role at a recent company isn't silently lost)
// `sig` is getEmailedRoleSignatures(email). Returns { rule, reason, soft } or null (not a repeat).
export function repeatDecision(job, sig) {
  if (!sig) return null;
  const id = canonicalJobIdentity(job);
  if (sig.identities?.has(id)) return { rule: "repeat:identity", reason: `already sent this posting (${id})` };
  const rk = roleKey(job?.company, job?.title);
  if (rk !== "::" && sig.roleKeys?.has(rk)) return { rule: "repeat:roleKey", reason: `already sent this role (${rk})` };
  const ck = `${companyKey(job?.company)}::${titleStem(job?.title)}`;
  if (ck !== "::" && sig.coreKeys?.has(ck)) return { rule: "repeat:core", reason: `already sent a near-identical title (${ck})` };
  const co = companyKey(job?.company);
  if (co && Array.isArray(sig.companies)) {
    const cutoff = Date.now() - COMPANY_COOLOFF_DAYS * 864e5;
    if (sig.companies.some((c) => c.company === co && c.at && Date.parse(c.at) >= cutoff)) {
      return { rule: "repeat:company-cooloff", reason: `already emailed ${co} within ${COMPANY_COOLOFF_DAYS} days`, soft: true };
    }
  }
  return null;
}

// HARD-CONSTRAINT check, run BEFORE the send instead of only after it.
//
// send-audit.mjs knows this rule (e.g. a remote-only person handed an office role in another city),
// but it runs as a post-send flag: it can describe the miss, not prevent it. Running it here, before
// the send, turns the audit into a guard.
//
// We import `auditRole` rather than restate its logic: ONE implementation, so the pre-send decision
// and the post-send audit can never drift apart and disagree about the same role.
//
// DIGEST, not drop. A hard-constraint miss means "not the one honest solo role", not "worthless" —
// the weekly digest still surfaces it, exactly like a company cool-off. Only `high` severity gates;
// `med` stays advisory. And it runs BEFORE gateRole, so a role that can never be sent never spends a
// Sonnet coverage call — the dominant per-user cost.
function hardConstraintMiss(job, dossier) {
  try {
    const findings = auditRole({ dossier, role: job });
    const blocking = (findings || []).filter((f) => f && f.severity === "high");
    return blocking.length ? blocking[0] : null;
  } catch {
    return null; // never let the safety net become the thing that breaks the send path
  }
}

// The enforced pre-send decision. Repeat first (cheap, deterministic, no network), then the person's
// own hard constraints, then the gate (liveness + region + fit, the expensive one).
export async function preSendGuard({ job, dossier, matcherScore, getCov, signatures, fetchImpl } = {}) {
  const rep = repeatDecision(job, signatures);
  if (rep) return { decision: rep.soft ? "digest" : "drop", rule: rep.rule, reason: rep.reason, cov: null };
  const miss = hardConstraintMiss(job, dossier);
  if (miss) return { decision: "digest", rule: `constraint:${miss.rule}`, reason: miss.detail, cov: null };
  // Level. Deterministic, no network, and BEFORE the coverage call so a role beneath the person's
  // stated bar never spends a Sonnet pass. shadow (default) logs and changes nothing; enforce routes
  // to digest; off disables. Errors are swallowed: a level read must never break the send path.
  try {
    const sv = seniorityVerdict(job, dossier, levelOf);
    if (sv.below) {
      const mode = seniorityMode();
      if (mode === "enforce") return { decision: "digest", rule: "constraint:level-below-target", reason: sv.reason, cov: null };
      if (mode !== "off") console.error(`[seniority shadow] would DIGEST ${job?.company} — ${job?.title}: ${sv.reason} (floor ${sv.floor} by ${sv.basis})`);
    }
  } catch { /* never let the level read break a send */ }

  // Evergreen/ghost check. Deterministic, no network, and like the level read it can only
  // hold — never promote. INERT until the persisted seen-store has accumulated GHOST_DAYS of
  // history; see the header of lib/ghost-score.mjs for why that is arithmetic, not a bug.
  try {
    const gv = ghostVerdict(job);
    if (gv.evergreen) {
      const mode = ghostMode();
      if (mode === "enforce") return { decision: "digest", rule: "constraint:evergreen", reason: gv.reason, cov: null };
      if (mode !== "off") console.error(`[ghost shadow] would DIGEST ${job?.company} — ${job?.title}: ${gv.reason}`);
    }
  } catch { /* never let the age read break a send */ }

  const g = await gateRole({ job, dossier, matcherScore, getCov, fetchImpl });
  // Pass the gate's OWN rule through: it is the only machine-readable record of WHICH of gateRole's
  // exits fired, so digest rows stay countable. Fall back to `gate:${outcome}` if an exit forgets its
  // rule, so the field can never be undefined (see recordedRule in charlie-store.mjs).
  return { decision: g.outcome, rule: g.rule || `gate:${g.outcome}`, reason: g.reason, cov: g.cov };
}
