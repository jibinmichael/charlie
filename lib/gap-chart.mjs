// lib/gap-chart.mjs — the gap chart built from REAL COMPREHENSION instead of a prefix match.
//
// WHY. market-report.mjs's keyword chart (`topicsFor`) decides whether a person has a skill by
// comparing the first four characters of two words (`covers`), fed single words split out of job
// TITLES. That can call "Management" a product leader's standout strength (it is a word of their own
// job title) and "Owner" a gap worth writing about (a synonym for their job), in Charlie's own voice.
//
// WHAT THIS USES INSTEAD. `computeCoverage` (fit-coverage.mjs) already reads a posting, extracts the
// requirements it actually states, judges each met/partial/unknown against the dossier, and quotes
// the person's own evidence. It runs on every role that reaches the gate. This module pools those rows
// across the person's strongest postings and shapes them into the SAME row contract
// `render-market-report.mjs` already draws, so no template changes.
//
// THE FOUR RULES, none of them preferences:
//
//   1. NO TAXONOMY. Labels are a posting's own words, verbatim, never rewritten or mapped onto a
//      fixed skill list. A wrong mapping becomes a wrong claim about a person.
//   2. NO IMPLICIT-SKILL INFERENCE. A requirement is a strength only where computeCoverage already
//      returned `met` AND cited evidence. `unknown` stays unknown. A model deciding a candidate knows
//      Excel because they had five years of project management is the exact failure.
//   3. CITE-OR-DROP, applied the way grounding-enforce.mjs applies it: to claims ABOUT THE PERSON.
//      "You have this" without an evidence quote is dropped. "You are quiet on this" asserts nothing
//      about them, so it needs no quote about them — its receipt is the requirement text and the
//      employers who asked. Dropping those instead would delete every genuine gap.
//   4. ERR TOWARD COVERED, deliberately, and for the reason market-report.mjs already states:
//      a false "you have this" is a mild overlap claim, while a false "you are quiet on this" tells
//      a person their own core skill is missing. So ONE grounded `met` makes a cluster a strength
//      even when other postings phrased it in a way the reader judged unknown.
//
// FAIL-OPEN, everywhere. No coverage results -> null, and the caller keeps the keyword chart. Voyage
// down -> lexical clustering, whose failure mode is a DUPLICATE row, never an invented one.

import { embedTexts, cosineSim } from "./voyage.mjs";

// A requirement only ONE employer names is that company's own vocabulary, not a market signal. This
// is the same rule that keeps "Auth0" (a product Okta sells, lifted from its own posting) off the
// keyword chart in market-report.mjs, restated for a 5-posting sample. Two independent
// employers, not two postings: three openings at one company are still one company asking.
const MIN_EMPLOYERS = 2;
const PER_SIDE = 5; // rows per side of the diverging chart. Matches TOPIC_PER_SIDE.

// Cosine at or above this means two postings are asking for the same thing. Tuned for the int8
// voyage-3.5-lite vectors the pre-filter already uses. Deliberately NOT an env var: it is a value to
// read off the shadow logs and change in code with a reason, not a production dial. Set high — the
// cost of under-merging is a duplicate row, the cost of over-merging is two different requirements
// wearing one label, which is a wrong claim.
const SAME_REQ_COSINE = 0.82;
const SAME_REQ_JACCARD = 0.6; // lexical fallback when Voyage is unavailable

const STOP = new Set([
  "a", "an", "and", "or", "the", "of", "in", "on", "at", "to", "for", "with", "by", "as", "is", "are",
  "be", "been", "you", "your", "our", "we", "this", "that", "it", "its", "have", "has", "had", "will",
  "can", "able", "experience", "experienced", "years", "year", "yrs", "plus", "strong", "excellent",
  "proven", "demonstrated", "solid", "deep", "working", "ability", "skills", "knowledge",
]);

const words = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9+#.\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

function jaccard(a, b) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Flatten the per-posting coverage results into one row per (requirement, posting).
 * Pure. Drops nothing except structurally unusable rows — the grounding rules are applied later,
 * at the cluster, so a `met` in one posting can still rescue an `unknown` in another (rule 4).
 *
 * @param {Array<{job:object, cov:object}>} items
 * @returns {Array<{req:string, status:string, evidence:string|null, company:string, title:string}>}
 */
// ── Eligibility is not capability ───────────────────────────────────────────
// computeCoverage extracts what a posting ASKS FOR, and a posting asks for more than skills: how
// many years, what level, where you sit, whether you can be hired. Those are eligibility criteria.
// Rendering them as "yours" or "a gap" makes a claim about who someone IS from a line about whether
// they QUALIFY.
//
// Unfiltered, the chart tells a senior product designer their standout strengths are "Remote work",
// "4+ years experience" and "Side projects", and tells a QA automation engineer they have ZERO
// strengths and are missing "8+ years experience" — which can silence a briefing entirely, because
// eligibility needs two proven domains.
//
// THE RULE IS NOT "IS THIS A SKILL" — that judgement is a taxonomy, and rule 1 above forbids one.
// It is: DOES ANOTHER GATE ALREADY OWN THIS? Each category below is already judged by dedicated,
// tested machinery, so putting it on the chart is both wrong and redundant:
//
//   years         -> the knockout floor reads professional_years (lib/experience-years.mjs)
//   level         -> seniorityVerdict (lib/role-level.mjs)
//   location      -> classifyPlace + the geo gate (quality-gate.mjs)
//   authorization -> the knockout gate
//   education     -> a credential, not something a person "covers"
//
// Every pattern is ANCHORED or otherwise whole-string, deliberately. A substring match would delete
// real skills: "experience managing remote engineering teams" is a capability and must survive, while
// the bare arrangement line "Remote work" must not. Over-filtering is the worse failure here — the
// same asymmetry rule 4 states (a stoplist that removes "engineer" or "designer" takes real rows).
// A LEADING year count is only an eligibility row when the count is ALL it says. "4+ years experience"
// is tenure; "5+ years managing PMs" is a capability that happens to open with a number. Strip the
// count and the filler
// these phrases always use, then ask whether anything substantive is left.
const YEARS_HEAD = /^(?:min(?:imum)?\.?\s+|at least\s+)?\d+\s*\+?\s*(?:[-–]\s*\d+\s*\+?\s*)?years?\b/i;
const YEARS_FILLER = /\b(?:of|in|total|relevant|professional|work|working|experience|exp\.?)\b/gi;
function isBareTenure(s) {
  const m = YEARS_HEAD.exec(s);
  if (!m) return false;
  const rest = s.slice(m[0].length).replace(YEARS_FILLER, "").replace(/[^a-z0-9]+/gi, " ").trim();
  return rest.length < 3;
}

const ELIGIBILITY_ROWS = [
  { name: "years", test: isBareTenure },
  // "Senior PM level", "staff-level" — the word `level` is what makes it a band rather than a skill.
  { name: "level", test: (s) => /\blevels?\s*$/i.test(s) || /^(?:senior|staff|principal|junior|mid|entry|associate)[-\s]level\b/i.test(s) },
  // The bare work-arrangement line only. Anchored, so "experience managing remote teams" survives.
  { name: "location", test: (s) => /^(?:fully\s+|100%\s+)?(?:remote|hybrid|on-?site|in-?office|in-?person)(?:\s+(?:work|working|role|position|only))?\s*$/i.test(s) || /^(?:willing(?:ness)? to |able to )?relocat\w*\b/i.test(s) },
  // Hiring eligibility the knockout gate already judges. SECURITY CLEARANCE IS DELIBERATELY ABSENT:
  // nothing else in Charlie judges it, so by this filter's own rule — "does another gate own it?" —
  // it stays, and "these roles want a clearance you do not have" is a gap worth telling someone.
  // The existing coverageDomains fixtures caught this when the first draft swept it up.
  { name: "authorization", test: (s) => /\b(?:work authoriz\w*|visa|sponsorship|right to work|eligible to work)\b/i.test(s) },
  { name: "education", test: (s) => /^(?:bachelor|master|mba|b\.?\s?tech|b\.?\s?e\.?\b|ph\.?d|degree\b)/i.test(s) },
];

/**
 * Is this requirement a capability claim, or an eligibility criterion another gate already owns?
 * @param {string} req the posting's own requirement text
 * @returns {{keep: boolean, why: string}} `why` names the owning gate when dropped, for the log.
 */
export function capabilityRow(req) {
  const s = String(req || "").trim();
  if (!s) return { keep: false, why: "empty" };
  for (const { name, test } of ELIGIBILITY_ROWS) if (test(s)) return { keep: false, why: name };
  return { keep: true, why: "" };
}

export function pooledRequirements(items) {
  const out = [];
  const dropped = [];
  for (const it of Array.isArray(items) ? items : []) {
    const cov = it?.cov;
    if (!cov || cov.thin || !Array.isArray(cov.coverage)) continue; // thin/errored posting contributes nothing
    const company = String(it?.job?.company || "").trim();
    const title = String(it?.job?.title || "").trim();
    if (!company) continue; // no employer -> cannot satisfy the two-employer rule, and cannot be cited
    for (const r of cov.coverage) {
      const req = String(r?.req || "").trim();
      if (!req) continue;
      // Eligibility criteria never become chart rows — another gate already judges each of them.
      const cap = capabilityRow(req);
      if (!cap.keep) { dropped.push(`${req} (${cap.why})`); continue; }
      const status = ["met", "partial", "unknown"].includes(r?.status) ? r.status : "unknown";
      const evidence = r?.evidence ? String(r.evidence).trim() : null;
      out.push({ req, status, evidence: evidence || null, company, title });
    }
  }
  // Say what was removed. A filter that silently shrinks its input is how a guard becomes data loss,
  // and this one can legitimately empty the chart — a person whose only "strengths" were years and
  // work arrangement has nothing real to show, and silence is the correct answer there.
  if (dropped.length) console.error(`[gap-chart] dropped ${dropped.length} eligibility row(s) another gate owns: ${dropped.slice(0, 6).join(" · ")}`);
  return out;
}

/**
 * Group requirement rows that are asking for the same thing.
 *
 * Greedy single-pass agglomeration against each cluster's FIRST member, which is stable (no
 * randomness, no iteration order surprises) and cheap at this size — five postings yield at most
 * ~40 requirement strings.
 *
 * `embed` is injected so the test can run without a network and without a key.
 * A null embedding set (no VOYAGE_API_KEY, an outage, a malformed batch) falls back to lexical
 * overlap. That is a DEGRADED merge, not a wrong one: it under-merges, producing two rows where one
 * belonged, and never merges two things that are not alike.
 *
 * @returns {Promise<Array<Array<object>>>} clusters, each an array of pooled rows
 */
export async function clusterRequirements(rows, { embed = embedTexts } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 2) return list.map((r) => [r]);

  let vecs = null;
  try {
    vecs = await embed(list.map((r) => r.req), { inputType: "document" });
  } catch {
    vecs = null; // fail open to lexical
  }
  const usable = Array.isArray(vecs) && vecs.length === list.length;

  const clusters = [];
  const heads = []; // index of each cluster's first member, so comparison is against a fixed anchor
  for (let i = 0; i < list.length; i++) {
    let joined = false;
    for (let c = 0; c < clusters.length; c++) {
      const h = heads[c];
      const same = usable && vecs[i] && vecs[h]
        ? cosineSim(vecs[i], vecs[h]) >= SAME_REQ_COSINE
        : jaccard(list[i].req, list[h].req) >= SAME_REQ_JACCARD;
      if (same) { clusters[c].push(list[i]); joined = true; break; }
    }
    if (!joined) { clusters.push([list[i]]); heads.push(i); }
  }
  return clusters;
}

/**
 * The chart rows. Same contract render-market-report.mjs already draws for the keyword chart —
 * { key, label, flow, evidenced, live, examples:[{company,title}] } — plus `evidence`, the person's
 * own quote, which the renderer does not yet display. Carried because the row is only allowed to
 * exist when it can produce one (rule 3), and because showing it is the obvious next step once the
 * flag flips.
 *
 * `live` is "how many of these postings ask for it", so it is at most the shortlist size. The keyword
 * chart's `live` counts the whole reachable set. Both are honest counts of what the bar is drawn
 * from; they are not the same quantity and the copy around them reads correctly for either.
 *
 * @param {Array<{job:object, cov:object}>} items  one entry per posting that was coverage-scored
 * @returns {Promise<Array<object>|null>} null when there is nothing to say (caller keeps today's chart)
 */
export async function coverageDomains(items, { embed = embedTexts } = {}) {
  const rows = pooledRequirements(items);
  if (rows.length < 2) return null;

  const clusters = await clusterRequirements(rows, { embed });
  const built = [];
  for (const cl of clusters) {
    const employers = new Set(cl.map((r) => r.company.toLowerCase()));
    if (employers.size < MIN_EMPLOYERS) continue; // one company's own ask, not the market's

    // Rule 4 + rule 2 + rule 3 in one place: a strength needs a grounded `met` that cited evidence.
    // `partial` never promotes to a strength on its own — "eighteen months coordinating two PMs" is exactly the
    // honest gap the brief wants named, not a spike.
    const proof = cl.find((r) => r.status === "met" && r.evidence);
    const evidenced = Boolean(proof);
    // A `met` with NO evidence quote is a claim about the person with no receipt. It does not make
    // this a strength (handled above) and it must not silently sit in the gap column pretending to
    // be an unknown either, so it simply contributes nothing beyond its employer count.
    const partial = cl.find((r) => r.status === "partial" && r.evidence);

    // Label: the SHORTEST phrasing in the cluster, verbatim. Shortest because the chart cell is
    // narrow; verbatim because rewriting it would be the taxonomy this build exists to refuse.
    const label = cl.map((r) => r.req).sort((a, b) => a.length - b.length || a.localeCompare(b))[0];

    const seen = new Set();
    const examples = [];
    for (const r of cl) {
      const k = `${r.company}::${r.title}`;
      if (seen.has(k)) continue;
      seen.add(k);
      examples.push({ company: r.company, title: r.title });
      if (examples.length >= 4) break;
    }

    built.push({
      key: label.toLowerCase(),
      label,
      flow: label,
      evidenced,
      live: employers.size === 0 ? 0 : new Set(cl.map((r) => `${r.company}::${r.title}`)).size,
      examples,
      evidence: (proof || partial)?.evidence || null,
      statuses: { met: cl.filter((r) => r.status === "met").length, partial: cl.filter((r) => r.status === "partial").length, unknown: cl.filter((r) => r.status === "unknown").length },
    });
  }
  if (!built.length) return null;

  built.sort((a, b) => b.live - a.live || a.label.localeCompare(b.label));
  // Cap each side independently so one crowded side cannot squeeze the other off the chart —
  // the same shape topicsFor uses, and the reason the strengths column cannot be crowded out.
  const yours = built.filter((r) => r.evidenced).slice(0, PER_SIDE);
  const gaps = built.filter((r) => !r.evidenced).slice(0, PER_SIDE);
  return [...yours, ...gaps].sort((a, b) => b.live - a.live);
}

// ── What the email will actually DRAW ────────────────────────────────────────
// ONE definition, used by the renderer (render-market-report.mjs `coverage`) and by the shadow log
// (market-report.mjs). Two separate answers would drift:
//
//   chartSides() — gravity + marketAsk, with a `minAsk` noise floor on the gap side
//   the EMAIL    — every live>0 row from report.domains, no floor, and NOTHING AT ALL when fewer than
//                  three rows survive
//
// so a shadow log built on chartSides() could not tell you what the email looks like.
//
// This is deliberately the RENDERER's rule, not chartSides'. Making the log honest must not quietly
// change what a real person receives; the two disagreements it exposes (an inert `minAsk`, and
// eligibility passing on gravity while the chart draws nothing) are reported by the caller rather
// than silently reconciled here.
export const CHART_MIN_ROWS = 3;

/**
 * Exactly what the market email's chart will show for a given domains array.
 * @param {Array<{label?:string, evidenced?:boolean, live?:number}>} domains
 * @returns {{shown: boolean, strengths: Array, gaps: Array, rows: Array, reason: string}}
 */
export function chartPlan(domains) {
  const rows = (Array.isArray(domains) ? domains : []).filter((d) => d && Number(d.live) > 0);
  if (rows.length < CHART_MIN_ROWS) {
    return { shown: false, strengths: [], gaps: [], rows, reason: `${rows.length} row(s) with live>0, needs ${CHART_MIN_ROWS}` };
  }
  const byLive = (a, b) => b.live - a.live;
  return {
    shown: true,
    strengths: rows.filter((d) => d.evidenced).sort(byLive),
    gaps: rows.filter((d) => !d.evidenced).sort(byLive),
    rows,
    reason: "",
  };
}
