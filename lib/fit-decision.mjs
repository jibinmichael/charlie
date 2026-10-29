// lib/fit-decision.mjs — the Fit Engine v2 operator. PURE, DETERMINISTIC, AND WIRED TO NOTHING.
//
// Imported by no gate, no scheduler, no send path — `fit-decision.test.mjs` enumerates every root
// module and fails if that stops being true.
// v1 (quality-gate.mjs's matcher bar + fit floor) remains fully authoritative.
//
// WHAT IT REPLACES. v1's fit term is an AVERAGE over the requirement array: (met + 0.5·partial)/total.
// The coverage prompt's contract is "extract the JD's real MUST-HAVE requirements only", and must-haves
// are CONJUNCTIVE — an average lets four strong matches pay for four missing ones. This tests the set.
//
// ── WHY PARTIAL DOES NOT SATISFY, AND WHY THERE ARE NO REGEXES ───────────────
// Counting any PARTIAL as satisfying a gating requirement lets through evidence describing something
// that is NOT THERE (e.g. "Resume states '3+ years'; role asks 0-2"). Splitting PARTIAL with regexes
// over the evidence sentence only moves the problem: aspirations ("Profile TARGETS Chief of Staff
// roles"), unmarked seniority mismatches and trivial satisfaction ("English listed as spoken
// language") slip into whichever bucket the regex does not watch.
//
// ── SO THIS ONE CLASSIFIES NOTHING ───────────────────────────────────────────
// `evidence_strength` and `tool` are asked for at the point the evidence sentence is written, the same
// way `gating` and `kind` are, which keeps them reliable. The operator only reads fields.
//
// AND IT FAILS CLOSED ON THEIR ABSENCE. A met/partial row with no `evidence_strength` is UNPROVEN, not
// assumed good. There is deliberately no prose fallback: a fallback is how bad evidence gets smuggled
// through.

/** The four outcomes. They are the gate's existing send/digest/drop, renamed to say what they mean. */
export const STRONG = "strong-fit";
export const POSSIBLE = "possible-fit";
export const INSUFFICIENT = "insufficient-evidence";
export const NOT_A_FIT = "not-a-fit";

/**
 * Which evidence strengths can satisfy a requirement that `status` already calls MET.
 *
 * BOTH conditions are required. `status` says the record shows the thing; `evidence_strength` says how
 * good the showing is. Gating on strength ALONE accepts `partial` + `adjacent`, which lets, say, a
 * 3-year record pass a Senior requirement.
 *
 * `trivial` satisfies, because the requirement genuinely IS met and pretending otherwise would invent
 * a deficiency. What it cannot do is ANCHOR a send — see ANCHORING.
 */
export const SATISFYING = new Set(["direct", "adjacent", "trivial"]);

/** Only DIRECT evidence — them doing the thing at a named employer/project — can anchor a send. */
export const ANCHORING = new Set(["direct"]);

/**
 * Strengths that mean the ONLY support is the person's own assertion — a headline, a line in a skills
 * list ("Figma listed under tech preferences"; "7+ years" from a résumé headline). A meaningful share
 * of everything `status` calls MET is only this, and it cannot defend a send.
 */
export const UNDEMONSTRATED = new Set(["self-reported", "aspirational"]);

/** Kinds whose ABSENCE genuinely disqualifies, per the contract in prompts/fit-coverage.mjs. */
export const SILENCE_BLOCKS_ON = new Set(["experience-duration", "domain", "credential"]);

// ── deterministic contradiction: the record is plainly OUTSIDE a band the posting stated ──────
//
// This is arithmetic, not classification. It reads a numeric band off the requirement label and the
// years off the evidence, and compares them. There is no prose regex and nothing to tune.
//
// It is a factual call rather than a quality judgement, so it is more stable across re-extractions
// than `status` or `evidence_strength`.
//
// It rarely changes a send on its own: most such rows are already `partial`, which the operator
// refuses. It lets Charlie say "you are above the band they stated" instead of the false "your record
// does not show this", and it is the guard-rail for the day `partial` is ever accepted.
//
// SCOPE IS DELIBERATELY NARROW: `experience-duration` only, and only a CEILING. Exceeding a MINIMUM
// ("5+ years" against sixteen) is not a contradiction, and the two read almost identically in prose —
// which is why an earlier prose-based instrument got this wrong in both directions.

/** A stated range, e.g. "2-6 years PM", "1–3 years experience". Requires BOTH ends. */
const BAND = /(\d+)\s*[-–—]\s*(\d+)/;
/** A stated floor, e.g. "7+ years", "3+ years full-stack". */
const FLOOR = /(\d+)\s*\+/;
/** Years cited in the evidence. Decimal-safe: an earlier version read "1.5 years" as "5 years". */
const YEARS = /(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)/gi;
/** Months, so "roughly 14 months" is comparable to a years band. */
const MONTHS = /(\d+(?:\.\d+)?)\s*(?:months?|mos?\b)/gi;

/** Every duration the evidence states, in years. [] when it states none. */
function citedYears(evidence) {
  const e = String(evidence || "");
  const y = [...e.matchAll(YEARS)].map((m) => Number(m[1]));
  const mo = [...e.matchAll(MONTHS)].map((m) => Number(m[1]) / 12);
  return [...y, ...mo].filter(Number.isFinite);
}

/**
 * Compare a stated duration requirement against the duration the evidence cites.
 *
 * ONE function for all three cases, because they are one comparison with three outcomes, and splitting
 * them into three detectors is how a rule set starts drifting apart.
 *
 *   over    — the record is above a stated CEILING            -> contradiction
 *   under   — the record is below a stated FLOOR or band start -> contradiction
 *   inside  — the record falls within a stated band            -> satisfied, whatever the judge said
 *
 * Arithmetic only. No prose is read, nothing is inferred, and there is no threshold to tune: the
 * numbers come from the posting's own label and the judge's own citation.
 *
 * @returns {{verdict:"over"|"under"|"inside", floor:number|null, ceiling:number|null, found:number}|null}
 */
export function durationVerdict(requirement) {
  const r = requirement || {};
  if (r.kind !== "experience-duration") return null;      // a range on anything else is not a duration
  if (r.status !== "met" && r.status !== "partial") return null; // silence has no number to compare
  const label = String(r.req || "");
  const band = label.match(BAND);
  const floorOnly = band ? null : label.match(FLOOR);
  if (!band && !floorOnly) return null;
  const floor = band ? Number(band[1]) : Number(floorOnly[1]);
  const ceiling = band ? Number(band[2]) : null;
  const years = citedYears(r.evidence);
  if (!years.length) return null;
  const found = Math.max(...years);
  // Rounded to one decimal before comparing, so "about 1.4 years" against a floor of 1 is not decided
  // by floating-point noise.
  const f = Math.round(found * 10) / 10;
  if (ceiling !== null && f > ceiling) return { verdict: "over", floor, ceiling, found: f };
  if (f < floor) return { verdict: "under", floor, ceiling, found: f };
  if (ceiling !== null) return { verdict: "inside", floor, ceiling, found: f };
  return null; // a floor that is cleared is simply satisfied by the ordinary route
}

/** Kept as a named export: the over-ceiling case on its own. */
export function overStatedBand(requirement) {
  const v = durationVerdict(requirement);
  return v?.verdict === "over" ? { ceiling: v.ceiling, found: v.found } : null;
}

/**
 * Split a requirement array into the sets the decision reads.
 *
 * `constraint`-kind requirements are EXCLUDED from fit entirely: location, work authorisation and
 * employment type are already decided upstream by the constraint gates (quality-gate.mjs,
 * presend-guard.mjs), and judging the same fact twice is not a second opinion.
 */
export function partition(requirements) {
  const reqs = Array.isArray(requirements) ? requirements.filter(Boolean) : [];
  const constraint = reqs.filter((r) => r.kind === "constraint");
  const rest = reqs.filter((r) => r.kind !== "constraint");
  return {
    gating: rest.filter((r) => r.gating === true),
    preferred: rest.filter((r) => r.gating === false),
    // Neither true nor false: an un-enriched row, or one the model declined to classify. It cannot
    // enter the conjunction, and its presence is itself a reason not to trust the verdict.
    unclassified: rest.filter((r) => r.gating !== true && r.gating !== false),
    constraint,
  };
}

/**
 * Classify ONE gating requirement into what it does to the decision. Reads fields; classifies nothing.
 * @returns {{outcome:"satisfied"|"contradiction"|"unproven", why:string, blocks:boolean, anchors:boolean, silenceOnly?:boolean}}
 */
export function requirementOutcome(r, cited) {
  const kind = r?.kind ?? null;

  if (r.status === "contradicted") return { outcome: "contradiction", why: "contradicted", blocks: true, anchors: false };

  // DERIVED CONTRADICTION, checked before anything else can satisfy: the record is above a band the
  // posting stated. Arithmetic, so it outranks the model's own status — a row can be `met` and still
  // be out of range, which is precisely the case that has no other detector.
  const dur = durationVerdict(r);
  if (dur?.verdict === "over") {
    return { outcome: "contradiction", why: `over-stated-band:${dur.found}>${dur.ceiling}`, blocks: true, anchors: false, band: { ceiling: dur.ceiling, found: dur.found } };
  }
  if (dur?.verdict === "under") {
    // The mirror of the ceiling case. "7+ years" against four years is not partial satisfaction; the
    // record contradicts the stated floor, even when the judge scored it `partial`.
    return { outcome: "contradiction", why: `under-stated-floor:${dur.found}<${dur.floor}`, blocks: true, anchors: false, band: { floor: dur.floor, found: dur.found } };
  }

  if (r.status === "met" || r.status === "partial") {
    // A claim that will not resolve to a line in the record is UNPROVEN, never a miss — and it always
    // blocks, because it is a claim ABOUT A PERSON rather than a silence about a tool.
    if (!cited(r)) return { outcome: "unproven", why: "citation-unresolved", blocks: true, anchors: false };
    const s = r.evidence_strength ?? null;
    // FAIL CLOSED, NO FALLBACK.
    if (!s) return { outcome: "unproven", why: "evidence-strength-absent", blocks: true, anchors: false };
    // THE PERSON'S OWN CLAIM IS NOT A DEMONSTRATION. Checked before SATISFYING so the reason recorded
    // is the specific one, not a generic "wrong strength".
    if (UNDEMONSTRATED.has(s)) return { outcome: "unproven", why: `undemonstrated:${s}`, blocks: true, anchors: false };
    // INSIDE the stated band. The posting asked 1-3 years, the record says 14 months, and the judge
    // still called it partial. The arithmetic is not in doubt, so it satisfies — and it anchors,
    // because a duration inside the asked-for range IS the thing asked for.
    //
    // DELIBERATELY AFTER the undemonstrated check, not before. A "7 years" that exists only in a
    // résumé headline is still only a claim, and letting the arithmetic bless it would reopen the
    // exact gap the undemonstrated rule exists to close. Self-reported inside-band rows keep blocking.
    if (dur?.verdict === "inside") {
      return { outcome: "satisfied", why: `inside-stated-band:${dur.floor}-${dur.ceiling}`, blocks: false, anchors: true };
    }
    // BOTH must hold: `status` says the record shows it, `evidence_strength` says the showing is real.
    // Strength alone accepts `partial` + `adjacent`, which is a false-positive route.
    if (r.status === "met" && SATISFYING.has(s)) {
      return { outcome: "satisfied", why: `met:${s}`, blocks: false, anchors: ANCHORING.has(s) };
    }
    return { outcome: "unproven", why: `${r.status}:${s}`, blocks: true, anchors: false };
  }

  if (r.status === "unknown") {
    // Silence. A missing TOOL is not a shortfall — prompts/fit-coverage.mjs, "tools are learnable
    // and are usually just unlisted". `tool` is asked for directly because `kind` cannot express it:
    // "Kubernetes" and "Information architecture" are both `capability`. Anything the contract names
    // as genuinely disqualifying still blocks, whatever `tool` says.
    if (r.tool === true && !SILENCE_BLOCKS_ON.has(kind)) {
      return { outcome: "unproven", why: "unknown:tool", blocks: false, anchors: false, silenceOnly: true };
    }
    return { outcome: "unproven", why: `unknown:${kind ?? "unkinded"}`, blocks: true, anchors: false, silenceOnly: true };
  }

  // Any other value — e.g. "partly", which grounding-enforce.mjs can write on a rejected claim.
  // Unproven, never satisfied.
  return { outcome: "unproven", why: `unrecognised-status:${r.status}`, blocks: true, anchors: false };
}

/**
 * The v2 fit verdict. A pure function of the requirement records — no model, no blended score, no
 * prose classification.
 *
 * @param {object[]} requirements  the enriched `_cov.coverage` array
 * @param {object}   [opts]
 * @param {(r:object)=>boolean} [opts.cited]  citation check; default: trust the citation.
 * @param {number}  [opts.gatingFloor=3]  a conjunction over fewer than this many gating requirements
 *        is not a screen.
 * @param {boolean} [opts.requireAnchor=true]  at least one gating requirement must carry DIRECT
 *        evidence. Adjacency and triviality corroborate; neither is a reason to send.
 * @param {boolean} [opts.toolSilenceBlocks=false]  set true to make a missing tool block anyway; the
 *        option keeps the comparison reproducible.
 */
export function fitDecision(requirements, opts = {}) {
  const cited = typeof opts.cited === "function" ? opts.cited : () => true;
  const gatingFloor = Number.isFinite(opts.gatingFloor) ? opts.gatingFloor : 3;
  const requireAnchor = opts.requireAnchor !== false;
  const toolSilenceBlocks = opts.toolSilenceBlocks === true;

  const p = partition(requirements);
  const counts = { satisfied: 0, anchors: 0, contradiction: 0, blocking: 0, tolerated: 0, undemonstrated: 0, overBand: 0, byStrength: {} };
  const blocking = [];
  const contradictions = [];
  const tolerated = [];

  // FAIL CLOSED ON A SET WE CANNOT READ. An empty conjunction is vacuously true, and a conjunction
  // over one or two items is barely a test.
  if (p.gating.length < Math.max(1, gatingFloor)) {
    return {
      verdict: INSUFFICIENT,
      why: p.gating.length === 0
        ? (p.unclassified.length ? "no requirement is marked gating (unenriched or unclassified)" : "the posting states no required requirement")
        : `only ${p.gating.length} required requirement(s) — too few to constitute a screen`,
      gatingTotal: p.gating.length, counts, blocking, contradictions, tolerated,
    };
  }

  for (const r of p.gating) {
    const o = requirementOutcome(r, cited);
    if (r.evidence_strength) counts.byStrength[r.evidence_strength] = (counts.byStrength[r.evidence_strength] || 0) + 1;

    if (o.outcome === "contradiction") {
      counts.contradiction++;
      // `band` is preserved so the explanation can say "you are above the band they stated" rather
      // than the false "your record does not show this". Absent for a model-supplied `contradicted`.
      contradictions.push({ req: r.req, kind: r.kind, why: o.why, evidence: r.evidence, band: o.band ?? null });
      continue;
    }
    if (o.outcome === "satisfied") {
      counts.satisfied++;
      if (o.anchors) counts.anchors++;
      continue;
    }
    if (o.why?.startsWith("undemonstrated:")) counts.undemonstrated++;
    const blocks = o.blocks || (toolSilenceBlocks && o.why === "unknown:tool");
    if (blocks) { counts.blocking++; blocking.push({ req: r.req, kind: r.kind, tool: r.tool ?? null, why: o.why, evidence: r.evidence }); }
    else { counts.tolerated++; tolerated.push({ req: r.req, kind: r.kind, why: o.why }); }
  }

  if (counts.contradiction) {
    counts.overBand = contradictions.filter((c) => c.band).length;
    return { verdict: NOT_A_FIT, why: `${counts.contradiction} required thing their record contradicts`, gatingTotal: p.gating.length, counts, blocking, contradictions, tolerated };
  }
  if (counts.blocking) {
    return { verdict: POSSIBLE, why: `${counts.blocking} of ${p.gating.length} required things their record does not show`, gatingTotal: p.gating.length, counts, blocking, contradictions, tolerated };
  }
  // THE FLOOR APPLIES TO WHAT WAS ACTUALLY DECIDED, not to what was asked.
  //
  // A tolerated tool silence is not evidence either way — it is a requirement the contract says not to
  // hold against anyone. Counting it toward "enough requirements to be a screen" lets a conjunction be
  // satisfied by almost nothing: ONE satisfied requirement of seven, the other six being unlisted
  // tools (Next.js, Prisma, SWR, Electron, Swift, React Native).
  //
  // This is the SAME floor, applied to the set it was always meant to describe.
  if (counts.satisfied < Math.max(1, gatingFloor)) {
    return {
      verdict: INSUFFICIENT,
      why: `only ${counts.satisfied} of ${p.gating.length} required things were actually decided (${counts.tolerated} unlisted tool(s) tolerated) — too few to constitute a screen`,
      gatingTotal: p.gating.length, counts, blocking, contradictions, tolerated,
    };
  }
  if (requireAnchor && counts.anchors === 0) {
    return { verdict: INSUFFICIENT, why: `nothing is shown DIRECTLY — ${counts.satisfied} satisfied, none by direct evidence`, gatingTotal: p.gating.length, counts, blocking, contradictions, tolerated };
  }
  // A DECISION MAY NOT REST ON MORE THINGS ASSUMED THAN THINGS SHOWN.
  //
  // Tolerating an unlisted tool is right — a person who never wrote "Helm" on a resume may well know
  // it, and the contract says not to hold that silence against them. But tolerance is a licence to
  // stay silent about a MINORITY of the screen, not to carry it.
  //
  // The failure this prevents: "Senior Software Engineer, Developer Platform & AI Tooling" passing as
  // a send on 3 satisfied requirements with Kubernetes, Helm, Terraform and ArgoCD ALL silent and all
  // tolerated. On a platform role that stack is not incidental tooling, it is the job; four
  // assumptions must not outvote three demonstrations.
  //
  // The rule is arithmetic and has nothing to tune: tolerated may not EXCEED satisfied. It does not
  // make an unlisted tool blocking, it does not change the floor, and it does not touch the
  // conjunction — it only refuses to call something a screen when most of it was assumed. Strong
  // matches typically satisfy 5 or 6 with at most one tolerated tool, so they are unaffected.
  if (counts.tolerated > counts.satisfied) {
    return {
      verdict: INSUFFICIENT,
      why: `${counts.tolerated} unlisted tool(s) tolerated against only ${counts.satisfied} shown — more of this role was assumed than demonstrated`,
      gatingTotal: p.gating.length, counts, blocking, contradictions, tolerated,
    };
  }
  return {
    verdict: STRONG,
    why: `all ${p.gating.length} required things shown in their own record (${counts.anchors} direct${counts.tolerated ? `, ${counts.tolerated} unlisted tool(s)` : ""})`,
    gatingTotal: p.gating.length, counts, blocking, contradictions, tolerated,
  };
}

// ── citation resolution ──────────────────────────────────────────────────────
// An evidence string is a MODEL'S CLAIM about the dossier, and Charlie's moat already treats such
// claims as unproven until checked (grounding-verify.mjs, citeOrDrop). This is the cheap mechanical
// half: does the citation's distinctive vocabulary occur in the person's own record?
//
// This is NOT an evidence classifier. It does not judge what the evidence MEANS, only whether the
// words it cites are in the record. The semantic judgement is `evidence_strength`, and that is asked
// for, never inferred.
//
// CAVEAT: evidence is often phrased negatively ("Flask is not explicitly mentioned"), so it names
// things absent from the dossier and would score low by construction. positiveClause() strips that
// half before scoring.
//
// NO THRESHOLD IS BAKED IN. citationSupport returns the fraction; the caller decides.

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "their", "they", "profile", "resume", "states", "shows", "listed", "mention", "mentioned", "experience", "role", "roles", "work", "across", "including", "explicit", "explicitly", "not", "cited", "anywhere", "candidate", "confirmed", "specifically"]);

/**
 * The half of a citation that asserts something FOUND, with the "but X is missing" half removed.
 * Without this, a well-formed partial is penalised for naming the thing it honestly could not find.
 */
export function positiveClause(evidence) {
  const e = String(evidence || "");
  const cut = e.search(/;\s*(no |not |but )|,\s*but\b|\bbut\b\s+no\b|\bno explicit\b|\bnot explicitly\b|\bno evidence\b|\bno mention\b/i);
  return cut > 0 ? e.slice(0, cut) : e;
}

/** The tokens a citation would have to invent to be fabricated: proper nouns, numbers, long words. */
export function anchors(text) {
  const raw = String(text || "");
  const out = new Set();
  for (const m of raw.match(/\b[A-Z][A-Za-z0-9.+#-]{2,}\b/g) || []) out.add(m.toLowerCase());
  for (const m of raw.match(/\b\d[\d.,+]*\b/g) || []) out.add(m.toLowerCase());
  for (const m of raw.match(/\b[a-z][a-z-]{6,}\b/gi) || []) out.add(m.toLowerCase());
  for (const s of STOP) out.delete(s);
  return [...out];
}

/**
 * What fraction of a citation's POSITIVE anchors occur in the person's own record?
 * @returns {number|null} 0..1, or null when there is nothing checkable (unmeasurable, not refuted).
 */
export function citationSupport(evidence, dossierText) {
  const a = anchors(positiveClause(evidence));
  if (!a.length) return null;
  const hay = String(dossierText || "").toLowerCase();
  if (!hay) return null;
  let hit = 0;
  for (const t of a) if (hay.includes(t)) hit++;
  return hit / a.length;
}
