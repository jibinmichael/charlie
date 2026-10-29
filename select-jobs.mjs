// select-jobs.mjs — the deterministic per-user pre-filter.
//
// Before the maxJobsPerUser cap, pick the jobs most RELEVANT to ONE person by cheap,
// deterministic rules read off their dossier — role family, location/remote, seniority,
// and hard dealbreakers — then rank the survivors and take the top N. No model calls, no
// embeddings. This only SELECTS jobs that are plausibly a fit; it never scores fit or
// invents anything (that stays the matcher's job). It exists so the matcher's 150 slots
// hold each person's RELEVANT roles, not an arbitrary scan-order slice.
//
// Role-agnostic: a designer's selection skews design, a sales profile's skews sales,
// purely from each person's stated target — same code, any field.

import { homeRegion, reachableForRegion, reachabilityVerdict, eligibilityBlocker, tier2Mode } from "./quality-gate.mjs";
import { knockouts, knockoutMode } from "./eligibility-gate.mjs"; // the knockout floor
import { cosineSim } from "./lib/voyage.mjs";

// Role families — loose, overlapping keyword patterns. A title can match several. Used to
// (a) classify each job and (b) classify the person's target role, then keep the overlap.
const FAMILIES = {
  design: /(\bdesign(er|s)?\b|\bux\b|\bui\b|user experience|user interface|product design|design system|interaction design|visual design|brand design|graphic design|design engineer|ux research)/i,
  engineering: /(engineer|developer|\bswe\b|software|back[- ]?end|front[- ]?end|full[- ]?stack|devops|\bsre\b|\bplatform\b|infrastructure|\bmobile\b|\bios\b|android|firmware|embedded|security engineer|\bqa\b|test engineer|web developer|programmer|tech lead|staff engineer|solutions architect)/i,
  data: /(data scientist|data analyst|\banalytics\b|machine learning|\bml\b|\bai\b research|deep learning|data engineer|business intelligence|\bbi\b analyst|statistician|\bquant\b|analytics engineer)/i,
  product: /(product manager|product management|\bpm\b|group product|product owner|product lead|head of product|\bcpo\b|technical product|director of product)/i,
  marketing: /(marketing|\bgrowth\b|demand gen|content (writer|strategist|marketing)|\bseo\b|\bsem\b|brand manager|product marketing|\bpmm\b|social media|communications|copywriter|community manager|lifecycle)/i,
  sales: /(\bsales\b|account executive|\bae\b|\bsdr\b|\bbdr\b|account manager|business development|\brevenue\b|\bgtm\b|partnership|sales development|enterprise sales|inside sales)/i,
  success: /(customer success|customer support|\bcsm\b|support engineer|solutions engineer|implementation|onboarding specialist|technical account|customer experience)/i,
  operations: /(\boperations\b|\bops\b|program manager|project manager|chief of staff|business operations|bizops|revops|people operations|supply chain|logistics|strategy & ops)/i,
  finance: /(\bfinance\b|accounting|accountant|controller|\bfp&a\b|financial analyst|treasury|bookkeep|payroll)/i,
  people: /(recruit(er|ing)?|\btalent\b|\bhr\b|human resources|people partner|people ops|sourcer|talent acquisition)/i,
  legal: /(\blegal\b|counsel|attorney|paralegal|\bcompliance\b|privacy counsel|contracts manager)/i,
};

const JUNIOR = /(\bintern\b|internship|\bjunior\b|\bjr\.?\b|\bentry\b|new ?grad|graduate program|apprentice|early career|working student|trainee)/i;
const EXEC = /(\bvp\b|vice president|\bsvp\b|\bevp\b|\bchief\b|\bceo\b|\bcto\b|\bcfo\b|\bcoo\b|\bcpo\b|\bcmo\b|\bhead of\b)/i;
const SENIOR_USER = /(senior|staff|principal|\blead\b|\bhead\b|director|founding|sr\.?\b|10\+ years|8\+ years|7\+ years|6\+ years)/i;
const ONSITE = /(on-?site|in-office|in office|onsite only)/i;

// Company-context reach signal (derived from the whole pool, once per run). A bare "Remote" role is
// only trustworthy as globally reachable if the company actually hires in the candidate's region.
// A company with at least one India-located posting hires in India, so its "Remote" is plausibly
// India-open; a company with ZERO India postings almost certainly means US-remote. tagCompanyReach
// sets job.companyHiresIndia on every job — consumed by reachableForRegion's bare-remote branch.
const INDIA_LOC = /\b(india|bengaluru|bangalore|mumbai|delhi|hyderabad|pune|chennai|gurgaon|gurugram|noida|kolkata|ahmedabad|kochi|kerala|thiruvananthapuram|trivandrum|coimbatore|indore|jaipur)\b/i;
export function tagCompanyReach(jobs) {
  const indiaCos = new Set();
  for (const j of jobs || []) if (INDIA_LOC.test(`${j.location || ""} ${j.region || ""}`)) indiaCos.add(j.company || "?");
  for (const j of jobs || []) j.companyHiresIndia = indiaCos.has(j.company || "?");
  return indiaCos.size;
}

const lc = (v) => String(v ?? "").toLowerCase();
const matchFamilies = (text) => {
  const out = new Set();
  for (const [fam, re] of Object.entries(FAMILIES)) if (re.test(text)) out.add(fam);
  return out;
};
// exposed for observability/tests: the role families a title matches (may be empty/multiple)
export const jobFamilies = (title) => [...matchFamilies(title || "")];

// ── deterministic relevance signals (for RANKING within the family-passing set) ──────────────
// Pure text overlap, no model, no embeddings. These feed the pre-filter's SORT so that when a
// person has more family-passing roles than the cap, the roles that reach the matcher are the ones
// most RELEVANT to them (target-title + their grounded strengths), not merely the freshest. This
// only orders survivors; it never adds or drops one (that stays the filter's job).
const STOP = new Set([
  "the", "and", "for", "with", "you", "your", "our", "are", "that", "this", "will", "team",
  "role", "job", "who", "how", "what", "from", "have", "has", "not", "all", "can", "per",
  "of", "to", "in", "on", "at", "is", "as", "or", "be", "we", "it", "by", "an", "so", "do",
  "up", "no", "if", "my", "me", "us", "resume", "words", "their", "own", "etc", "via", "new",
]);
// Tokenize free text to meaningful lowercase tokens (keeps short signal tokens like ai/ux/ml/pm).
function toTokens(s) {
  return (String(s ?? "").toLowerCase().match(/[a-z0-9+#.]+/g) || []).filter((t) => t.length >= 2 && !STOP.has(t));
}
// Coerce a dossier field that may be a string, an array of strings, or an array of {text}-ish
// objects into one plain string, so tokenization never throws on shape.
function asText(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : x?.text || x?.point || x?.label || "")).join(" ");
  return String(v ?? "");
}

// Build the deterministic signals we filter on, from the person's dossier.
export function userSignals(dossier) {
  const prefs = dossier?.preferences || {};
  // Target families come from the STATED target role only (what they want), not their
  // background — using strengths/headline over-broadens (e.g. a designer whose history
  // mentions "growth" would wrongly inherit the marketing family). Fall back to the
  // headline only when no target role is set.
  const roleText = (prefs.role && String(prefs.role).trim()) || dossier?.headline || "";
  const families = matchFamilies(roleText);
  const senioritySrc = [prefs.seniority, prefs.role, dossier?.headline].filter(Boolean).join(" ");
  const isSenior = SENIOR_USER.test(senioritySrc);
  const wantsRemote = /remote/i.test(lc(prefs.remote));
  const isExec = EXEC.test(senioritySrc);
  const dealbreakers = (Array.isArray(prefs.dealbreakers) ? prefs.dealbreakers : [])
    .map((d) => lc(d).trim())
    .filter((d) => d.length >= 4); // ignore too-short/noisy dealbreaker tokens
  // Ranking signals (used only to ORDER survivors before the cap, never to filter):
  //  - roleTokens: the person's target-title tokens, matched against a job TITLE (strongest fit cue).
  //  - terms: their grounded strengths/tech/values vocabulary, matched against title+description
  //    (this is what lets a rare true combo — e.g. "wayfinding" + "maps" — outrank a generic role).
  // Did the person TELL us their target, or did we infer it from their headline? Only the first is
  // consent; the second is Charlie's own guess about them. The retrieval gate treats them differently
  // (see retrievalMode) because a guess must never delete a person's real career.
  const targetStated = Boolean(prefs.role && String(prefs.role).trim());
  const roleTokens = [...new Set(toTokens(roleText))];
  const terms = new Set([
    ...roleTokens,
    ...toTokens(asText(dossier?.strengths)),
    ...toTokens(asText(prefs.tech)),
    ...toTokens(asText(prefs.values)),
    ...toTokens(dossier?.headline),
  ]);
  return { families, isSenior, isExec, wantsRemote, dealbreakers, roleTokens, terms, targetStated };
}

// The grounded text we embed for a person's SEMANTIC vector. Leads with their target +
// their real strengths/domains — the differentiator — so retrieval finds where their combo WINS even
// when the role shares no keywords with their resume (the case lexical relevance cannot see). Grounded
// by construction: only their stated target + resume-derived strengths, nothing invented.
//
// Edge Engine (dark behind EDGE_ENGINE): when the dossier carries a HIGH-confidence `edge`, add
// the domains where that rare combination wins (edge.strong_in) so the vector leans toward combo-winning
// roles — a maps/indoor-navigation design role can then outrank a generic same-title one, even with no shared
// resume keywords. strong_in is a grounded market judgment (verified by edge-verify), never a new fact
// about the person. Off / no edge / non-high confidence -> the blob is byte-identical to before.
export function personBlob(dossier) {
  const p = dossier?.preferences || {};
  const role = (p.role && String(p.role).trim()) || dossier?.headline || "";
  const edgeOn = String(process.env.EDGE_ENGINE || "").toLowerCase() === "on";
  const strongIn = edgeOn && dossier?.edge?.confidence === "high" ? asText(dossier.edge.strong_in) : "";
  return [role, dossier?.headline, asText(dossier?.strengths), asText(dossier?.domains), asText(p.tech), strongIn]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(". ")
    .slice(0, 4000);
}

// Deterministic relevance of ONE job to ONE person's signals. Higher = more relevant. Weighted so
// a target-title hit dominates, family overlap next, then how much of their grounded vocabulary the
// posting actually uses. Zero model calls. Used only for the pre-cap SORT.
export function relevanceScore(job, sig) {
  const titleTokens = toTokens(job.title);
  const titleSet = new Set(titleTokens);
  let titleHits = 0;
  for (const t of sig.roleTokens) if (titleSet.has(t)) titleHits++;
  let fam = 0;
  if (sig.families.size) for (const f of matchFamilies(job.title || "")) if (sig.families.has(f)) fam++;
  const blobSet = new Set([...titleTokens, ...toTokens(job.description)]);
  let kw = 0;
  for (const t of sig.terms) if (blobSet.has(t)) kw++;
  return 3 * titleHits + 2 * fam + kw;
}

// RETRIEVAL MODE — is the role-FAMILY regex a GATE or merely a RANKING signal?
//
// The FAMILIES regexes decide what a person is even ALLOWED to be shown, from words in their
// title. For a person with a clearly-stated target that maps onto one bucket this costs almost
// nothing. For a person whose target is UNKNOWN or whose career SPANS buckets it is severe: e.g. an
// enterprise-IT profile with hands-on Oracle/Salesforce and no stated target can lose most of their
// best semantic matches (their literal resume tools) before the matcher scores one.
//
//   off     (default) — the family regex GATES.
//   shadow  — compute BOTH selections, log what the gate is costing this person, return TODAY'S.
//             Zero behaviour change, zero API calls, zero cost.
//   enforce — the family regex RANKS instead of gating (relevanceScore already rewards overlap at
//             `2 * fam`), so a cross-functional role can compete on merit for a slot.
//
// What NEVER stops gating, in any mode: reachability, work authorisation, the knockout floor, and
// the person's OWN stated preferences (remote, dealbreakers, seniority sanity). Those are eligibility
// and consent, not vocabulary. The matcher bar and fit floor are untouched downstream, so a widened
// candidate set cannot lower the send bar — it only changes who gets the chance to be judged.
export function retrievalMode() {
  const m = String(process.env.RETRIEVAL_MODE || "").toLowerCase().trim();
  return m === "enforce" || m === "shadow" ? m : "off";
}

// Rule 1 in isolation: does this job's TITLE read as one of the person's target families? Used to
// tag a survivor (`inFamily`) when the gate has been demoted, so one pass can answer both "what does
// today return" and "what would widening return" without filtering the pool twice.
function passesFamily(job, sig) {
  for (const f of matchFamilies(job.title || "")) if (sig.families.has(f)) return true;
  return false;
}

// True if the job survives the person's hard rules. Loose by design (recall-first): only
// drop on a CATEGORICAL miss; anything fuzzy passes through to the matcher.
// `familyGates=false` demotes rule 1 to a ranking signal; every other rule is unchanged.
function passes(job, sig, familyGates = true) {
  const title = lc(job.title);
  const loc = lc(job.location);
  const blob = `${title} ${loc}`;

  // 1) role family — keep only jobs in the person's target family/families. If we couldn't
  //    classify the person's target at all, skip this gate (don't silently drop everything).
  if (familyGates && sig.families.size) {
    const jf = matchFamilies(job.title || "");
    let overlap = false;
    for (const f of jf) if (sig.families.has(f)) { overlap = true; break; }
    if (!overlap) return false;
  }

  // 2) seniority sanity — a senior person shouldn't get intern/new-grad; a non-exec
  //    shouldn't get VP/C-suite. Only categorical drops.
  if (sig.isSenior && JUNIOR.test(title)) return false;
  if (!sig.isExec && EXEC.test(title)) return false;

  // 3) remote — drop only a CLEAR onsite-only signal when the person wants remote.
  if (sig.wantsRemote && (job.remote === false || (ONSITE.test(blob) && !/remote/i.test(blob)))) return false;

  // 4) hard dealbreakers — drop on a clear title/location keyword hit.
  for (const d of sig.dealbreakers) if (blob.includes(d)) return false;

  return true;
}

// posted_at -> ms for ranking; unknown dates sort last (but are NOT dropped here).
const postedMs = (j) => {
  const t = Date.parse(j?.posted_at || "");
  return Number.isNaN(t) ? -Infinity : t;
};

// Select the top `limit` relevant jobs for one person. Survivors are ranked by deterministic
// RELEVANCE (target-title + family + their grounded vocabulary), then freshness as the tiebreak.
// Ranking by relevance (not freshness) matters only when survivors exceed `limit`: it ensures the
// roles that reach the matcher are the person's most-relevant ones, not merely the newest, so a
// genuinely-best role is never truncated below the cap before it can be scored.
//
// SEMANTIC blend (opt-in): when `opts.semantic` is true AND a `opts.personVec` + `opts.jobVecs`
// (Map<jobId, number[]>) are supplied, the rank blends the cosine similarity of the person vector to
// each job vector with the lexical relevance (min-max normalized, weight VOYAGE_SEM_WEIGHT, default
// 0.7 semantic). This surfaces roles whose FIT is real but whose WORDS differ from the resume — what
// lexical alone misses. Fully graceful: no opts / a job with no vector → that job ranks on lexical
// only; the whole thing off → lexical behavior, unchanged. selectForUser stays a pure sync
// function — the async work (embedding the person, loading job vectors) happens in the caller.
export function selectForUser(dossier, jobs, limit = 150, opts = {}) {
  const sig = userSignals(dossier);
  // Geo pre-filter: drop roles the person can't actually reach BEFORE matching, with the SAME
  // homeRegion + reachableForRegion the pre-send guard enforces at send. Without this, higher-fit
  // US/EU roles fill the matcher's slots, the guard drops them all at send, and a genuinely
  // reachable role (e.g. a real India posting) never surfaces — the person gets nothing. Reachable
  // = a home-region place is named, or the role is genuinely global-remote. Symmetric for any region.
  const region = homeRegion(dossier);
  // BARE-REMOTE RECOVERY (B7_REMOTE_RECOVERY). Placeless bare-remote roles dropped ONLY by the weak
  // companyHiresIndia===false fallback (basis "remote-company-unconfirmed") may be genuinely
  // global-remote. `shadow` only counts + logs them; it changes NO behavior (the role is still
  // dropped) and makes NO model call.
  //
  // `on` is RECOVERY: stop dropping that one branch here and let the role compete on merit, so the
  // send gate's Tier-2 verifier (quality-gate.mjs) can read the JD and decide. Nothing
  // is made reachable by this — it is judged LATER, by evidence about the role instead of a guess
  // about the company. Matching cost is unchanged: MAX_JOBS_PER_USER still caps the scored set, so
  // recovery changes WHICH roles fill the slots, never how many.
  const b7Mode = String(process.env.B7_REMOTE_RECOVERY || "").toLowerCase();
  const b7Shadow = b7Mode === "shadow";
  // RECOVERY REQUIRES TIER 2. Without the verifier, letting these through would hand an India user a
  // remote role that nothing ever checked — trading a wrong drop for a wrong send, which is the worse
  // of the two (a missed run is recoverable, a wrong email is not). If Tier 2 is off or in
  // shadow, recovery stays off and the drop stands, whatever this flag says.
  const b7Recover = b7Mode === "on" && tier2Mode() === "on";
  if (b7Mode === "on" && !b7Recover) {
    console.error(`[b7] RECOVERY REQUESTED BUT NOT ARMED — REMOTE_ACCESS_TIER2 is "${tier2Mode()}", not "on". Roles stay dropped: recovering them with no verifier would send unchecked remote roles.`);
  }
  // Retrieval mode (see retrievalMode above). In off/shadow the family regex still GATES what we
  // return; we simply also carry the roles it would have deleted so the cost can be measured. One
  // pass answers both questions — `inFamily` records whether rule 1 would have kept this role.
  const rMode = retrievalMode();
  // ENFORCE widens ONLY when the target was GUESSED. For people who STATED a target, demoting the
  // gate actively hurts: the vector matches adjacent vocabulary ("Founder's Office / Chief of Staff"
  // pulls "Staff Software Engineer") and outranks the role they asked for. A stated target is a
  // stated PREFERENCE, and this file treats those as consent that gates (remote, dealbreakers). The
  // gate is only wrong when it enforces a guess Charlie made from a headline.
  const familyGates = rMode !== "enforce" || sig.targetStated;
  const survivors = [];
  let unreachable = 0;
  let ineligible = 0;
  let knockedOut = 0;
  let b7Recoverable = 0;
  for (const job of jobs) {
    // Widen only rule 1, and only when we are measuring or enforcing. Every other rule in passes()
    // (seniority sanity, the person's remote preference, their dealbreakers) still gates in all modes.
    if (!passes(job, sig, rMode === "off")) continue;
    const reach = reachabilityVerdict(job, region);
    if (!reach.reachable) {
      // The one branch recovery touches: a placeless bare-remote role dropped ONLY because this COMPANY has
      // no India posting. That is a fact about the employer's other listings, not about this role.
      // Every other unreachable basis (foreign location, an explicit region bar, out-of-market) still
      // drops here and is untouched by the flag.
      const recoverable = reach.basis === "remote-company-unconfirmed";
      if (recoverable && (b7Shadow || b7Recover)) b7Recoverable++;
      if (!(b7Recover && recoverable)) {
        unreachable++;
        continue;
      }
      // Recovered: falls through to the SAME eligibility, knockout and ranking rules as any other
      // role. It has not been declared reachable — it has been given the chance to be judged.
    }
    // Work-authorization bar: a role that looked reachable by location but demands US work auth /
    // citizenship the candidate can't have. Drop before matching (the guard also enforces this).
    if (eligibilityBlocker(job, region)) { ineligible++; continue; }
    // Knockout floor (pre-rank, cost optimization). ENFORCE-only here: in shadow the authoritative gate
    // (quality-gate) logs the would-drop; dropping in the pre-filter during shadow would change behavior.
    // Same knockouts() the gate uses — a role knocked out here would be dropped there anyway, so this only
    // saves it a matcher slot. Fail-open: an unknown seeker fact never knocks a role out.
    if (knockoutMode() === "enforce" && knockouts(job, dossier).length) { knockedOut++; continue; }
    // Relevance ranking is only trustworthy when we classified the person's target. For an
    // UNCLASSIFIED target (no family matched) we have no reliable relevance signal, so we keep the
    // status-quo freshness order (rel=0 for every survivor) rather than reorder on noise: relevance
    // ranking helps classified users and can slightly hurt an unclassified one. Fail safe: strict
    // improvement-or-no-op. An unclassified target is a dossier gap to fix upstream, not something a
    // ranker should paper over.
    const rel = sig.families.size ? relevanceScore(job, sig) : 0;
    const inFamily = !sig.families.size || passesFamily(job, sig);
    survivors.push({ job, rel, posted: postedMs(job), inFamily });
  }

  const semantic = Boolean(opts.semantic && opts.personVec && opts.jobVecs);
  // Rank one candidate set and take the top `limit`. Extracted so shadow can rank BOTH sets with
  // identical logic — the min-max normalization is relative to the set being ranked, so comparing
  // two sets means ranking each on its own terms, never reusing one set's scale for the other.
  const rankAndCut = (list) => {
    if (semantic) {
      for (const s of list) {
        const jv = opts.jobVecs.get(s.job.id);
        s.sem = jv ? cosineSim(opts.personVec, jv) : 0; // no vector for this job -> lexical-only for it
      }
      const norm = (val, arr) => { const mn = Math.min(...arr), mx = Math.max(...arr); return mx > mn ? (val - mn) / (mx - mn) : 0; };
      const rels = list.map((s) => s.rel);
      const sems = list.map((s) => s.sem);
      // 0.5, not higher: a heavier semantic weight lets semantic OVERRIDE fit, demoting a person's best
      // role out of the cap and pulling in low-fit but semantically-near roles. At 0.5 semantic
      // AUGMENTS lexical instead of dominating, and cross-functional fits still surface. Tunable via env.
      const wSem = Math.min(1, Math.max(0, Number(process.env.VOYAGE_SEM_WEIGHT || 0.5)));
      for (const s of list) s.score = wSem * norm(s.sem, sems) + (1 - wSem) * norm(s.rel, rels);
      list.sort((a, b) => b.score - a.score || b.posted - a.posted);
    } else {
      list.sort((a, b) => b.rel - a.rel || b.posted - a.posted);
    }
    return list.slice(0, limit);
  };

  // In off/shadow the RETURNED set is exactly today's: family-gated. Only enforce widens it.
  const gated = familyGates ? survivors.filter((s) => s.inFamily) : survivors;
  const chosen = rankAndCut(gated);

  // ── WHY each role ranked where it did, carried out with the role. ───────────────────────────────
  //
  // `_retrievalRank` says WHERE a role ranked; these fields say WHY. Without them a click is an
  // outcome with no attributable cause: we know role #37 was clicked and nothing about what made it
  // #37, so no amount of click data could retrain the ranker.
  //
  // Underscore-prefixed: transport only, never a posting fact, and nothing user-facing may read them.
  //
  // `_retrievalRank` is stamped HERE, at the line that actually produces the ordering, so it reaches
  // EVERY consuming path (batch and on-demand). It is the same number match-batch.mjs calls the
  // retrieval rank ("the job's index in THIS user's selectForUser output"); one name for one number.
  for (let i = 0; i < chosen.length; i++) {
    const s = chosen[i];
    s.job = {
      ...s.job,
      _relScore: s.rel,                                    // lexical: 3*titleHits + 2*family + keywords
      _semScore: semantic && typeof s.sem === "number" ? +s.sem.toFixed(4) : null, // cosine, null when off
      _blendScore: typeof s.score === "number" ? +s.score.toFixed(4) : null,       // what actually sorted
      _retrievalRank: i,                                   // position in THIS user's shortlist
    };
  }

  let widenedGain = 0;
  if (rMode === "shadow") {
    // Measure, change nothing: how many roles would enter the top `limit` if the family regex ranked
    // instead of gated? Ranked on its own scale, then compared by job id. Pure CPU, no API call, $0.
    const widenedTop = rankAndCut(survivors.slice());
    const chosenIds = new Set(chosen.map((s) => s.job.id));
    const entrants = widenedTop.filter((s) => !chosenIds.has(s.job.id));
    widenedGain = entrants.length;
    if (widenedGain > 0) {
      const sample = entrants.slice(0, 3).map((s) => `"${String(s.job.title || "").slice(0, 44)}" @ ${s.job.company}`).join(" | ");
      console.error(`[retrieval shadow] family gate costs ${widenedGain}/${limit} slot(s) (kept ${gated.length} of ${survivors.length} eligible, families=${[...sig.families].join("/") || "ANY"}) — would add: ${sample}`);
    }
  }

  if (b7Shadow && b7Recoverable > 0) {
    console.error(`[b7 shadow] ${b7Recoverable} recoverable global-remote candidate(s) dropped by the companyHiresIndia fallback (region=${region}) — WOULD route to Tier-2, changed nothing`);
  }
  return {
    jobs: chosen.map((s) => s.job),
    stats: { in: jobs.length, kept: gated.length, taken: chosen.length, families: [...sig.families], region, unreachable, ineligible, knockedOut, b7Recoverable, semantic, retrieval: rMode, widenedGain, eligible: survivors.length },
  };
}
