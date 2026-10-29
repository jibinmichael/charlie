// fit-coverage.mjs — the grounded JD→coverage engine (the shared spine of the explainable fit
// Readout AND the gap-check). Given the candidate's dossier + a role's JD, it returns a decomposed,
// HONEST read: which of the JD's real requirements are MET / PARTIAL / UNKNOWN (unknown is the
// default — silence is never a hit or a miss), plus grounded sub-scores. The COMPOSITE is computed
// deterministically in code (never a model-guessed total, so it can't drift optimistic). Charlie
// cannot see the employer's real ATS model, so every number ships captioned "my read of the
// posting, not their scoreboard." Never invents a requirement, a strength, or a gap.

import Anthropic from "@anthropic-ai/sdk";
import { FIT_COVERAGE_SYSTEM, buildCoverageMessages } from "./prompts/fit-coverage.mjs"; // versioned prompt — see prompts/
import { reqKind, mustHaveV1, coreMustHave, composite as computeComposite, fitFloorMode } from "./fit-floor.mjs"; // evidence-based floor
import { jdIsScoreable } from "./lib/jd-requirements.mjs"; // shared with charlie-store's pool cap, so they cannot drift
import { CoverageReply, parseRequirement } from "./lib/schemas/fit-coverage.mjs"; // the model boundary

const MODEL = process.env.FIT_MODEL || "claude-sonnet-4-6";
export const FIT_CAPTION = "my read of the posting, not their scoreboard";

// Prompt-cache instrument. The gate walk sends the SAME system + dossier prefix up to GATE_SCAN (=6)
// times per user per run, and prompts/fit-coverage.mjs puts a cache breakpoint on the dossier block so
// calls 2..6 read it instead of re-paying for it. That saving is INVISIBLE without this: below a
// model's minimum prefix, or with a volatile byte in front, the API silently declines to cache — no
// write, no read, no error. A run that reports success proves nothing about whether it worked.
// Counting it here (rather than trusting the prompt's shape) is the guard: `read` must be
// non-zero on any run with more than one scored role per user. Printed once per run by scheduler.mjs.
const cacheStats = { calls: 0, write: 0, read: 0, uncached: 0, out: 0, outMax: 0, outOver1600: 0 };
export function coverageCacheStats() {
  const s = { ...cacheStats };
  // Share of prefix tokens served from cache rather than re-billed at full price.
  s.hitRate = s.read + s.write ? +(s.read / (s.read + s.write)).toFixed(3) : 0;
  return s;
}

function stripFences(s) {
  return String(s || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}
function textOf(res) {
  return (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// A JD is scoreable only if it actually states requirements. Guards against hallucinating gaps
// from a stub or marketing copy (Ashby-style sources set description null).
//
// The predicate lives in lib/jd-requirements.mjs because charlie-store.mjs needs the SAME answer when it
// decides which 2500 characters of a long posting to keep for the shared pool. If the two disagreed,
// the cap could hand this function a slice with the requirements cut off.
// Minimum dossier density, so a near-empty profile never yields a fabricated gap.
// ⚠️ THIS IS THE *LOOSE* BAR, AND IT IS DELIBERATELY LOOSER THAN `isThinDossier` (email-onboard.mjs).
// It governs what Charlie SENDS: falling below it makes coverage unscoreable, and quality-gate G3b then
// DROPS the role (we cannot judge fit at all). isThinDossier is stricter and governs only what Charlie
// SAYS. A person can be "thin" there and still correctly receive roles here. Do NOT merge the two.
function dossierIsDense(dossier) {
  const d = dossier || {};
  const n = (arr) => (Array.isArray(arr) ? arr.length : 0);
  return n(d.proof_points) + n(d.strengths) + n(d.case_studies) + n(d.experience) >= 2;
}

const SYSTEM = FIT_COVERAGE_SYSTEM;

// Deterministic approach lane from the grounded composite (never model-picked). In the DAILY role
// email the role has ALREADY cleared Charlie's bar, so the question is never "skip", it's how to
// approach it honestly:
//   apply  — you clear the core; go.
//   tune   — real fit; one honest move lifts it first (the move is shown above the CTA).
//   bypass — fit is real but likely buried in the stack; a human seeing you matters more than the
//            form, so lead with the warm intro. "about who sees you, not whether you're good."
export function laneFor(composite) {
  const c = Number(composite) || 0;
  if (c >= 70) return "apply";
  if (c >= 55) return "tune";
  return "bypass";
}
export function fitLane(cov) {
  if (!cov || cov.thin) return "apply";
  return cov.lane || laneFor(cov.composite);
}

// Returns { thin: true, reason } when un-scoreable, else the grounded coverage + a deterministic composite.
//
// `reason` MATTERS, do not drop it. `thin` makes quality-gate skip the fit floor, and the two ways of
// being un-scoreable deserve opposite fates:
//   reason "jd"      — the POSTING is too short/vague to score. Not the person's fault, and blocking
//                      would silence real roles, so the matcher bar alone carries the send.
//   reason "dossier" — we don't know enough about the PERSON to judge fit at all. Skipping the floor
//                      here means the thinnest profiles get roles judged on matcher score alone, i.e.
//                      the people we know least about receive the LEAST-checked sends. That inverts the
//                      product. gateRole drops these, which routes them to the completeness nudge.
export async function computeCoverage({ dossier, jobDescription, jobTitle = "" } = {}) {
  if (!dossierIsDense(dossier)) return { thin: true, reason: "dossier" };
  if (!jdIsScoreable(jobDescription)) return { thin: true, reason: "jd" };
  let j;
  try {
    const client = new Anthropic();
    const today = new Date().toISOString().slice(0, 10);
    // Stable-first, so the shared system + dossier prefix can be cached across the gate walk's
    // repeated calls for this user; the breakpoint sits on the dossier block. See prompts/fit-coverage.mjs.
    const messages = buildCoverageMessages({
      today,
      dossierText: JSON.stringify(dossier || {}, null, 2).slice(0, 6000),
      jobTitle,
      jobDescription: String(jobDescription).slice(0, 6000),
    });
    // RETRY ONCE. This call is the ONLY source of the fit chart, so a single transient blip would
    // otherwise delete it from that person's email. One retry costs at most one extra Sonnet call, and
    // ONLY when the first attempt already failed.
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // temperature 0 — this call JUDGES, it does not write prose. At the API default (1.0) the same
        // person against the same role can clear the gate on one run and miss it on the next; a
        // coverage score that moves when nothing about the person or the role moved is not evidence.
        // max_tokens 3000 is NOT optional. The stage-2 fields (evidence_strength, tool) push a full
        // 8-requirement reply past 1600 tokens, and a truncated reply fails JSON.parse -> retry ->
        // `thin: {reason:"error"}`. A thin coverage SKIPS the fit floor, so overflowing here would make
        // the gate fail OPEN. A ceiling is not a charge: output is billed on tokens actually produced.
        const res = await client.messages.create({ model: MODEL, max_tokens: 3000, temperature: 0, system: SYSTEM, messages });
        // Count what the API actually did with the cache, not what we asked it to do. Best-effort and
        // never throwing: an instrument must not be able to fail a send.
        const u = res?.usage || {};
        cacheStats.calls += 1;
        cacheStats.write += u.cache_creation_input_tokens || 0;
        cacheStats.read += u.cache_read_input_tokens || 0;
        cacheStats.uncached += u.input_tokens || 0;
        // Output tokens, so the stage-2 cost is measured rather than derived.
        const outTok = u.output_tokens || 0;
        cacheStats.out += outTok;
        if (outTok > cacheStats.outMax) cacheStats.outMax = outTok;
        if (outTok > 1600) cacheStats.outOver1600 += 1;
        const raw = JSON.parse(stripFences(textOf(res)));
        // MODEL BOUNDARY. Deliberately tolerant: it models what this function already defaulted,
        // so it rejects only a reply that is not a usable object. A stricter check here would route a
        // single bad field to `thin: {reason:"error"}`, and a thin coverage SKIPS the fit floor — the
        // gate would fail OPEN. Per-requirement strictness lives below, where it can fail closed.
        const parsed = CoverageReply.safeParse(raw);
        if (!parsed.success) {
          throw new Error(`coverage reply failed schema: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
        }
        j = parsed.data;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt === 1) await new Promise((r) => setTimeout(r, 750));
      }
    }
    if (lastErr) throw lastErr;
  } catch (e) {
    // The coverage pass itself failed. Same FATE as "jd" — this is uncertainty about the POSTING's
    // scoring, not evidence about the person, so the matcher bar carries the send rather than punishing
    // them (gateRole drops only on reason "dossier").
    //
    // But a DISTINCT reason, because the two are not the same fact. "jd" means we looked and the posting says too little. "error" means we never got to look, which is
    // OUR failure, is invisible in the email, and is the kind of thing that can rise to 100% during an
    // API incident while every send still reports success. The callers surface this reason (see
    // scheduler.mjs's readout census) so it can be counted instead of guessed at.
    console.error(`[fit] coverage failed after 2 attempts: ${e.message}`);
    return { thin: true, reason: "error", error: e.message };
  }

  // normalize + shape-guard. Strip em dashes at the source (model prose) so every downstream
  // surface (HTML and plaintext) is clean, per the no-em-dash rule.
  const deEm = (s) => String(s ?? "").replace(/\s*—\s*/g, ", ");
  // PER-REQUIREMENT BOUNDARY. A requirement that fails the schema is KEPT with status forced to
  // `unknown` rather than dropped: dropping removes it from the coverage denominator and RAISES the
  // score (fail-open). Forcing `unknown` scores it as unproven, and the deviation is logged so an
  // off-schema status (e.g. `partly`) is visible rather than silently moving someone's score.
  const reqs = (Array.isArray(j.requirements) ? j.requirements : [])
    .filter((r) => r && r.req)
    .slice(0, 8)
    .map((r) => {
      const checked = parseRequirement(r);
      if (!checked.ok) {
        console.error(`[fit] requirement failed schema, scored as unknown: "${String(r.req).slice(0, 48)}" — ${checked.why}`);
      }
      const v = checked.ok ? checked.value : { ...r, status: "unknown" };
      return {
        req: deEm(v.req),
        status: ["met", "partial", "unknown", "contradicted"].includes(v.status) ? v.status : "unknown",
        evidence: v.evidence ? deEm(v.evidence) : null,
        // Stage 1 + 2 — recorded, read by NO decision. null when the model did not supply them.
        gating: typeof v.gating === "boolean" ? v.gating : null,
        kind: v.kind ?? null,
        locator: v.locator ? deEm(v.locator) : null,
        evidence_strength: v.evidence_strength ?? null,
        tool: typeof v.tool === "boolean" ? v.tool : null,
      };
    });
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
  const skills = clamp01(j.skills_overlap);
  const seniority = clamp01(j.seniority?.score);
  const seniorityLevel = ["under", "at", "over"].includes(j.seniority?.level) ? j.seniority.level : "at";
  const domain = clamp01(j.domain);
  const parseable = clamp01(j.parseable);

  // must-have coverage from the grounded array: met=1, partial=0.5, unknown=0 (unproven, not credited).
  const met = reqs.filter((r) => r.status === "met").length;
  const partial = reqs.filter((r) => r.status === "partial").length;
  const unknown = reqs.filter((r) => r.status === "unknown").length;

  // Evidence-based fit floor. v1 counts every must-have equally; v2 counts only CORE
  // experience (a missing degree/cert is survivable, SHRM 2022). Both computed deterministically;
  // FIT_FLOOR_MODE selects which one gates the send (default shadow = v1 live + log the v2 divergence).
  const sub = { skills, seniority, domain, parseable };
  const mhV1 = mustHaveV1(reqs) ?? skills; // fall back to skills if no reqs extracted (both versions)
  const mhV2 = coreMustHave(reqs) ?? skills;
  const compositeV1 = computeComposite({ mustHave: mustHaveV1(reqs), ...sub });
  const compositeV2 = computeComposite({ mustHave: coreMustHave(reqs), ...sub });
  const mode = fitFloorMode();
  const mustHave = mode === "v2" ? mhV2 : mhV1;
  const composite = mode === "v2" ? compositeV2 : compositeV1;
  if (mode === "shadow" && compositeV1 !== compositeV2) {
    const credCount = reqs.filter((r) => reqKind(r.req) === "credential").length;
    console.error(`[fit-floor shadow] composite v1=${compositeV1} (${laneFor(compositeV1)}) -> v2=${compositeV2} (${laneFor(compositeV2)}) · ${credCount} credential req(s) now survivable · "${(jobTitle || "").slice(0, 40)}"`);
  }

  // confidence band from how much we could actually read.
  const unknownFrac = reqs.length ? unknown / reqs.length : 1;
  const confidence = reqs.length >= 3 && unknownFrac < 0.34 ? "high" : reqs.length < 2 || unknownFrac > 0.5 ? "low" : "medium";

  // the fit read as very short second-person bullets (why you fit + the one reason you're not 100%).
  // Tolerate an old-shape single `reason` string too, so a stale model reply never blanks the box.
  const reasonPoints = (Array.isArray(j.reason_points) ? j.reason_points : j.reason ? [j.reason] : [])
    .map((s) => deEm(String(s || "").trim())).filter(Boolean).slice(0, 3);

  // The three-line first-pass read. FAIL CLOSED PER LINE: anything that is not a usable sentence
  // becomes null and that row simply does not render. A missing row is a smaller failure than a
  // fabricated one, and the renderer already treats zero rows as "hide the section".
  //
  // Length-capped here rather than trusted from the prompt, because "at most ~22 words" in a prompt is
  // not enforcement. A model that returns a paragraph gets it dropped, not printed.
  const line = (v) => {
    const s = deEm(String(v ?? "").trim());
    if (!s || s.length < 12 || s.split(/\s+/).length > 34) return null;
    return s;
  };
  const sc = j.screen && typeof j.screen === "object" ? j.screen : {};
  const screen = { level: line(sc.level), domain: line(sc.domain), recent: line(sc.recent) };

  return {
    thin: false,
    lane: laneFor(composite),       // deterministic approach lane (apply | tune | bypass)
    composite,                      // 0..100, Charlie's read (NOT the employer's score)
    caption: FIT_CAPTION,           // ships attached so it can't be dropped downstream
    confidence,
    coverage: reqs,                 // [{req,status,evidence}]
    screen,                         // {level,domain,recent} — each a grounded one-liner or null
    counts: { met, partial, unknown },
    subscores: { mustHave: +mustHave.toFixed(2), skills, seniority, domain, parseable },
    seniorityLevel,
    topMove: j.top_move ? deEm(j.top_move) : null,
    reasonPoints,
    reason: reasonPoints.join(". "), // one-line form for the preheader + stored fit_reason (back-compat)
  };
}
