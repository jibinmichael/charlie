// lib/fit-screen.mjs — the fit section as a recruiter's first pass, not a keyword tally.
//
// WHY NOT A KEYWORD CHART. A resume-vs-listing chart asks "does the resume contain the word Angular".
// A recruiter's first pass filters on three things — level, domain, and whether the most recent work
// is relevant — and using a different tool is NOT a deal-breaker; same-stack is a bonus. The commonest
// rejection reason is "the resume doesn't suit the job", which is a shape judgement, not a missing
// string. A keyword chart also prints `unknown` rows ("the profile does not show it, NEVER a miss")
// under a header reading "Gap", including things nobody writes down (`Git` as a frontend engineer's
// gap). A person who reads that learns Charlie is guessing.
//
// THE LINES ARE WRITTEN, NOT DERIVED. Building them from the existing `evidence` strings produces the
// SAME SENTENCE under OPPOSITE verdicts on one screen, because `evidence` justifies a keyword row and
// carries no domain information at all. The lines come from `cov.screen`, asked for explicitly.
//
// VERDICTS STAY IN CODE. The model writes the sentence; `verdictFor` decides the chip from the
// deterministic subscore. A model that both writes the claim and grades it can drift optimistic on
// both at once, which is the failure the composite was built in code to avoid (fit-coverage.mjs).

import { reqKind } from "../fit-floor.mjs";

/** A requirement label stating a duration ("5+ years", "3-6 years"). */
const YEARS_RE = /\b(\d{1,2})\s*\+?\s*(?:-|to|–)?\s*(\d{1,2})?\s*\+?\s*year/i;

// Commodity asks: everyone has them, nobody writes them down, and printing one as a shortfall tells a
// frontend engineer `Git` is their gap.
const COMMODITY_RE = /\b(git|github|gitlab|version control|html5?|css3?|scrum|agile(\s+(delivery|ceremonies))?|jira|excel|ms office|communication|teamwork|problem[- ]solving|adaptability|english|rest|sql|relational db|linux|unix|debugging|documentation|sprint)\b/i;

/** True when a label is something a person would genuinely never list on a resume. */
export function isCommodity(label) {
  return COMMODITY_RE.test(String(label || ""));
}

/**
 * The chip beside each line, from the DETERMINISTIC subscore — never from the model's own opinion.
 *
 * `level` is special: being OVER the posting is not a warning. People engage with roles below their
 * level at least as much as with roles at it, so flagging it would argue with the reader's own choice.
 */
export function verdictFor(key, cov) {
  if (key === "level") return cov?.seniorityLevel === "under" ? "close" : "yes";
  if (key === "domain") {
    const n = Number(cov?.subscores?.domain);
    return !Number.isFinite(n) ? "close" : n >= 0.6 ? "yes" : n >= 0.35 ? "close" : "no";
  }
  // RECENT GETS NO CHIP, deliberately. There is no recency subscore, and borrowing `mustHave` (which
  // measures requirement coverage, not recency) can put "Recent work [yes]" beside a line reading "the
  // stack and domain differ from this posting". A chip whose colour argues with the sentence next to it
  // is worse than no chip. The line stands on its own until something actually measures recency.
  return null;
}

/**
 * The three-row first-pass read. [] when coverage is thin or the model wrote no usable line.
 *
 * A row with no line is DROPPED, never guessed — three rows is a maximum, not a requirement, and an
 * absent row is a far smaller failure than an invented one.
 *
 * @returns {Array<{key:string,label:string,verdict:"yes"|"close"|"no",line:string}>}
 */
export function screenRows(cov) {
  if (!cov || cov.thin !== false) return [];
  const s = cov.screen || {};
  return [
    { key: "level", label: "Level", line: s.level },
    { key: "domain", label: "Domain", line: s.domain },
    { key: "recent", label: "Recent work", line: s.recent },
  ]
    .filter((r) => typeof r.line === "string" && r.line.trim())
    .map((r) => ({ ...r, line: r.line.trim(), verdict: verdictFor(r.key, cov) }));
}

/**
 * The one thing that could stop this, or null.
 *
 * FAIL CLOSED AND SINGULAR. Only a CORE requirement that states a DURATION and that the profile does
 * not show counts. That is the shape research says genuinely disqualifies ("five years in fintech")
 * and the shape a person cannot argue with. A missing library is NEVER a dealbreaker: it is
 * learnable, and it is usually just unlisted.
 *
 * It fires rarely. Most sends get "nothing here disqualifies you" — which is the point. That sentence is a stronger, more checkable claim than a wall of partial
 * rows, and it answers the only question the reader actually has: why are you showing me this.
 */
export function dealbreaker(cov) {
  if (!cov || cov.thin !== false) return null;
  const reqs = Array.isArray(cov.coverage) ? cov.coverage : [];
  const hard = reqs.find(
    (r) => r.status === "unknown" && reqKind(r.req) === "core" && YEARS_RE.test(r.req) && !isCommodity(r.req),
  );
  return hard ? String(hard.req).replace(/\s*—\s*/g, ", ").trim() : null;
}

/**
 * What the composer needs to know about the read the person will see under its `why_you`.
 *
 * Same rows the email renders (`screenRows`), plus the seniority read, and nothing else -- no
 * composite, no subscores, no lane. The composer is being told what the reader will see, not given
 * a score to talk about.
 *
 * Returns null when there is no readout, which leaves the composer prompt without a readout section.
 */
export function screenForComposer(cov) {
  const rows = screenRows(cov);
  if (!rows.length) return null;
  return {
    rows: rows.map((r) => ({ dimension: r.label, verdict: r.verdict, the_reader_sees: r.line })),
    seniorityLevel: cov?.seniorityLevel ?? null,
  };
}
