// email-onboard.mjs — onboarding and edits driven entirely by EMAIL.
//
// The sender's address is their identity (no magic link). The attached resume is the source
// of truth; the email body carries their stated preferences. We reuse the same grounded
// dossier build as the chat/connector — nothing here invents anything. extractPrefs pulls
// ONLY what the person actually wrote; onboardFromEmail builds + saves an active profile;
// applyEmailChange handles "reply to change X" from an existing user.

import Anthropic from "@anthropic-ai/sdk";
import { buildDossier } from "./dossier-build.mjs";
import { enrichCompanyContext } from "./company-context.mjs"; // best-effort past-employer domain (dark)
import { ingestUrls } from "./url-ingest.mjs";
import { safePreferences } from "./lib/schemas/preferences.mjs"; // validate model output before it is stored
import { triageInbound, triageMode } from "./lib/onboard-triage.mjs"; // cheap read before the expensive one
import { saveDossier, getDossier, getCandidate, getResume, uploadResume, markOnboardingCohort, recordSignal } from "./charlie-store.mjs";
import { stripQuotedReply } from "./campaign-gate.mjs"; // keep only the sender's OWN words when measuring a bio
import { levelOf } from "./market-report.mjs"; // GROUNDED level classifier (reads stated seniority/role/headline, then professional_years) — so an ask fits the person
import { extractExperienceYears, experienceYearsPatch } from "./experience-years.mjs"; // the knockout floor's only input about the PERSON — the build emits it too rarely to rely on
import { ONBOARD_EXTRACT_SYSTEM } from "./prompts/onboard-extract.mjs"; // versioned prompt — see prompts/
import { PREF_WRITEBACK_SYSTEM } from "./prompts/pref-writeback.mjs"; // versioned prompt — see prompts/
import { INTERROGATE_SYSTEM } from "./prompts/interrogate.mjs"; // versioned prompt — see prompts/
import { Interrogate } from "./lib/schemas/interrogate.mjs"; // model-output boundary — safeParse

const PREF_MODEL = process.env.PREF_MODEL || "claude-haiku-4-5";
const PREF_SYS = ONBOARD_EXTRACT_SYSTEM;

function stripFences(t) {
  let s = (t ?? "").trim();
  if (s.startsWith("```")) s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return s.trim();
}

// Pull stated preferences from a free-form email body. Grounded: only what they wrote.
export async function extractPrefs(bodyText) {
  if (!bodyText || !bodyText.trim()) return {};
  const client = new Anthropic();
  const res = await client.messages.create({
    model: PREF_MODEL,
    max_tokens: 500,
    system: PREF_SYS,
    messages: [{ role: "user", content: String(bodyText).slice(0, 4000) }],
  });
  const t = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    const j = JSON.parse(stripFences(t));
    // BOUNDARY. Everything below this line is written into a real person's stored profile, so a model
    // reply is validated before it is trusted: known keys only, length-capped, markup and control
    // characters refused. Prompt injection must not depend on the model behaving.
    const { prefs, dropped } = safePreferences(j);
    if (dropped.length) console.error(`[prefs] dropped ${dropped.length} key(s) the model invented: ${dropped.slice(0, 8).join(", ")}`);
    return prefs;
  } catch {
    return {};
  }
}

// Chat-ish drip: the ONE next thing to ask, highest-leverage first (role gates matching; pay is
// least urgent). Deterministic over the stated preferences — one question at a time, never a form.
const SENIORITY_IN_ROLE = /\b(senior|sr\.?|junior|jr\.?|lead|principal|staff|mid[- ]?level|entry|head|director|vp|chief|founding)\b/i;

// The one rung where "internship, first full-time, or a move?" is a sensible question to ask a human.
// levelOf (market-report.mjs) is the GROUNDED classifier: it reads the person's own stated seniority
// and role, their headline, and finally professional_years — never the absence of a field.
//
// `apm` ONLY, deliberately. `ic` is mid-level (levelOf returns it at 2-5 grounded years), and asking
// someone three years into a career whether they want an internship is the same wrong note, just
// quieter. They get the other wording, which fits them just as well.
const EARLY_LEVELS = new Set(["apm"]);

// `ask` is a string, or a function of the DOSSIER when the wording has to fit the person.
// Every ask ends in terminal punctuation — see the invariant test in onboarding-asks.test.mjs.
const GAP_ASKS = [
  { key: "role", test: (p) => !p.role, ask: "what kind of role you're aiming for, a title or two is plenty." },
  { key: "seniority", test: (p) => !p.seniority && !(p.role && SENIORITY_IN_ROLE.test(p.role)), ask: "the level you're targeting: senior, staff, lead?" },
  // LEVEL-AWARE. The test is `!p.mode` — the ABSENCE of a field — and preferences.mode is usually
  // null BY DESIGN (dossier.md tells the build to leave it null unless the signal is unambiguous). A
  // level-blind wording would ask a senior leader whether they want an internship, which is a claim
  // about the person their own words contradict. The field is still worth having (the knockout gate
  // reads it), so the question stays — it just has to fit who is reading it.
  {
    key: "mode",
    test: (p) => !p.mode,
    ask: (d) =>
      EARLY_LEVELS.has(levelOf(d))
        ? "whether you're after an internship, your first full-time role, or a move from where you are now?"
        : "whether you're actively looking right now, or only moving for the right thing?",
  },
  { key: "remote", test: (p) => !p.remote, ask: "remote, a city, or either?" },
  { key: "comp_floor", test: (p) => p.comp_floor == null, ask: "your pay floor, so I never send you anything below it." },
  { key: "dealbreakers", test: (p) => !(Array.isArray(p.dealbreakers) && p.dealbreakers.length), ask: "anything you flat-out won't take, like agencies, on-site only, or a whole domain?" },
  { key: "motivation", test: (p) => !p.motivation, ask: "what would make you genuinely excited about the next role, not just fine with it?" },
];

// Resolve an ask to its final string for THIS person. Exported so the invariant test can walk every
// ask against every level without reaching into the array.
export function askText(gap, dossier) {
  const a = gap && gap.ask;
  return typeof a === "function" ? a(dossier) : String(a || "");
}

export function nextGap(dossier) {
  const p = (dossier && dossier.preferences) || {};
  const g = GAP_ASKS.find((x) => x.test(p));
  // Resolve `ask` here so every caller keeps receiving a plain `{ key, ask }` with a STRING ask —
  // renderWelcome/renderConvoReply/renderFirstRoleClosest interpolate `gap.ask` directly, and a
  // function reaching a template would render "(d) => ..." into a real person's inbox.
  return g ? { ...g, ask: askText(g, dossier) } : null;
}
// A real, grounded thing to open a gap-question with, so it reads as "I saw your work" not "you're
// incomplete". Verbatim from the dossier (a proof point's claim, or a strength). "" if nothing yet.
export function topStrength(dossier) {
  const pts = (dossier && Array.isArray(dossier.proof_points) ? dossier.proof_points : []).filter((x) => x && x.claim);
  // Prefer a VERIFIED proof point (resume / externally-checkable link) so Charlie never "leads with"
  // an unverified self-reported (conversation-tier) claim. Fall back to any proof, then a strength.
  const pp = pts.find((x) => x.source === "resume" || x.source === "link") || pts[0];
  if (pp) return String(pp.claim);
  const s = (dossier && Array.isArray(dossier.strengths) ? dossier.strengths : [])[0];
  return s ? String(s) : "";
}

// THIN-DOSSIER HONESTY. A dossier is "thin" when we genuinely don't have enough to match
// sharply: no verifiable proof points AND no stated role/region to aim at. When thin, the welcome
// honestly asks for a bit more ("share more and I'll find sharper matches") instead of overpromising.
// Deterministic on purpose (a "should notice" rule leaks): counts proof points + checks whether the
// person gave us a role or a place to work. Grounded — reads only what's actually in the dossier.
//
// ⚠️ THIS IS THE *STRICT* BAR, AND IT IS DELIBERATELY STRICTER THAN THE SEND GATE. It governs what
// Charlie SAYS (honest vs confident welcome), never whether a role is sent. The send gate uses the
// LOOSER `dossierIsDense` (fit-coverage.mjs). A person can be thin here and still receive roles: that
// is intended. Honesty is cheap so its bar is generous; silence is expensive so its bar is not.
// Do NOT merge the two: "enough data" is two bars, on purpose.
export function isThinDossier(dossier) {
  if (!dossier || typeof dossier !== "object") return true;
  const proofs = Array.isArray(dossier.proof_points) ? dossier.proof_points.filter((p) => p && p.claim) : [];
  const p = dossier.preferences || {};
  const hasRole = !!(p.role || (typeof dossier.headline === "string" && dossier.headline.trim()));
  const hasRegion = !!(p.remote || p.comp_floor || (Array.isArray(p.stage) && p.stage.length));
  // Thin unless we have at least a couple of concrete proof points AND some sense of role/region.
  return !(proofs.length >= 2 && hasRole && hasRegion);
}

// THE BUILD GROUNDED NOTHING. Not "thin" — empty. Every grounded array the build produces came back
// with nothing in it, which means the source was not a person's background at all.
//
// Why this exists: `/inbound`'s only content filter is a character count (substantiveBio, below), so
// a sales solicitation can clear it and onboard as an ACTIVE candidate, reaching every lifecycle
// send. The dossier build already diagnoses it ("There is nothing here to describe"); this reads that
// diagnosis before saveDossier(..., "active"). No classifier, no second model call, no new env var —
// it gates on what the build already computed.
//
// ⚠️ THIS IS NOT `isThinDossier`, AND MUST NOT BECOME IT. isThinDossier needs proofs >= 2 AND a role
// AND a region, and it governs what Charlie SAYS. Using it to REJECT would refuse a sparse-but-real
// person and break resume-optional onboarding — the exact merge the two-bar rule above
// forbids. This predicate is STRICTLY NARROWER by construction: anything it rejects is also thin,
// but a person with even one grounded strength or proof onboards untouched. That containment is
// pinned by a test (inbound-not-job-search.test.mjs), because prose is not enforcement.
//
// Fail-closed on shape: a missing/!object dossier grounds nothing by definition.
export function groundsNothing(dossier) {
  if (!dossier || typeof dossier !== "object") return true;
  const n = (arr, pred) => (Array.isArray(arr) ? arr.filter(pred).length : 0);
  const proofs = n(dossier.proof_points, (p) => p && p.claim);
  const studies = n(dossier.case_studies, Boolean);
  const strengths = n(dossier.strengths, (s) => s && String(s).trim());
  return proofs + studies + strengths === 0;
}

// Resume is OPTIONAL: a NEW person who attaches no resume can still onboard from a written bio, ground
// from THEIR OWN WORDS (buildDossier reads this exactly like a resume — CLAIM-tier, nothing invented).
// This is the deterministic "is there enough here to ground a profile" gate: their own words only
// (quoted reply stripped), at least ONBOARD_MIN_BIO_CHARS of them. Below the floor we ask for a resume
// or a few lines instead of grounding a junk profile — so "no resume needed" is never a broken promise.
// Returns the cleaned bio to ground from, or "" (too thin → ask). A sparse-but-real bio still onboards;
// isThinDossier then makes the welcome ask for more rather than overpromising.
const ONBOARD_MIN_BIO_CHARS = Number(process.env.ONBOARD_MIN_BIO_CHARS || 80);
// ASK BEFORE BUILDING. substantiveBio's floor (80 chars) answers "is there anything here at all". This
// answers a different question: "is there enough to build a PROFILE on, and then speak about this
// person's market with confidence". Two sentences clears the first bar and nowhere near the second.
// A full build plus a charted market read, from a couple of lines, is Charlie sounding certain about
// someone it has not met, so it asks questions and waits first.
//
// A CHARACTER COUNT IS A BLUNT PROXY and is chosen ON PURPOSE over asking a model. The alternative is
// another judgement call in front of onboarding, and a model that decides who is worth building for is
// exactly the thing that turns a bad day into someone never hearing back. Length is dumb, predictable,
// and tunable from an env var.
//
// OFF BY DEFAULT (ONBOARD_ASK_FIRST). It changes who gets a profile built, so it earns its way on the
// same as every other gate here.
// Read at CALL time, not import time, so the env var is tunable without a restart and testable.
const askFirstMinChars = () => {
  const n = Number(process.env.ONBOARD_ASK_FIRST_CHARS);
  return Number.isFinite(n) && n > 0 ? n : 400;
};
export const askFirstOn = () => String(process.env.ONBOARD_ASK_FIRST || "").toLowerCase() === "on";

/**
 * True when we have SOMETHING (it already cleared substantiveBio) but not enough to build on.
 * Only ever consulted for a NEW person who attached no file — a resume is enough by definition.
 */
export function tooThinToBuild(bio) {
  if (!askFirstOn()) return false;
  const t = String(bio || "").trim();
  return t.length > 0 && t.length < askFirstMinChars();
}

export function substantiveBio(rawBody) {
  const bio = (stripQuotedReply(rawBody) || String(rawBody ?? "")).trim();
  return bio.length >= ONBOARD_MIN_BIO_CHARS ? bio : "";
}

/**
 * Leave a durable trace that a reply changed what Charlie searches by.
 *
 * WHY. A reply saying "remote only" flips the same role from SEND to DIGEST at the gate, but without a
 * record nothing shows it happened: `noteInbound` keeps only the last 25 events in memory and is wiped
 * by every deploy, and container logs do not persist. A thing that works and a thing that quietly
 * stopped working produce identical evidence when nothing is written down.
 *
 * KEYS, NEVER VALUES. The new value already lives in the dossier; what was missing was WHEN and WHAT.
 * Recording the keys alone makes the loop auditable without copying a person's stated pay floor or
 * dealbreakers into a second table.
 *
 * Best-effort by construction: recordSignal already swallows its own errors and returns false, and the
 * await is caught here too. An audit trail must never be able to fail a real person's update.
 */
async function notePrefsChanged(email, changed, source, rec) {
  if (!email || !Array.isArray(changed) || !changed.length) return;
  // The recorder is resolved INSIDE the try, never in a default parameter. A default parameter is
  // evaluated before the try block exists, so if the `recordSignal` binding is ever missing (a partial
  // module mock, a bad import or a renamed export) the throw escapes straight into the caller and kills
  // the person's preference update. The one thing this function must never do.
  try { await (rec || recordSignal)({ email, event: "prefs_updated", meta: { changed, source } }); } catch { /* an audit trail may never fail a real person's update */ }
}

function mergePrefs(base, add) {
  // Second door, deliberately. extractPrefs validates its own output, but mergePrefs is also reachable
  // from applyEmailChange and any future caller, and it writes straight into the stored dossier. One
  // unvalidated caller is all it takes, so the allowlist lives HERE too rather than only upstream.
  const { prefs: safe } = safePreferences(add);
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(safe || {})) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "string" && !v.trim()) continue;
    out[k] = v;
  }
  return out;
}

// New user: store the resume, build a grounded dossier, fold in stated prefs, go active.
// Work ingestion: extraDocs are additional attached documents (each { filename, text }) and the email
// body doubles as notes — both are self-authored, so both ride in as CLAIM sources; only externally
// verified material (e.g. the GitHub API in url-ingest) is an ARTIFACT. The dossier's tiering
// (dossier-build TIER_ADDENDUM) keeps self-narration from being laundered into evidence.
export async function onboardFromEmail(email, resumeText, bodyText, extraDocs = []) {
  // Fail closed, and loud enough for the caller to catch: an empty/whitespace resume can't ground a
  // profile, so we throw here (rather than silently building nothing). The inbound path catches this
  // and replies with the honest "resend as PDF" note — onboarding never ends in silence.
  if (!resumeText || !resumeText.trim()) throw new Error("empty resume text");
  await uploadResume(email, resumeText).catch(() => {});
  // Attached documents are self-authored, so they are CLAIM-tier (the concrete-checkable bar applies,
  // same as notes) — only externally-verified sources (e.g. the GitHub API in url-ingest) are artifacts.
  const docSources = (Array.isArray(extraDocs) ? extraDocs : [])
    .filter((d) => d && d.text && String(d.text).trim())
    .map((d) => ({ label: d.filename || "document", trust: "claim", text: d.text }));
  // Tier-2: read any links they dropped (GitHub via the API = verifiable ARTIFACT; other pages =
  // self-authored CLAIM). Best-effort — a blocked/failed fetch just yields no source.
  // TRIAGE — the cheap read before the expensive one. groundsNothing (below) already refuses to make a
  // sales pitch into a candidate, but it runs AFTER buildDossier, so the Opus call is already paid for
  // by the time it says no. This asks the same question for ~$0.001 first.
  //
  // SHADOW BY DEFAULT: it logs what it WOULD have skipped and builds anyway, so its judgement can be
  // read against real inbound mail before it is allowed to refuse anyone. A guard that enforces on day
  // one can silently refuse real people; this one earns enforcement.
  const triage = await triageInbound(`${bodyText || ""}\n\n${String(resumeText || "").slice(0, 2000)}`);
  if (triage.verdict === "not_seeking") {
    if (triageMode() === "enforce") {
      const err = new Error(`triage: not a job search (${triage.why})`);
      err.code = "ungrounded"; // same contract as groundsNothing — the caller asks instead of retrying
      throw err;
    }
    console.error(`[triage] SHADOW would skip the build for ${email}: ${triage.why}`);
  }
  const urlSources = await ingestUrls(bodyText, { max: 4 }).catch(() => []);
  const extraSources = [...docSources, ...urlSources];
  const dossier = await buildDossier(resumeText, { extraSources, notes: bodyText || "" }); // grounded; name extracted verbatim
  // NOT A JOB SEARCH. The build grounded nothing at all, so there is no person here to serve. Refuse
  // BEFORE saveDossier — the active row is written below, and an active row is what pulls someone into
  // whatsnew, the daily role and every drip. Throwing (rather than returning null) keeps the caller's
  // existing "onboarding never ends in silence" contract intact while letting it tell this apart from
  // an infra failure: `code` says retrying will not help, so the caller must ask instead of queueing an
  // onboard_retry that would spend three more Opus builds on the same spam.
  if (groundsNothing(dossier)) {
    const err = new Error("dossier grounded nothing — not a job search");
    err.code = "ungrounded";
    throw err;
  }
  const prefs = await extractPrefs(bodyText).catch(() => ({}));
  dossier.preferences = mergePrefs(dossier.preferences, prefs);
  markOnboardingCohort(dossier); // new-user entry point: stamp v2 cohort (no-op unless ONBOARDING_V2=on)
  // PROFESSIONAL YEARS — the knockout floor's only input about the PERSON (eligibility-gate.mjs).
  // The dossier build is asked for `professional_years` too, but emits it rarely, which would leave
  // the floor inert for most people while KNOCKOUT_MODE=enforce reports it as enforcing. A dedicated
  // extractor runs here so every new user arrives with the number.
  //
  // AWAITED, not fire-and-forget (unlike enrichCompanyContext below, which does slow web lookups).
  // The first role email fires moments after this returns and the floor is read during that send, so
  // a background write would lose the race for the one send it most needs to gate. One Haiku call,
  // ~1-2s against an Opus build that already takes far longer.
  //
  // FAILS OPEN: on any error the field is simply absent, the floor stays inert for this person, and
  // this can never block or break an onboarding.
  try {
    const patch = experienceYearsPatch(await extractExperienceYears(resumeText));
    if (patch) Object.assign(dossier, patch);
  } catch (e) {
    console.error(`[onboard] experience-years extraction skipped for ${email}: ${e.message}`);
  }
  await saveDossier(email, dossier, "active");
  // Company context (dark behind COMPANY_CONTEXT): best-effort past-employer domain enrichment. Fire-and-forget so
  // it NEVER slows the welcome + first role; a no-op when the flag is off, and it never throws.
  enrichCompanyContext(email).catch(() => {});
  return dossier;
}

// Extract grounded BACKGROUND changes (not preferences) from a free-text reply + any link content.
// Concrete-only and tiered: a claim from their own words cites "conversation", a claim backed by a
// verified link cites "link". Pure self-praise is dropped. Never invents.
const WRITEBACK_SYS = PREF_WRITEBACK_SYSTEM;

async function extractWriteback(material) {
  if (!material || !material.trim()) return {};
  const client = new Anthropic();
  const res = await client.messages.create({ model: PREF_MODEL, max_tokens: 900, system: WRITEBACK_SYS, messages: [{ role: "user", content: String(material).slice(0, 8000) }] });
  const t = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try { const j = JSON.parse(stripFences(t)); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return {}; }
}

// Existing user replied: fold in stated prefs AND any grounded background additions/fixes (a project
// they forgot, a metric, a link to their work, a correction). Keeps the profile grounded + tiered.
export async function applyEmailChange(email, bodyText) {
  const existing = await getDossier(email);
  if (!existing) return null;

  // 1) preferences (unchanged path)
  const prefs = await extractPrefs(bodyText).catch(() => ({}));
  const prefKeys = Object.keys(prefs).filter((k) => prefs[k] != null && !(Array.isArray(prefs[k]) && !prefs[k].length));
  existing.preferences = mergePrefs(existing.preferences, prefs);

  // 2) grounded background write-back: fetch any links they dropped, then extract concrete additions
  const linkSources = await ingestUrls(bodyText, { max: 3 }).catch(() => []);
  const material = bodyText + (linkSources.length ? "\n\n" + linkSources.map((s) => `[${s.trust === "artifact" ? "VERIFIED LINK" : "LINKED PAGE"}] ${s.label}\n${s.text}`).join("\n\n") : "");
  const wb = await extractWriteback(material).catch(() => ({}));
  const changed = [...prefKeys];

  const proofs = Array.isArray(wb.add_proofs) ? wb.add_proofs.filter((p) => p && p.claim) : [];
  if (proofs.length) {
    // Tier the candidates exactly as before (link only if the model cited a [VERIFIED LINK]).
    const candidates = proofs.map((p) => ({ claim: String(p.claim), evidence: String(p.evidence || p.claim), source: p.source === "link" ? "link" : "conversation" }));
    // GROUNDING GATE: a reply's self-reported (conversation-tier) proof must trace to what
    // the person actually said (`material` = their words + any verified-link content). Drop any invented
    // metric / upgraded-scope proof BEFORE it lands — otherwise it becomes dossier "truth" and the
    // send-time verifier, which grounds the email AGAINST the dossier, ships it. Reuses the deterministic
    // writebackIsGrounded token check. Fail closed: on any check error, drop every candidate (a dropped
    // real proof is recoverable — their words stay in the transcript; an invented one is not).
    let landed;
    try {
      const { offenders } = writebackIsGrounded({ proof_points: candidates.filter((c) => c.source === "conversation") }, material);
      const ungrounded = new Set(offenders.map((o) => o.claim));
      for (const o of offenders) console.warn(`[writeback] dropped ungrounded proof: "${o.claim}" (untraced: ${o.missing.join(", ")})`);
      landed = candidates.filter((c) => !(c.source === "conversation" && ungrounded.has(c.claim)));
    } catch (e) {
      console.warn(`[writeback] grounding check failed, dropping all candidate proofs (fail closed): ${e.message}`);
      landed = [];
    }
    if (landed.length) {
      existing.proof_points = Array.isArray(existing.proof_points) ? existing.proof_points : [];
      for (const c of landed) existing.proof_points.push(c);
      existing.gaps = Array.isArray(existing.gaps) ? existing.gaps : [];
      existing.gaps.push("recent additions came from the person's own message; confirm the specifics before leaning on them in an interview.");
      changed.push("what you shared about your work"); // noun phrase so it composes with the "I've updated ..." ack
    }
  }
  const strengths = Array.isArray(wb.add_strengths) ? wb.add_strengths.map((s) => String(s).trim()).filter(Boolean) : [];
  if (strengths.length) {
    const have = new Set((existing.strengths || []).map((s) => String(s).toLowerCase()));
    const fresh = strengths.filter((s) => !have.has(s.toLowerCase()));
    if (fresh.length) { existing.strengths = [...(existing.strengths || []), ...fresh]; changed.push(fresh.join(", ")); }
  }
  if (wb.correction && String(wb.correction).trim()) {
    existing.gaps = Array.isArray(existing.gaps) ? existing.gaps : [];
    existing.gaps.push(`correction flagged by the person, to apply/verify: ${String(wb.correction).trim()}`);
    changed.push("the fix you flagged");
  }
  if (wb.headline && String(wb.headline).trim()) { existing.headline = String(wb.headline).trim(); changed.push("your summary"); }

  // KEEP THE STATUS THEY ALREADY HAD. `existing` is the DOSSIER and has no status field; the real
  // status lives on the candidate row, so it is read from there. Otherwise every reply would promote
  // the person to `active` — e.g. a form applicant at `screening` who replies once to ask a question
  // would silently join every lifecycle sweep. "active" is only the fallback for a person with a
  // dossier and no row.
  const _cand = await getCandidate(email).catch(() => null);
  await saveDossier(email, existing, _cand?.status || "active");
  // Only the PREFERENCE keys: `changed` also carries free-text writeback labels ("your summary", a
  // strengths list) that are prose for the reply, not fields Charlie searches by. The audit trail is
  // for the search parameters.
  await notePrefsChanged(email, prefKeys, "reply");
  return { dossier: existing, changed };
}

// The HONEST half of applyEmailChange: fold in ONLY stated SEARCH PREFERENCES (role, seniority, remote,
// comp floor, dealbreakers, stage...) and save. Deterministic writeback, no model-extracted "background"
// and no correction path — so it can NEVER tell a person "I updated X" while only appending a note-to-self
// (applyEmailChange can append to gaps). This is what the game-plan modify loop rides on:
// modifying "where I'm looking" only ever touches the parameters Charlie actually searches by. Returns
// { dossier, changed } (changed = the pref keys that actually took), or null if the person has no dossier.
// deps are injectable so the honesty guarantee (gaps untouched, no "I updated X" lie) is unit-testable
// without a live model or Supabase — a test that RUNS this and asserts gaps are unchanged is the
// enforcement; the prose comment above is not.
export async function applyPrefsOnly(email, bodyText, deps = {}) {
  const _getDossier = deps.getDossier || getDossier;
  const _extractPrefs = deps.extractPrefs || extractPrefs;
  const _saveDossier = deps.saveDossier || saveDossier;
  const existing = await _getDossier(email);
  if (!existing) return null;
  const prefs = await _extractPrefs(bodyText).catch(() => ({}));
  const changed = Object.keys(prefs).filter((k) => prefs[k] != null && !(Array.isArray(prefs[k]) && !prefs[k].length));
  if (!changed.length) return { dossier: existing, changed: [] }; // nothing stated to change -> caller decides
  existing.preferences = mergePrefs(existing.preferences, prefs);
  // Same as applyEmailChange above: `existing` is the dossier and has no status, so the status is read
  // from the candidate row. deps-injectable for the test.
  const _getCandidate = deps.getCandidate || getCandidate;
  const _cand2 = await _getCandidate(email).catch(() => null);
  await _saveDossier(email, existing, _cand2?.status || "active");
  await notePrefsChanged(email, changed, "reply", deps.recordSignal || recordSignal);
  return { dossier: existing, changed };
}

// ── Interrogation onboarding (the governed question -> answer -> writeback loop) ────────────
// v2-cohort only (gated upstream by onboardingV2Enabled / isV2). Converts the one-shot onboarding into
// a batched conversation: ground from the resume, ask the next 1-3 grounded questions, fold each answer
// back in (reusing applyEmailChange's tiered writeback), and stop by a DETERMINISTIC rule so it never
// loops and never dead-ends. The moat holds: questions reference only real facts, answers are written
// back grounded/CLAIM-tier, and any model failure falls back to the deterministic nextGap ask
// (onboarding never ends in silence). The server drives the journey (journey.mjs) around these.

// Hard ceiling on question BATCHES. A module constant (not env) on purpose: shortening the question
// count stays a one-line change without another env var.
export const MAX_BATCHES = 3;

// The remaining highest-leverage preference gaps, as human asks (reuses the GAP_ASKS ladder).
function remainingGaps(dossier) {
  const p = (dossier && dossier.preferences) || {};
  // askText, not `g.ask`: the mode ask is a function of the dossier now, and this list is
  // interpolated straight into the interrogation prompt — a raw function here would send the model
  // the literal source text "(d) => EARLY_LEVELS.has(...)" as the thing it should ask about.
  return GAP_ASKS.filter((g) => g.test(p)).map((g) => askText(g, dossier));
}

// A few grounded proof-point claims to let a question open from something real (verified first, so a
// question never "reads back" an unverified self-report as established fact). Verbatim from the dossier.
function topProofs(dossier, n = 5) {
  const pts = (dossier && Array.isArray(dossier.proof_points) ? dossier.proof_points : []).filter((x) => x && x.claim);
  const verified = pts.filter((x) => x.source === "resume" || x.source === "link");
  const rest = pts.filter((x) => !(x.source === "resume" || x.source === "link"));
  return [...verified, ...rest].slice(0, n).map((x) => String(x.claim));
}

// Deterministic fallback batch when the model is unavailable / returns garbage: the ONE next gap ask
// (never invented). `ready` true only when there is genuinely nothing left to ask.
function fallbackBatch(dossier) {
  const g = nextGap(dossier);
  return { questions: g ? [g.ask] : [], ready: !g };
}

// Does the dossier meet the role floor (a role/level is known)? Role gates matching, so completion is
// only "ready" once we have it. Pure.
export function hasRoleFloor(dossier) {
  const p = (dossier && dossier.preferences) || {};
  const headline = typeof dossier?.headline === "string" ? dossier.headline.trim() : "";
  return !!(p.role || headline);
}

// Did the person ask, in their own words, to stop asking and start? We always honor that. Pure.
export function userSaysDone(body) {
  const t = String(body || "").toLowerCase();
  return /\b(that'?s (all|it|everything|the lot)|i'?m (done|good|all set)|nothing (else|more)|just (start|find me|go)|go ahead|start (matching|the search|looking)|find me (roles|jobs|something))\b/.test(t);
}

// The DETERMINISTIC completion rule. Never loops (hard cap), never dead-ends (a dry cap still
// completes into an honest thin welcome), never completes before a single batch was asked. Pure.
export function decideCompletion({ dossier, batches, ready, body } = {}) {
  if (userSaysDone(body)) return true;              // the person asked to move on
  const n = Number(batches) || 0;
  if (n < 1) return false;                          // never complete before a single batch was asked
  if (n >= MAX_BATCHES) return true;                // hard ceiling — never loop
  return !!(ready && hasRoleFloor(dossier));        // model-ready only counts once role/level is known
}

// Append one Q/A turn to dossier.meta.transcript (creating the trail if absent). Mutates + returns the
// same object so the caller can save once. Pure aside from the mutation.
export function appendTranscriptTurn(dossier, questions, answer, at) {
  const d = dossier || {};
  d.meta = d.meta || {};
  d.meta.transcript = Array.isArray(d.meta.transcript) ? d.meta.transcript : [];
  d.meta.transcript.push({
    questions: Array.isArray(questions) ? questions.map(String) : [],
    answer: String(answer || ""),
    at: at || new Date().toISOString(),
  });
  return d;
}

// Grounding checker (used by the eval): every conversation-tier claim written into the dossier must
// trace to the source (resume + answers). Flags any distinctive token (a metric, or a word > 3 chars)
// in a written claim that does NOT appear in the source — the invented-fact signal. Pure, no I/O.
const GROUNDING_STOP = new Set(
  "a an and the of to in on for with at by from is are was were be been being it this that these those i my we our you your they their he she his her them as or but if then so than too very can will just have has had do did does not no yes".split(" "),
);
function groundingTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9%$ ]+/g, " ") // drop punctuation (incl. sentence periods) so "percent." === "percent"
    .split(/\s+/)
    .filter((t) => t && !GROUNDING_STOP.has(t));
}
export function writebackIsGrounded(dossier, sourceText) {
  const src = new Set(groundingTokens(sourceText));
  const offenders = [];
  const proofs = (dossier && Array.isArray(dossier.proof_points) ? dossier.proof_points : []).filter(
    (p) => p && p.source === "conversation" && p.claim,
  );
  for (const p of proofs) {
    const toks = [...new Set(groundingTokens(`${p.claim} ${p.evidence || ""}`))];
    // A missing number/metric is always a fabrication; a missing longer word is a distinctive claim
    // token that should trace to what they actually said.
    const missing = toks.filter((t) => !src.has(t) && (/[0-9%$]/.test(t) || t.length > 3));
    if (missing.length) offenders.push({ claim: p.claim, missing });
  }
  return { grounded: offenders.length === 0, offenders };
}

// Edge Engine (dark behind EDGE_ENGINE + ONBOARDING_V2): the interrogation context block that surfaces
// a grounded, high-confidence rare combination so the interrogation can confirm the AIM with the person
// (lead with the direction, get their buy-in). Returns "" unless the flag is on
// AND the dossier carries a high-confidence edge. The grounded `combo` is named; the market `strong_in`
// spaces are passed only as something to ASK about, never as experience (the prompt is told to ask, not
// assert). Pure + deterministic (reads only env + dossier) so the gating is unit-testable without the API.
export function edgeAimBlock(dossier) {
  const on = String(process.env.EDGE_ENGINE || "").toLowerCase() === "on";
  const edge = on && dossier?.edge?.confidence === "high" ? dossier.edge : null;
  if (!edge || !edge.combo) return "";
  const spaces = Array.isArray(edge.strong_in) ? edge.strong_in.filter(Boolean).join("; ") : "";
  return (
    "THEIR RARE COMBINATION (an unusual pairing of their OWN real background; you MAY ask ONE question to " +
    "confirm which space to weight toward, naming the pairing warmly and asking, NEVER stating a space as " +
    `something they have done):\n- pairing: ${edge.combo}` +
    (spaces ? `\n- spaces where this pairing is uncommon (ask, do not assert): ${spaces}` : "")
  );
}

// Generate the next question batch from the resume + transcript-so-far + remaining gaps + grounded
// proofs. safeParse at the boundary; on ANY failure (throw / bad JSON / schema miss / empty batch)
// fall back to the deterministic nextGap ask. Never throws, never returns an unvalidated payload.
export async function generateQuestions({ resumeText, dossier, transcript = [] } = {}) {
  try {
    const gaps = remainingGaps(dossier);
    const proofs = topProofs(dossier);
    const parts = [`RESUME:\n${String(resumeText || "").slice(0, 6000)}`];
    if (proofs.length) parts.push(`KNOWN ABOUT THEM (real, already established):\n- ${proofs.join("\n- ")}`);
    parts.push(`STILL MISSING (ask about these):\n- ${gaps.length ? gaps.join("\n- ") : "(nothing critical left; confirm and wrap up)"}`);
    const aimBlock = edgeAimBlock(dossier);
    if (aimBlock) parts.push(aimBlock);
    if (Array.isArray(transcript) && transcript.length) {
      parts.push(`ANSWERS SO FAR:\n${transcript.map((t) => `Q: ${(t.questions || []).join(" / ")}\nA: ${t.answer}`).join("\n\n")}`);
    }
    const client = new Anthropic();
    const res = await client.messages.create({
      model: PREF_MODEL,
      max_tokens: 500,
      system: INTERROGATE_SYSTEM,
      messages: [{ role: "user", content: parts.join("\n\n").slice(0, 12000) }],
    });
    const t = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const parsed = Interrogate.safeParse(JSON.parse(stripFences(t)));
    if (!parsed.success) {
      console.error(`[interrogate] output failed schema: ${parsed.error?.issues?.[0]?.message || "invalid"}`);
      return fallbackBatch(dossier);
    }
    return { questions: parsed.data.questions, ready: parsed.data.ready };
  } catch (e) {
    console.error(`[interrogate] generateQuestions failed, using deterministic ask: ${e.message}`);
    return fallbackBatch(dossier);
  }
}

// New v2 signup: ground from the resume (reusing onboardFromEmail — stamps the v2 cohort + saves), seed
// the first question batch, and stash interro state on meta. Returns { dossier, questions }. The server
// then walks the journey (received -> ack -> interrogating) and sends the welcome+questions.
// Throws exactly like onboardFromEmail on an unreadable/empty resume (caller catches -> renderMissingResume).
export async function startInterrogation(email, resumeText, bodyText, extraDocs = []) {
  const dossier = await onboardFromEmail(email, resumeText, bodyText, extraDocs);
  const gen = await generateQuestions({ resumeText, dossier, transcript: [] });
  // We ASK exactly one grounded question per turn (the copy lint allows a single genuine "?"; the voice
  // contract is "one question at a time, never a form"). The model may surface a few candidates; we lead
  // with the strongest and let the ⇄ alternation carry the rest across turns.
  const ask = gen.questions.length ? gen.questions[0] : (nextGap(dossier)?.ask || "");
  dossier.meta = dossier.meta || {};
  dossier.meta.interro = { batches: 1, pending: ask ? [ask] : [], ready: !!gen.ready, active: true };
  await saveDossier(email, dossier, "active");
  return { dossier, question: ask };
}

// A v2 reply mid-interrogation: fold the answer in (grounded writeback via applyEmailChange), record the
// Q/A turn, then either ask the next batch or complete. Returns { done, dossier, changed, questions }.
// Saves the dossier ONCE at the end — the caller must drive the journey (enterState) AFTER this returns,
// never before, so a journey write can't be clobbered by this content write.
export async function continueInterrogation(email, bodyText) {
  const r = await applyEmailChange(email, bodyText); // grounded, tiered writeback (saves the dossier)
  if (!r || !r.dossier) return null;
  const dossier = r.dossier;
  const interro = (dossier.meta && dossier.meta.interro) || { batches: 0, pending: [], active: true };
  appendTranscriptTurn(dossier, Array.isArray(interro.pending) ? interro.pending : [], bodyText);
  const batches = Number(interro.batches) || 0;

  let done = decideCompletion({ dossier, batches, ready: !!interro.ready, body: bodyText });
  let question = ""; // the ONE next question to ask this turn (empty ⇒ we're done)
  if (!done) {
    const resumeText = await getResume(email).catch(() => "");
    const gen = await generateQuestions({ resumeText, dossier, transcript: dossier.meta.transcript });
    question = gen.questions.length ? gen.questions[0] : "";
    if (!question) {
      done = true; // nothing left to ask -> wrap up honestly (never a silent no-question turn)
    } else {
      dossier.meta.interro = { ...interro, batches: batches + 1, pending: [question], ready: !!gen.ready };
    }
  }
  if (done) {
    dossier.meta.interro = { ...interro, pending: [], active: false, completed: true };
  }
  await saveDossier(email, dossier, "active");
  return { done, dossier, changed: r.changed || [], question };
}
