// render-email.mjs — the SENT role email. Renders the role-email design in an email-safe way:
//   - table-based layout (no flexbox, no grid, no CSS variables)
//   - every style INLINE on the element (assume any <style> block is stripped)
//   - fonts degrade gracefully: body + labels use Avenir Next (a SYSTEM font on Apple; Windows/
//     Android fall back to Helvetica/Arial), and the Sanchez slab used for titles/subtitles is
//     EMBEDDED via @font-face below — Apple Mail renders it, Gmail strips @font-face and falls back
//     to Georgia. So it reads as the intended font on Apple and a clean serif everywhere else.
//   - small (a few KB) so Gmail never clips it (~102KB limit)
//
// One inline email is the whole product: the role, an honest fit read (a ramp with a
// loupe + a per-requirement fingerprint), the one move, the honest catch, the verified
// company, the decoded posting, what to lead with, the apply button, and the feedback loop.

// Fonts, best-on-Apple with clean fallbacks everywhere:
//   SANS  — Avenir Next is a SYSTEM font on Apple (real Avenir on Apple Mail/iOS, free); Windows/
//           Android fall to Helvetica/Arial. Body + labels.
//   SERIF — Sanchez (the brand slab) is embedded below via @font-face; Apple renders it, Gmail/
//           Outlook fall to Georgia. Headline + wordmark only.
//   MONO  — system monospace for numbers.
// esc (strips em dashes) + feedbackUrl (signed one-tap links) come from the shared kit so the
// role email stays consistent with the rest of Charlie's mail. fitLane drives the CTA ordering.
import { feedbackUrl, esc, HAND, giftRoleBlock } from "./email-kit.mjs";
import { fitLane } from "./fit-coverage.mjs";
import { screenRows, dealbreaker } from "./lib/fit-screen.mjs"; // the first-pass read + the one honest stopper
import { payLine, employmentKind } from "./lib/role-facts.mjs"; // facts the posting stated and we were discarding
import { ROLE } from "./emails/tokens.mjs"; // LOCKED design tokens
import { referralRegionAllowed } from "./quality-gate.mjs"; // one region switch, shared with the send paths

// The exact subject the Pro CTA prefills. Exported so the inbound handler matches the SAME string
// rather than a copy that can drift (one definition, not two that agree today).
export const PRO_SUBJECT = "I want in on Pro";

const SANS = ROLE.fonts.sans;
// SERIF (Sanchez) IS NOT USED IN THE ROLE EMAIL. The role title, section labels and screen row labels
// use the same Avenir stack as the body: read on a phone at small sizes with wide letter-spacing, the
// serif is harder to read than the sans. The token stays in emails/tokens.mjs because the LIFECYCLE
// templates still use it.
const MONO = ROLE.fonts.mono;

// ── palette — pure-white content on a warm canvas; warmth lives in the ink, never the paper ──
const P = ROLE.colors;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const numSpan = (t) => `<span style="font-family:${SANS};font-variant-numeric:tabular-nums;">${t}</span>`;

// human relative time from an ISO date, for the posting's actual "posted X ago". "" if unparseable.
//
// A FUTURE timestamp returns "" rather than a clamped "just now". The renderer stamps a VERIFIED
// check badge beside whatever this returns (see `roleMeta`), so clamping presented a posting with a
// bad date as freshly posted AND verified — a fact about the role that no source stated. Returning ""
// suppresses the badge with it, because `roleMeta` only renders the pair when this is truthy.
// Fail closed: saying nothing about when a role was posted costs the reader nothing;
// saying "just now" when we do not know is the one thing this product must never do.
export function relativeTime(iso) {
  const t = Date.parse(iso || ""); if (!t) return "";
  const ms = Date.now() - t;
  if (ms < 0) return ""; // dated in the future: we cannot say how long ago it was posted
  const s = ms / 1000;
  if (s < 3600) { const m = Math.round(s / 60); return m <= 1 ? "just now" : `${m} minutes ago`; }
  if (s < 86400) { const h = Math.round(s / 3600); return `${h} hour${h === 1 ? "" : "s"} ago`; }
  const d = Math.round(s / 86400); return `${d} day${d === 1 ? "" : "s"} ago`;
}

// Location resolves to a work mode ONLY when the posting states one. On-site / Remote / Hybrid are
// claims about the employer, and SILENCE IS NOT A CLAIM.
//
// Most postings carry no stated mode, so defaulting an unstated mode to "On-site" would print an
// invented fact about the employer ("London · On-site") in the line a candidate reads first.
//
// The mode vocabulary below is the set that actually occurs in the pool, not a guess: "Anywhere",
// "WFH", "Work from home", "Distributed", "Virtual", "Telecommute" and "Home-based" all mean remote,
// and a regex that knew only "remote"/"hybrid" would invert what they say.
const MODE_HYBRID = /\bhybrid\b/i;
const MODE_REMOTE = /\b(remote|wfh|work\s+from\s+home|telecommut\w*|virtual|home[\s-]?based|distributed|anywhere|world\s?wide)\b/i;
const MODE_ONSITE = /\b(on-?site|in-?office|in-?person)\b/i;
// The scanner's own hedge, not something the employer said. Treated as silence.
const REMOTE_HEDGED = /remote[\s-]*(not|un)[\s-]*(stated|specified|listed|mentioned|given|confirmed)|\bno\s+remote\b/i;
// Every mode word, stripped from the place text so the resolved mode is not printed twice.
// "the world" is matched as a PHRASE, never a bare "world": the pool holds "3 World Trade Center",
// "Bangalore RMZ-ECO WORLD" and "China World Trade Centre", which are real places.
const MODE_WORDS = /\b(on-?site|in-?office|in-?person|remote|hybrid|wfh|work\s+from\s+home|telecommut\w*|virtual|home[\s-]?based|distributed|anywhere|world\s?wide|the\s+world)\b/gi;
// Qualifiers that modify a mode word rather than name a place: "Fully remote" -> "Remote".
const MODE_QUALIFIERS = /\b(fully|100\s*%|completely|mostly|partially|entirely|permanently|truly|flexible|optional|first|friendly|based)\b/gi;

export function locationLine(raw) {
  const orig = String(raw || "").trim();
  if (!orig) return "";
  const hybrid = MODE_HYBRID.test(orig);
  const remote = !REMOTE_HEDGED.test(orig) && MODE_REMOTE.test(orig);
  // A posting offering both is offering a CHOICE; collapsing it to one deletes an option the
  // employer actually gave. It is rare, so this is one branch, not machinery.
  const mode = hybrid && remote ? "Remote or Hybrid"
    : hybrid ? "Hybrid"
    : remote ? "Remote"
    : MODE_ONSITE.test(orig) ? "On-site"
    : ""; // stated nothing -> claim nothing
  const place = orig
    .replace(/\s*\([^)]*\)\s*/g, " ")   // drop "(remote not stated)" and any parenthetical
    .replace(MODE_WORDS, " ")
    .replace(MODE_QUALIFIERS, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,·])/g, "$1")        // "Ontario Telecommuters, Canada" -> "Ontario, Canada", not "Ontario , Canada"
    .trim()
    // "Anywhere in the United States" -> "United States". Requires the literal "the" so a location
    // that merely STARTS with the state code IN (Indiana) is never eaten.
    .replace(/^(in|across|around)\s+the\s+/i, "")
    .replace(/\s+(or|and)\s*$/i, "")    // "Santa Clara, CA or Remote" -> "Santa Clara, CA"
    .replace(/^[\s,·\-/|]+|[\s,·\-/|]+$/g, "")     // trim stray separators
    .trim();
  // A lone preposition or article is what stripping a mode phrase leaves behind ("Anywhere in the
  // World" -> "in"), not a place. Matched whole-string only, so "IN, United States" is untouched.
  const hasPlace = /[a-z]/i.test(place) && !/^(in|across|around|at|from|the)$/i.test(place);
  if (hasPlace && mode) return `${place} · ${mode}`;
  return hasPlace ? place : mode; // a bare mode when no real place survives; "" when neither exists
}

// uppercase section title (darkest tier)
// SECTION HEADINGS CARRY THE HIERARCHY, NOT THE BODY. Enlarging body text turns a paragraph into a
// billboard; the separation is done by the labels instead: same size, more weight, so the eye finds the
// sections without any body text changing.
//
// 600 is the ceiling: nothing in a Charlie email goes above semi-bold (every bold tag in the templates
// is pinned to 600). The colour is already P.head #1b1710, the darkest ink in the palette at ~16:1 on
// white, so weight is the whole lever here, and it is enough.
const lbl = (t, color = P.head) =>
  `<div class="e-lbl" style="font-family:${SANS};font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${color};margin:0 0 12px;">${esc(t)}</div>`;

// verified badge — email-safe circle+check (a filled seal shape would need a hosted PNG)
// accentDEEP, not accent: this carries white type. See the note on the referral avatar below.
const badge = (sz = 14) =>
  `<span style="display:inline-block;width:${sz}px;height:${sz}px;line-height:${sz}px;text-align:center;background:${P.accentDeep};border-radius:50%;color:${ROLE.white};font-size:${Math.round(sz * 0.66)}px;font-weight:500;vertical-align:middle;margin-left:6px;">&#10003;</span>`;

// a light-bordered stat table (company + posting): each cell = uppercase label over value
function statTable(cells) {
  // columns hug their content (auto layout) so a wide value like the momentum chip never wraps.
  const tds = cells
    .map(
      (c, i) => `<td style="padding:12px 20px;vertical-align:top;white-space:nowrap;">
        <div style="font-family:${SANS};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${P.text};">${esc(c.k)}</div>
        <div style="font-family:${SANS};font-size:15px;font-weight:400;color:${P.text};margin-top:4px;">${c.v}</div>
      </td>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid ${P.line};border-radius:8px;border-collapse:separate;"><tbody><tr>${tds}</tr></tbody></table>`;
}

// fingerprint row: label | one blue bar (width% by status) | tag — monochrome; the gap reads as SHORT
// résumé-vs-listing: each of the listing's requirements gets a clear status pill (does the résumé
// cover it), not a fake-length bar. Green = have it, amber = partly, grey = not shown.
const FP = ROLE.fp;
function fpRow(label, s) {
  return `<tr>
    <td width="100%" style="font-family:${SANS};font-size:15px;line-height:1.4;color:${P.text};padding:6px 12px 6px 0;vertical-align:middle;">${esc(label)}</td>
    <td align="right" style="padding:6px 0;vertical-align:middle;white-space:nowrap;width:1%;"><span style="display:inline-block;font-family:${SANS};font-size:11px;font-weight:500;letter-spacing:.02em;color:${s.fg};background:${s.bg};border-radius:100px;padding:4px 12px;">${esc(s.tag)}</span></td>
  </tr>`;
}

// résumé-vs-listing as a diverging split: one subtle center spine (a right border carried by every
// row), "you bring" as fat green/amber rectangles reaching left, "gaps" as grey rectangles reaching
// right. Email-safe: nested %-width table cells for the bars (no inline-block, no radius, no SVG).
const RVL = ROLE.rvl;
function rvlBar(color, pct, side) {
  const spacer = Math.max(0, 100 - pct);
  const bar = `<td width="${pct}%" style="height:27px;background:${color};font-size:1px;line-height:27px;">&nbsp;</td>`;
  const gap = `<td width="${spacer}%" style="font-size:1px;line-height:27px;">&nbsp;</td>`;
  const cells = side === "have" ? `${gap}${bar}` : `${bar}${gap}`; // have hugs the spine on the right; gap hugs it on the left
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody><tr>${cells}</tr></tbody></table>`;
}
// The first-pass read: three labelled rows, each a chip plus one grounded sentence. Email-safe
// table, no bars, no keyword labels — a missing tool is never printed as a shortfall (lib/fit-screen).
//
// The chip colours are the EXISTING contextual chip tones, so this section inherits the palette's
// fill/ink contrast split rather than introducing a fourth green.
// THE FIRST-PASS READ'S HEADING. Named once, here, because presend-guard.test.mjs probes it INSIDE
// the cron chain -- the string may change, but that probe and this constant must move together or a
// run aborts on a passing email.
//
// The heading is about THIS role and THEIR record, not an abstract recruiter, and deliberately does
// NOT name the employer: "How <Company> will read you" would assert knowledge of that company's
// screening, which we do not have.
export const SCREEN_LABEL = "How this reads against your record";

// `showLines` exists because this table is SHARED by two callers with opposite needs:
//   - the live cov path: the sentence largely duplicates why_you, so only the chip renders.
//   - the frozen engine path: its whole design is "every line traces to a satisfied requirement's
//     own citation" — removing the line there would gut it. It keeps its lines.
// Default false, so a new caller gets the live behaviour rather than the archived one.
function screenTable(rows, { showLines = false } = {}) {
  const tone = { yes: ROLE.chip.pos, close: ROLE.chip.caution, no: ROLE.chip.neutral };
  const word = { yes: "Right there", close: "Close", no: "A stretch" };
  const body = rows.map((r, i) => {
    // No verdict = no chip. `recent` has nothing deterministic behind it, and a chip that argues with
    // the sentence beside it costs more trust than the blank space does (lib/fit-screen: verdictFor).
    const [bg, fg] = tone[r.verdict] || [];
    const chipHtml = r.verdict && bg
      ? `<div><span style="display:inline-block;font-family:${SANS};font-size:10.5px;font-weight:600;letter-spacing:.03em;background:${bg};color:${fg};padding:3px 8px;border-radius:3px;white-space:nowrap;">${esc(word[r.verdict])}</span></div>`
      : "";
    // THE SENTENCE IS NOT RENDERED; THE CHIP STAYS. The row sentence largely repeats why_you. The chip
    // is the only scannable verdict in the email and prose cannot replace it; the sentence can.
    //
    // `r.line` is still produced and stored on the find; it is simply not rendered here.
    return `<tr>
      <td width="104" style="vertical-align:top;padding:${i ? "10px" : "0"} 12px 0 0;font-family:${SANS};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${P.faint};line-height:1.6;">${esc(r.label)}</td>
      <td style="vertical-align:top;padding:${i ? "10px" : "0"} 0 0;">
        ${chipHtml || (showLines ? "" : `<div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${P.faint};">&mdash;</div>`)}
        ${showLines ? `<div style="font-family:${SANS};font-size:14px;line-height:1.55;color:${P.text};margin-top:${chipHtml ? "6px" : "0"};">${esc(r.line)}</div>` : ""}
      </td></tr>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody>${body}</tbody></table>`;
}

// ── THE ENGINE-AUTHORITATIVE FIRST-PASS READ ──────────────────────────────────────────────────────
// Same rows, same chips, same type, same spacing as screenTable — only the DATA changes. Every row is
// a requirement the frozen engine scored `satisfied`, printed with the citation from the person's own
// record. Nothing else can appear, so the email cannot state a deficiency the engine did not use to
// block the role, and it cannot disagree with the send decision.
//
// Summarised LEVEL / DOMAIN / RECENT rows can drift from the engine (a "Right there" chip over a
// requirement the engine scored `partial|adjacent`): two model calls, two prompts, opposite
// conclusions about one fact. Rows that ARE the engine's record cannot drift from it.
//
// DELIBERATELY NOT importing the operator module to reuse its ANCHORING set. That module is imported
// by no production module and two tests enumerate every root file to keep it that way; importing it
// here would wire the engine into the send path. The literal below is that set's only member, and it
// is duplicated on purpose. (The filename is spelled out nowhere in this file for the same reason —
// those tests scan for the string, and a comment that names it reads as an import to them.)
const ENGINE_ANCHOR = "direct";

/**
 * The strongest three satisfied requirements, using the ordering that already exists — `direct`
 * evidence anchors and everything else follows, stable within each group so stage 1's order (the
 * posting's own order) is preserved. No new score, no re-ranking.
 */
export function engineRows(engine) {
  const reqs = Array.isArray(engine?.requirements) ? engine.requirements : [];
  const satisfied = reqs.filter((r) => r && r.outcome === "satisfied" && r.gating === true && r.kind !== "constraint");
  const anchors = satisfied.filter((r) => r.evidence_strength === ENGINE_ANCHOR);
  const rest = satisfied.filter((r) => r.evidence_strength !== ENGINE_ANCHOR);
  return [...anchors, ...rest].slice(0, 3).map((r) => ({
    label: String(r.req || ""),
    line: String(r.evidence || ""),
    // A chip is a claim, so only the anchoring strength earns one. Everything else takes the blank
    // space, exactly as the `recent` row already does — a chip that overstates costs more than none.
    verdict: r.evidence_strength === ENGINE_ANCHOR ? "yes" : null,
  })).filter((r) => r.label && r.line);
}

// ── SLOT 6 MAY NEVER COACH A RELABEL ────────────────────────────────────────────────────────────
// The kind of line the composer can produce, aimed at a real hiring process:
//
//   "RENAME your <product> section to explicitly use 'multi-agent orchestration' and 'agent
//    planning', the JD's exact words"          <- the engine graded that capability partial|adjacent
//   "surface that as a SHIPPED context, NOT AN EXPLORATION"
//                                              <- the record says "explored ... concepts"
//
// Positioning is meant to REORDER and SURFACE real evidence, never to re-label it as something
// stronger (never invent, inflate, or upgrade). Advice that renames work is the same inflation as
// inventing it, with the person's own hands on the keyboard.
//
// This is a DROP filter over the composer's advice copy, not a classifier over the person's evidence:
// it decides nothing about fit, it only refuses to print a sentence. It fails closed — a tip that
// matches is dropped, the rest are kept, and the slot hides if nothing survives.
const RELABEL = [
  /\b(rename|re-?label|re-?frame|re-?word|re-?title|re-?brand|re-?position)\b/i,
  /\bnot (an|as an) (exploration|experiment|side project)\b/i,
  /\bas (a )?(shipped|production|owned|led)\b[^.]*\b(not|rather than|instead of)\b/i,
  /\b(present|describe|frame|position|pitch|call) (it|them|this|that|your \w+)\s+as\b/i,
  /\b(use|mirror|match|borrow|adopt|copy) (the )?(JD|posting|job description|their|its)[^.]{0,24}\b(exact )?(words|language|phrasing|terminology|wording)\b/i,
];
export function isRelabelAdvice(text) {
  const t = String(text || "");
  return RELABEL.some((re) => re.test(t));
}

// The DECLARATIVE form of the same defect:
//
//   "Lead with <product>'s AI engine: a planner model, nine wrapped APIs, and automatic retry
//    loops. THAT IS multi-agent orchestration and tool-calling."
//
// when the engine graded that requirement `partial|adjacent` on exactly this evidence. The line does
// not tell anyone to rename anything; it simply asserts the thing the engine declined to.
//
// Tailoring may reorder and reframe REAL facts, so using the employer's vocabulary for work the engine
// certified is fine. Asserting an UNMET requirement is demonstrated is not. So the check is
// engine-aware rather than a prose classifier — it needs the engine's own unmet list to fire at all.
const COPULA = /\b(that|this|these|those|which|it|they)\s+(is|are|was|were)\b|\bis exactly\b|\bare exactly\b|\bamounts? to\b|\bcounts? as\b|\bqualifies as\b/i;
export function assertsUnmet(text, unmetLabels) {
  const t = String(text || "");
  if (!COPULA.test(t)) return false;
  return (unmetLabels || []).some((label) => {
    const head = String(label || "").split(/\s+or\s+/)[0].trim();       // "FastAPI or Flask" -> "FastAPI"
    if (head.length < 4) return false;
    return new RegExp(`\\b${head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t);
  });
}

function resumeVsListing(coverage) {
  const nm = (t, side) => `<td style="font-family:${SANS};font-size:14.5px;line-height:1.25;color:${side === "have" ? P.text : RVL.gapInk};text-align:${side === "have" ? "right" : "left"};padding:${side === "have" ? "7px 14px 7px 0" : "7px 0 7px 14px"};">${esc(t)}</td>`;
  const header = `<tr><td></td>`
    + `<td style="border-right:${RVL.spine};text-align:right;padding:0 12px 15px 0;font-family:${SANS};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${RVL.haveInk};">You bring</td>`
    + `<td style="text-align:left;padding:0 0 15px 12px;font-family:${SANS};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${RVL.gapInk};">Gap</td>`
    + `<td></td></tr>`;
  const rows = (Array.isArray(coverage) ? coverage : []).slice(0, 6).map((r) => {
    if (r.status === "unknown") {
      return `<tr><td></td>`
        + `<td style="border-right:${RVL.spine};font-size:1px;line-height:27px;">&nbsp;</td>`
        + `<td style="padding:7px 0 7px 0;vertical-align:middle;">${rvlBar(RVL.grey, 96, "gap")}</td>`
        + `${nm(r.req, "gap")}</tr>`;
    }
    const partial = r.status === "partial";
    return `<tr>${nm(r.req, "have")}`
      + `<td style="border-right:${RVL.spine};padding:7px 0 7px 0;vertical-align:middle;">${rvlBar(partial ? RVL.amber : RVL.green, partial ? 52 : 96, "have")}</td>`
      + `<td></td><td></td></tr>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed;"><colgroup><col style="width:30%"><col style="width:19%"><col style="width:19%"><col style="width:32%"></colgroup><tbody>${header}${rows}</tbody></table>`;
}

// note block (mid-tier sub-heading + prose), optional top divider so notes read as sections
const noteRow = (title, html) =>
  `<tr><td>
    <div style="background:${ROLE.box.catch};border-radius:4px;padding:16px 18px;">
      <div style="font-family:${SANS};font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${P.head};margin:0 0 8px;">${esc(title)}</div>
      <div class="e-body" style="font-family:${SANS};font-size:14.5px;line-height:1.5;color:${P.text};">${html}</div>
    </div>
  </td></tr>`;

// segmented fit ramp (light -> saturated), email-safe as stepped <td> cells
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const hx = (n) => n.toString(16).padStart(2, "0");
function rampCells(n = 22) {
  const A = [253, 228, 228], B = [247, 88, 88]; // #FDE4E4 -> #F75858
  let out = "";
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const col = `#${hx(lerp(A[0], B[0], t))}${hx(lerp(A[1], B[1], t))}${hx(lerp(A[2], B[2], t))}`;
    out += `<td width="${(100 / n).toFixed(3)}%" style="background:${col};height:26px;font-size:1px;line-height:26px;${i ? `border-left:2px solid ${P.paper};` : ""}">&nbsp;</td>`;
  }
  return out;
}
// the ramp's exact colour at a given score fraction (0..1) — same interpolation as the cells
function rampColorAt(frac) {
  const A = [253, 228, 228], B = [247, 88, 88];
  const t = Math.max(0, Math.min(1, frac || 0));
  return `#${hx(lerp(A[0], B[0], t))}${hx(lerp(A[1], B[1], t))}${hx(lerp(A[2], B[2], t))}`;
}
// The fit readout: THREE florettes, one to three lit in coral, the rest muted, with the tier phrase
// beside them. Email-safe cells, same table construction as the meter.
//
// WHY TIERS, NOT A 0-100 METER. `composite` is a real measurement multiplied by five chosen weights
// (fit-floor.mjs), and nothing has measured whether a 78 converts better than a 62. So the number's
// INPUTS are grounded and its PRECISION is not, which would make it the one claim in the email that
// does not trace to the person's own evidence. Three tiers claim only what a coverage count can defend.
//
// Muted, never absent: all three glyphs always render, so the scale reads on the FIRST email instead
// of needing a second one to compare against.
function fitVerdict(number) { const v = Number(number) || 0; return v >= 67 ? "High" : v >= 34 ? "Medium" : "Low"; }

// Tier phrases. The top one is deliberately a claim about THEIR OWN HISTORY, not a directive about
// their life ("drop everything" tells someone what to do with a job we know nothing about).
const FIT_TIERS = ["worth a look", "a real fit", "the closest yet"];

/** 1..3. Clamped, so an absent or junk composite renders the bottom tier rather than throwing. */
function fitTier(number) {
  const n = Math.max(0, Math.min(100, Number(number) || 0));
  return n >= 85 ? 3 : n >= 70 ? 2 : 1;
}

function fitMeter(number) {
  const tier = fitTier(number);
  let cells = "";
  for (let i = 0; i < 3; i++) {
    const lit = i < tier;
    // Existing tokens only: the accent coral for lit, the meter palette's "unfilled" grey for
    // muted. No new value enters emails/tokens.mjs, which is locked.
    cells += `<td style="padding-right:${i < 2 ? "3" : "0"}px;font-family:${SANS};font-size:21px;line-height:24px;color:${lit ? P.accent : ROLE.fitMeter.empty};">&#10047;</td>`;
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr>${cells}
      <td style="padding-left:11px;font-family:${SANS};font-size:14px;font-weight:400;color:${ROLE.fitMeter.verdict};white-space:nowrap;vertical-align:middle;">${esc(FIT_TIERS[tier - 1])}</td>
    </tr></tbody></table>`;
}

// The pool caps each posting's description at this many chars. A JD at/over the cap was almost
// certainly cut mid-text, so a requirements table built from it could silently omit real asks —
// we fall back to prose in that case (the truncated-JD guard, enforced by presend-guard.test.mjs).
// Truncation is signalled EXPLICITLY: the coverage engine's own flag, or a JD that VISIBLY ends
// mid-text (a trailing ellipsis / [truncated] marker). Length is NOT a truncation signal — the engine
// renders from the FULL jobs.json description (the 2500 pool cap is only on the Supabase pool object
// for hosted chat), so a long-but-complete JD is not truncated. Hiding the readout on long JDs would
// be self-defeating (the pool cap is set so the requirements survive).
function jdWasTruncated(cov, jobDescription) {
  if (cov && (cov.jdTruncated === true || cov.truncated === true)) return true;
  const d = typeof jobDescription === "string" ? jobDescription : "";
  if (!d) return false;
  if (/(\.\.\.|…|\[truncated\]|\[cut\]|\[…\])\s*$/.test(d)) return true;
  return false;
}

// ── email-trust telemetry — the single source of truth for the two gated sections ──
// The renderer uses these for the actual gate; the send paths (scheduler, first-role) call them to
// LOG a per-send reason. The "shown" branch MUST stay identical to the render gate — the email
// snapshot tests are the guard against drift.
export function readoutStatus(cov, jobDescription) {
  if (jdWasTruncated(cov, jobDescription)) return "hidden:jd_truncated";
  if (!cov || cov.thin !== false) return "hidden:cov_thin";
  if (!(Array.isArray(cov.coverage) && cov.coverage.length)) return "hidden:no_coverage";
  return "shown";
}
export function referralStatus(region, referral) {
  if (!referralRegionAllowed(region)) return "hidden:region";
  if (!(referral && referral.name)) return "hidden:no_contact";
  return "shown";
}

// find a labelled fact (e.g. location) in the composer's facts array, without inventing one
function findFactObj(facts, re) {
  return Array.isArray(facts) ? facts.find((f) => f && re.test(String(f.k || ""))) || null : null;
}

// email-safe comp bar: stepped <td> cells across a wage scale; the listed range fills accent,
// the market (BLS) median is a dark tick. No absolute positioning (Gmail/Outlook safe).
function payBar({ sLo, sHi, lo, hi, median }) {
  const n = 24, cellW = (sHi - sLo) / n;
  let cells = "";
  for (let i = 0; i < n; i++) {
    const cLo = sLo + i * cellW, cHi = cLo + cellW;
    const inRange = lo != null && hi != null && cHi > lo && cLo < hi;
    const isMed = median != null && median >= cLo && median < cHi;
    const bg = inRange ? P.accent : P.track;
    cells += `<td width="${(100 / n).toFixed(3)}%" style="background:${bg};height:10px;font-size:1px;line-height:10px;${isMed ? `border-top:3px solid ${P.head};border-bottom:3px solid ${P.head};` : ""}${i ? `border-left:1px solid ${P.paper};` : ""}">&nbsp;</td>`;
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:4px;"><tbody><tr>${cells}</tr></tbody></table>`;
}

// momentum trend: an email-safe area/line chart of the open-req count over recent weeks, on a
// subtle background. Interpolated thin cells (a true SVG line is stripped by Gmail). History-gated.
function areaChart(vals) {
  const nums = (vals || []).map((v) => Number(v) || 0);
  if (nums.length < 2) return "";
  const mx = Math.max(...nums), mn = Math.min(...nums), rng = mx - mn || 1, N = 28, H = 46;
  let cells = "";
  for (let i = 0; i < N; i++) {
    const t = (i / (N - 1)) * (nums.length - 1), lo = Math.floor(t), f = t - lo;
    const v = nums[lo] + ((nums[lo + 1] ?? nums[lo]) - nums[lo]) * f;
    const h = Math.max(3, Math.round(((v - mn) / rng) * (H - 8)) + 6);
    cells += `<td style="vertical-align:bottom;"><div style="height:${h}px;background:${P.accent};font-size:1px;line-height:1px;">&nbsp;</div></td>`;
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${P.chipBg};border-radius:8px;"><tbody><tr><td style="padding:7px 9px;"><table role="presentation" width="100%" height="${H}" cellpadding="0" cellspacing="0" border="0"><tbody><tr>${cells}</tr></tbody></table></td></tr></tbody></table>`;
}

export function renderEmail({ fields, match = {}, cov = null, engine = null, askLine = null, weave = null, label = null, applyUrl, via, viaUrl, unsubUrl, email, findId, jobDescription, region = null, pay = null, momentum = null, postedAt = null, referral = null, edgeFrame = null, jobLocation = null, proAsked = false, rawCompensation = null, employmentType = null } = {}) {
  const f = fields || {};
  const isUS = region === "us"; // US-only enrichment gate (pay / momentum / reviews / warm intro)

  const roleTitle = f.role_title || f.subject || "a role worth a look";
  // "About <Company>" beats "The company": naming them is a FACT we already print elsewhere in the
  // email, not a claim about them. Falls back when the composer returned no company.
  const companyName = String(f.company || "").trim();
  const company = f.company || "";
  const facts = Array.isArray(f.facts) ? f.facts : [];
  // THE LOCATION COMES FROM THE POSTING, NOT FROM THE MODEL'S SENTENCE ABOUT IT.
  //
  // locationLine is faithful to its INPUT, so reading the composer's `facts` row would print whatever
  // mode the model wrote into it (e.g. "Bengaluru (onsite; remote not stated)" for a posting whose
  // record says location "Bengaluru", remote null). composer.md forbids that, but citeOrDrop covers
  // claims about the PERSON, not about the JOB, so nothing would enforce it. Reading `job.location`
  // directly removes the whole class: a mode can only be printed if the employer's own location
  // string says one.
  //
  // The fact row remains the fallback ONLY for callers with no job record to hand (run-charlie.mjs and
  // owner-only debug tools), which never send to a user.
  const locFact = findFactObj(facts, /location|based|city|where|office/i);
  const locSource = jobLocation != null && String(jobLocation).trim()
    ? String(jobLocation).trim()
    : (locFact ? String(locFact.v || "").trim() : "");
  const location = locationLine(locSource);
  // the meta line directly under the job title: company · location · actual posted-time (verified) · team
  const teamFact = findFactObj(facts, /team|department|group|division/i);
  const team = teamFact ? String(teamFact.v || "").trim() : "";
  const postedRel = relativeTime(postedAt);
  const whereBits = [
    company ? esc(company) : "",
    location ? esc(location) : "",
    team ? esc(team) : "",
  ].filter(Boolean);

  // ── the honest fit Readout (only with a real, untruncated JD) ──
  const hasReadout = readoutStatus(cov, jobDescription) === "shown"; // single source of truth (identical boolean)
  // ADDITIVE AND BACKWARD-SAFE: absent `engine` leaves every branch below exactly as it was, which is
  // what most callers do. It only takes over when a caller hands over a decision
  // record that actually has satisfied requirements to show.
  const engineOn = !!engine && engineRows(engine).length > 0;
  const lane = hasReadout ? fitLane(cov) : "apply";
  const composite = hasReadout ? clamp(Number(cov.composite) || 0, 4, 100) : null;

  // header — an optional label badge sits above the eyebrow. Soft pill, same idiom as the market-signal
  // chip below. LABEL CHIP THEME:
  //   default  (coral accent, white text) — "Today's pick" / "Fresh pick" / "Closest to your profile"
  //   Rare find (distinct plum, white text) — a rare-combo match; a different bg so it reads as special
  // The color is the ONLY difference between variants; size/shape/text stay identical.
  const chip = (text, bg, color) => `<span style="display:inline-block;font-family:${SANS};font-size:11px;font-weight:400;color:${color};background:${bg};border-radius:100px;padding:4px 12px;white-space:nowrap;">${text}</span>`;
  // contextual chip: tone carries the meaning (good=green, neutral=grey, caution=amber).
  const TONE = ROLE.chip;
  const toneChip = (text, tone) => { const [bg, fg] = TONE[tone] || TONE.neutral; return chip(text, bg, fg); };
  // Label chip theme comes from the locked palette (ROLE.labels): "Rare find" gets its own bg; every
  // other label uses the default. No chip color is ever hardcoded here.
  const labelTheme = label === "Rare find" ? ROLE.labels.rareFind : ROLE.labels.default;
  // Pay chip (US-only): a slightly larger chip that rides on the posted-time line below "About the
  // Role". The number is the grounded fact; the verdict is coloured by where the range midpoint sits
  // vs the BLS occupational median.
  let payChipSpan = "";
  if (isUS && pay && pay.lo != null && pay.hi != null) {
    const cur = pay.currency === "USD" || !pay.currency ? "$" : `${esc(pay.currency)} `;
    const k = (n) => `${cur}${Math.round(n / 1000)}k`;
    const bls = pay.bls && pay.bls.median != null ? pay.bls : null;
    const mid = (pay.lo + pay.hi) / 2;
    const verdict = bls ? (mid >= bls.median * 1.1 ? "above avg" : mid <= bls.median * 0.9 ? "below avg" : "at market") : null;
    const tone = !bls ? "neutral" : mid >= bls.median * 1.1 ? "pos" : mid <= bls.median * 0.9 ? "caution" : "neutral";
    const [pbg, pfg] = TONE[tone] || TONE.neutral;
    payChipSpan = `<span style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:500;color:${pfg};background:${pbg};border-radius:100px;padding:6px 14px;vertical-align:middle;">${numSpan(`${k(pay.lo)}&ndash;${k(pay.hi)}`)}${verdict ? ` &middot; ${verdict}` : ""}</span>`;
  }
  // When a badge is present it OWNS the eyebrow slot (no stacked "Today · one role" beneath it, which
  // would double up two uppercase micro-labels); without a badge the classic eyebrow shows.
  const labelChip = label ? `<div style="margin:0 0 12px;">${chip(esc(label), labelTheme.bg, labelTheme.fg)}</div>` : "";
  const eyebrow = ""; // no "Today · one role" eyebrow — the badge owns that slot
  const headerGrp = `
    ${labelChip}
    ${eyebrow}
    <div class="e-role" style="font-family:${SANS};font-size:29px;font-weight:500;line-height:1.2;letter-spacing:-.01em;color:${P.head};">${esc(roleTitle)}</div>
    ${whereBits.length ? `<div class="e-where" style="font-family:${SANS};font-size:15px;line-height:1.5;color:${P.text};margin-top:12px;">${whereBits.join(` <span style="color:${P.faint};">&middot;</span> `)}</div>` : ""}`;

  // fit section — florettes + the first-pass read, OR prose fallback (why_you)
  let fitGrp = "";
  if (hasReadout) {
    // SLOT 3 IS REMOVED WHEN THE ENGINE DECIDES, RATHER THAN RESCORED.
    //
    // The three florettes are three TIERS off `cov.composite`. The frozen engine has one send verdict
    // (`strong-fit`) and computes no composite, so a three-tier scale cannot be honestly represented
    // by it. Mapping one verdict onto three glyphs would be inventing a score. The label and the
    // disqualification line below carry the whole meaning.
    // THE FIT METER IS NOT SHOWN IN THE USER-FACING EMAIL, unconditionally and independent of
    // ROLE_ASK: the score is not shown to anyone. Nothing replaces it — no tier, no percentage, no new
    // score. The slot closes up and the reasoning below carries the meaning.
    //
    // `fitMeter` and `composite` are retained but unreferenced by the send path: the meter is still
    // exercised by tests, and `composite` still drives `fitLane` for CTA ordering.
    //
    // THE "Why you" HEADING ONLY EXISTS IF SOMETHING SITS UNDER IT. `why_you` is nulled by
    // grounding-enforce's dropProse() whenever a claim in it cannot be cited, and on a role with no
    // dealbreaker either, the label would orphan. An empty heading reads as a broken email and
    // advertises that Charlie had a reason and lost it, so the label is emitted by the same condition
    // that emits its content.
    const rationale = String(f.why_you || "").trim();
    // WHY YOU AND THE READ ARE NOT RENDERED IN THE EMAIL. THE LOGIC BEHIND THEM STILL RUNS:
    //   - why_you is composed, passed through verifyGrounding, nulled by citeOrDrop when a claim
    //     cannot be cited, and persisted on the find. It is either grounded prose or absent.
    //   - cov is computed, gates send-vs-digest at the fit floor, drives fitLane for CTA ordering,
    //     and is persisted as `_cov`.
    //   - why_you is the email's preheader when there is no coverage reason.
    // Only the two blocks of ink are absent; every decision they inform is unchanged.
    // The dealbreaker line answers the ONLY question the reader has: why are you showing me this.
    // A real dealbreaker exists on a small fraction of sends. It is stated ONCE, in code, from
    // `dealbreaker()` — never model prose.
    //
    // WITH THE ENGINE, THE CONTRADICTION COUNT DECIDES THIS LINE, NOT `cov`. "Nothing here
    // disqualifies you" is a claim, and it must never appear over a record the engine found something
    // incompatible in. The engine's contradictions ARE that check, so they are read directly; a
    // contradiction is a drop, so this branch should be unreachable on a sent role — it is here
    // because a wrong email in a real inbox is unrecoverable, not because it is expected.
    const engContra = engineOn ? (Array.isArray(engine.contradictions) ? engine.contradictions : []) : null;
    const db = engineOn ? (engContra.length ? String(engContra[0]?.req || "something it states") : null) : dealbreaker(cov);
    // ONLY THE REAL WARNING RENDERS. "One thing could stop this. They ask for X…" is Charlie naming the
    // one thing that could sink the application. The vacuous "Nothing here disqualifies you." would
    // cover almost every send, a true sentence answering a question nobody asked, so it is never
    // rendered. The line appears exactly when `db` is real.
    if (db) {
      fitGrp += `
      <div style="font-family:${SANS};font-size:15px;line-height:1.55;color:${P.text};margin-top:14px;"><span style="color:${P.head};font-weight:500;">One thing could stop this.</span> They ask for ${esc(db)}, and your profile does not show it. Everything else lines up.</div>`;
    }
    // It now sits UNDER the rationale rather than standing in for it: the reason comes first, the
    // honest check second. When a real dealbreaker exists it keeps its full weight and its own line —
    // that one must never be demoted to a footnote.

    // The first-pass read (its heading marker is what presend-guard.test probes — the probe proves the
    // readout renders on a full JD and is SUPPRESSED on a truncated one, so the string may change but
    // that pair of assertions must not).
    // SLOT 5 IS THE ENGINE'S RECORD WHEN THE ENGINE DECIDES. Same rows, same chips, same type — only
    // the data changes. `screenRows(cov)` stays for every caller that passes no engine.
    // The rows are computed (and stored on the find via `_cov`) but not rendered. `__FINGERPRINT__`
    // stays as the split marker so the group plumbing below is unchanged.
    const rows = engineOn ? engineRows(engine) : screenRows(cov);
    void rows;
  } else {
    // No-Readout fallback: also empty, so the rule is the same for everybody: a person with a full
    // requirements read and a person with a thin JD both see no rationale block. The matcher score is
    // never printed here.
    fitGrp = "";
  }
  const [fitTop, fingerprint = ""] = fitGrp.split("__FINGERPRINT__");

  // The grounded market weave (skill-unlock): a literal count over the user's matched roles,
  // highlighted so the eye lands on it. Only the count phrase is highlighted, kept short so it
  // stays on one line in email clients. weave is null when the signal is thin (nothing forced).
  const hl = (txt) => `<span style="background:${ROLE.hl.bg};color:${ROLE.hl.ink};padding:1.5px 6px;border-radius:5px;font-weight:400;">${txt}</span>`;
  // A small "Market signal" chip labels the ML finding — it's a taste of the VIP Club's market
  // insights, so it reads as a perk, not a throwaway line. (Named to not clash with the "Exclusive
  // find" label badge, which marks the Club fast-lane email itself.)
  const weaveChip = chip("&#10022;&nbsp; Market signal", P.chipBg, P.accentDeep);
  const weaveText = weave && weave.skill && weave.n && weave.total
    ? `Of what your resume doesn&rsquo;t fully show, ${esc(weave.skill)} is the most in-demand: ${hl(`${esc(String(weave.n))} of the ${esc(String(weave.total))} roles you match`)} ask for it.`
    : "";
  const weaveBlock = weaveText ? `<div style="margin-top:16px;">${weaveChip}<div style="margin-top:8px;">${weaveText}</div></div>` : "";

  // The `flag` text is not rendered as an honest-catch sticker. Gaps are gated out UPSTREAM
  // (quality-gate's seniority-gap stop + the matcher's disqualifying-gap score cap), so a role that is
  // actually sent has no disqualifying gap to confess. `f.flag` still drives matcher routing.
  // The `notes` plumbing stays inert so a future grounded note can return without new scaffolding.
  const notes = [];
  const notesGrp = notes.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody>${notes.map((n, i) => noteRow(n[0], n[1], i > 0)).join("")}</tbody></table>`
    : "";

  // verified company (only when we actually looked it up)
  const ci = f.company_insight || null;
  // keep stat values short: drop any multi-clause history (before ";" / "(") so a value stays a glance.
  const shortStat = (v) => esc(String(v).split(";")[0].split("(")[0].trim());
  // Hiring momentum (US-only): a contextual chip that sits INSIDE the Team column, below the headcount —
  // "N open roles · up X%", coloured by direction (up=green, down=amber, flat=grey).
  let momentumChip = "";
  if (isUS && momentum && momentum.openNow > 0) {
    const ma = momentum.monthAgo;
    const pct = ma != null && ma > 0 ? Math.round(((momentum.openNow - ma) / ma) * 100) : null;
    let chipText, tone;
    if (pct != null) { chipText = `${momentum.openNow} open roles &middot; ${pct >= 0 ? `up ${pct}%` : `down ${Math.abs(pct)}%`}`; tone = pct >= 0 ? "pos" : "caution"; }
    else if (momentum.opened30d > 0) { chipText = `${momentum.openNow} open roles &middot; hiring`; tone = "pos"; }
    else { chipText = `${momentum.openNow} open roles`; tone = "neutral"; }
    momentumChip = toneChip(chipText, tone);
  }
  const coStats = ci ? [
    ci.stage ? { k: "Stage", v: shortStat(ci.stage) } : null,
    ci.raised ? { k: "Raised", v: shortStat(ci.raised), mono: 1 } : null,
    ci.size ? { k: "Team", v: `${shortStat(ci.size)}${momentumChip ? `<div style="margin-top:8px;">${momentumChip}</div>` : ""}`, mono: 1 } : null,
  ].filter(Boolean) : [];
  const companyGrp = ci ? `
      ${lbl(companyName ? `About ${companyName}` : "The company")}
      <div style="font-family:${SANS};font-size:19px;font-weight:500;color:${P.head};margin:0 0 8px;">${esc(ci.name || company)}${badge(14)}</div>
      ${ci.what ? `<div style="font-family:${SANS};font-size:14.5px;line-height:1.5;color:${P.text};margin:0 0 16px;">${esc(ci.what)}</div>` : ""}
      ${coStats.length ? statTable(coStats) : ""}
      ${isUS && (ci.name || company) ? `<div style="margin-top:16px;font-family:${SANS};font-size:13.5px;color:${P.text};"><a href="https://www.glassdoor.com/Search/results.htm?keyword=${encodeURIComponent(ci.name || company)}" style="color:${P.text};text-decoration:underline;text-underline-offset:2.5px;text-decoration-color:${P.faint};">See employee reviews on Glassdoor &rarr;</a></div>` : ""}` : "";

  // from the posting — the facts table (matches the company table styling); skip the location
  // fact already shown in the header so it isn't repeated
  // "From the posting" lives in the meta line under the job title (see whereBits above).
  // No tailored resume or cover letter is attached: the value is the grounded match and the
  // how-to-position read, not a commodity document.

  // ── actions: Apply (tracked) + optional warm intro; remind + track as underlined links ──
  const href = applyUrl || f.apply_url || "#";
  const applyHref = email && findId && href !== "#" ? feedbackUrl(email, findId, "apply_click", href) : href;
  const roleLine = company ? `${roleTitle} @ ${company}` : roleTitle;
  // The warm intro lives in the "One person to ask" box (referral), so the CTA is just Apply.
  const applyBtn = `<a href="${esc(applyHref)}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:15px;font-weight:400;color:${P.paper};background:${P.head};text-decoration:none;padding:14px 30px;border-radius:7px;">Apply${company ? ` at ${esc(company)}` : ""} &rarr;</a>`;
  const ctaCells = `<td>${applyBtn}</td>`;

  let secondary = "";
  if (email && findId) {
    // One quiet secondary action: update your profile. Email is the only surface, so it opens a draft
    // to start@. An existing user's mail there falls through /inbound to applyEmailChange, which folds
    // the note into their profile grounded and additively (it never rebuilds).
    const startAddr = process.env.CHARLIE_START_ADDR || "start@mail.example.com";
    const profileUrl = `mailto:${startAddr}?subject=${encodeURIComponent("Update my preferences")}`;
    const link = (h, t) => `<a href="${esc(h)}" target="_blank" style="color:${P.text};text-decoration:underline;text-underline-offset:2.5px;text-decoration-color:${P.faint};">${t}</a>`;
    secondary = `<div style="margin-top:16px;font-family:${SANS};font-size:13.5px;color:${P.text};">${link(profileUrl, "Update my profile")}</div>`;
  }

  const feedback = email && findId
    ? `<div style="text-align:center;margin-top:32px;">
        <div style="font-family:${SANS};font-size:12px;color:${P.faint};margin:0 0 12px;">Was this a good match for you?</div>
        <a href="${esc(feedbackUrl(email, findId, "worth"))}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:400;color:${P.text};text-decoration:none;border:1px solid ${P.line};border-radius:100px;padding:8px 16px;margin:0 4px;">&#8593;&nbsp; Worth my time</a>
        <a href="${esc(feedbackUrl(email, findId, "not"))}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:400;color:${P.text};text-decoration:none;border:1px solid ${P.line};border-radius:100px;padding:8px 16px;margin:0 4px;">&#8595;&nbsp; Not for me</a>
      </div>`
    : "";

  // Pay rides as a grounded chip in the header meta line (see whereBits.push above), so there is
  // no standalone pay block.
  const payGrp = "";


  // ── assemble: a group is a padded row; padding alone separates groups (no divider lines) ──
  const grp = (inner, first) => inner ? `<tr><td class="gp" style="padding:${first ? "24px" : "20px"} 40px 20px;">${inner}</td></tr>` : "";
  // the role, in short — a grounded 3-4 sentence JD summary, shown first (all users)
  const jobSummary = typeof f.job_summary === "string" ? f.job_summary.trim() : "";
  // Posted-time (verified) + the pay chip ride together on one line below the About-the-Role summary.
  //
  // TWO FACTS THE POSTING STATES. Both are deterministic reads of the raw posting, both render ONLY when
  // the posting actually says so, and neither costs anything.
  //
  //  · statedPay — the pay the posting itself prints. NOT `payChipSpan`, which is `computePay`'s
  //    BLS-anchored US-only verdict chip and a different thing entirely. India-reachable roles state a
  //    real figure far more often than US ones, so this is not US-gated. Suppressed when the BLS chip
  //    already rendered, so the line never carries two pay figures arguing with each other.
  //  · workKind — contract / part-time / internship. Full-time is the assumption and is deliberately
  //    NOT printed: the vast majority of roles stating a type say full-time, so printing it is noise.
  //    Only a departure is information, and one a person should never discover on the application form.
  const stated = payChipSpan ? null : payLine(rawCompensation);
  const statedPay = stated ? `<span style="font-weight:500;color:${P.head};">${esc(stated.text)}</span>` : "";
  const kind = employmentKind(employmentType);
  const workKind = kind ? chip(esc(kind), ...(kind === "Contract" || kind === "Temporary" || kind === "Freelance" ? ROLE.chip.caution : ROLE.chip.neutral)) : "";
  const roleMeta = [postedRel ? `${esc(postedRel)}${badge(11)}` : "", payChipSpan, statedPay, workKind].filter(Boolean)
    .join(` <span style="color:${P.faint};">&middot;</span> `);
  const summaryGrp = jobSummary ? `${lbl("The job")}<div class="e-body" style="font-family:${SANS};font-size:15px;line-height:1.5;color:${P.text};">${esc(jobSummary)}</div>${roleMeta ? `<div style="margin-top:16px;font-family:${SANS};font-size:15px;line-height:1.5;color:${P.text};">${roleMeta}</div>` : ""}` : "";

  // The drafted intro message ships as an ATTACHMENT only (when a referral resolved). It is NEVER
  // named in the email body — no "Attached: intro message." footnote.

  // How to position you (all users): the single move + the bullets, in a light box. Hidden if empty.
  // Slot 6 may surface real evidence in the employer's words; it may not claim an unmet requirement.
  const unmetLabels = engineOn
    ? (engine.requirements || []).filter((q) => q.gating === true && q.kind !== "constraint" && q.outcome !== "satisfied").map((q) => q.req)
    : [];
  const unsafeAdvice = (t) => isRelabelAdvice(t) || assertsUnmet(t, unmetLabels);
  const rawLead = hasReadout && cov.topMove ? String(cov.topMove).trim() : "";
  const posLead = unsafeAdvice(rawLead) ? "" : rawLead;
  // "Show me how to position for this role" — the click IS the measurement. It says, per role and per
  // person, that positioning help was wanted, which is a thing we have never been able to observe.
  // Behind POSITION_ASK so the loop can be armed after the section itself is proven.
  // Needs a findId: without one the click cannot be tied to a role and the reply would be unanswerable.
  const positionAskHref = process.env.POSITION_ASK === "on" && email && findId ? feedbackUrl(email, findId, "position_ask") : "";
  // CAPPED AT 3. A cap is only half of it: short bullets read fine and two-sentence ones do not, which
  // is why composer.md holds each to one sentence of at most 18 words. Three is the ceiling, not the target.
  //
  // THE BULLETS MOVE BEHIND THE CLICK when the link is live. If they rendered in both the role email
  // and the positioning email, tapping "show me how to position" would deliver nothing the reader had
  // not already scrolled past, which makes the link a lie and the click worthless as a measurement.
  //
  // So exactly one surface carries the detail. The role email is skimmed: it gets the single move and
  // an offer. The email that arrives BECAUSE someone asked gets the rest.
  const allBullets = (Array.isArray(f.resume_tips) ? f.resume_tips : []).map((t) => String(t || "").replace(/^\s*(lead with|highlight|emphasi[sz]e|start with|open with|focus on)\s+/i, "").trim()).filter(Boolean).filter((t) => !unsafeAdvice(t)).slice(0, 3);
  const posBullets = positionAskHref ? [] : allBullets;
  // THE HEADING SITS OUTSIDE THE BOX, so this section is labelled the same way every other section is
  // — `lbl()`, which carries the standard 12px gap beneath it — and the box holds only the advice.
  // The box fill is an existing near-neutral palette token; no new hex enters the locked emails/tokens.mjs.
  const positioningGrp = (posLead || posBullets.length || (positionAskHref && allBullets.length)) ? `${lbl("Your angle on this one")}<div style="background:${ROLE.box.advice};border-radius:8px;padding:16px 18px;">
      ${posLead ? `<div style="font-family:${SANS};font-size:14.5px;line-height:1.5;color:${P.text};margin:0 0 ${posBullets.length ? "10px" : "0"};">${esc(posLead)}</div>` : ""}
      ${posBullets.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody>${posBullets.map((b) => `<tr><td width="16" style="vertical-align:top;padding:0 0 8px;"><div style="width:5px;height:5px;border-radius:50%;background:${P.accent};margin-top:8px;font-size:1px;line-height:1px;">&nbsp;</div></td><td style="font-family:${SANS};font-size:14.5px;line-height:1.5;color:${P.text};padding:0 0 8px;">${esc(b)}</td></tr>`).join("")}</tbody></table>` : ""}
      ${positionAskHref ? `<div style="margin-top:12px;"><a href="${esc(positionAskHref)}" target="_blank" style="font-family:${SANS};font-size:14px;font-weight:500;color:${P.accentDeep};text-decoration:none;border-bottom:1px solid ${P.accent};padding-bottom:1px;">Show me how to position for this role &rarr;</a></div>` : ""}
    </div>` : "";

  // Rare-find opening (Edge Engine): one grounded line, at the very top of the body, saying WHY this
  // role is rare for THIS person. Only rendered when passed (a rare-find send); a normal email omits it.
  const frameGrp = edgeFrame && String(edgeFrame).trim()
    ? `<div class="e-body" style="font-family:${SANS};font-size:15.5px;line-height:1.6;color:${P.head};">${esc(String(edgeFrame).trim())}</div>`
    : "";

  // One person to ask for a referral (US-only): initials avatar + name + position + links. Hidden
  // unless the pipeline resolved a real, confident contact (fail-closed at the source).
  let referralGrp = "";
  if (referralStatus(region, referral) === "shown") { // single source of truth (identical boolean)
    const initials = String(referral.name).trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
    const rlink = (h, t) => `<a href="${esc(h)}" style="color:${P.accentDeep};text-decoration:none;">${t}</a>`;
    const links = [referral.linkedin ? rlink(referral.linkedin, "LinkedIn") : "", referral.reach ? rlink(referral.reach, "Reach out") : ""].filter(Boolean).join(` <span style="color:${P.faint};">&middot;</span> `);
    referralGrp = `${lbl("One person who might be able to refer you")}
      <div style="border:1px solid ${P.line};border-radius:8px;padding:16px 18px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
        <td width="46" style="vertical-align:middle;"><div style="width:40px;height:40px;border-radius:50%;background:${P.accentDeep};color:${ROLE.white};text-align:center;line-height:40px;font-family:${SANS};font-size:15px;font-weight:500;">${esc(initials)}</div></td>
        <td style="vertical-align:middle;padding-left:12px;">
          <div style="font-family:${SANS};font-size:15px;font-weight:500;color:${P.head};">${esc(referral.name)}</div>
          ${referral.position ? `<div style="font-family:${SANS};font-size:14px;color:${P.text};margin-top:1px;">${esc(referral.position)}</div>` : ""}
          ${links ? `<div style="margin-top:6px;font-family:${SANS};font-size:14px;">${links}</div>` : ""}
        </td>
      </tr></tbody></table>
    </div>`;
  }

  // ── TRY PRO — an interest probe, not a sale ────────────────────────────────────────────────────
  // DARK by default (PRO_PITCH). It replaces the referral slot rather than sitting beside it: two
  // asks in one email compete, and the referral box only ever rendered when a real contact resolved,
  // so the space is usually empty anyway. Turning referrals off is REFERRAL_REGIONS=none — no code
  // change, one switch, and referralStatus/scheduler/first-role all read it (quality-gate.mjs).
  //
  // WHAT IT MAY AND MAY NOT SAY. Every line is something Charlie could actually do with material it
  // already holds — the person's own story, reordered, nothing invented. It promises no
  // date, no price, and no outcome. "No payment now" is literal: the CTA opens a REPLY, and a reply
  // is all it collects. If any of these ever ships as a paid feature, this copy has to be re-earned.
  //
  // The click is a mailto, deliberately: it keeps the one-door rule (everything arrives at /inbound)
  // and needs no landing page, no form, and no new surface. Interest is recorded when the reply
  // lands, from the subject line — see server/charlie-remote.ts.
  // HIDDEN ONCE THEY HAVE ANSWERED IT. Re-asking someone who already replied "yes, I'd use this" asks
  // them for something they have already given, which reads as Charlie not listening — and every other
  // honest thing in the email depends on it listening.
  // The caller resolves this from a single `pro_interest` signal read per run (charlie-store's
  // `emailsWithSignal`), never a per-render query, and it fails OPEN: unknown means show it.
  let proGrp = "";
  if (String(process.env.PRO_PITCH || "").toLowerCase() === "on" && !proAsked) {
    // NOT ON THIS LIST: "more than one role a day". Charlie's promise is ONE role when it clears the
    // bar, and silence when nothing does. Selling volume as an upgrade turns the bar into a paywall and
    // Charlie into the job board this product exists not to be. Every line below is "help me win THIS
    // role" — the one thing more of would not make the product worse.
    const items = [
      "The person who can refer you, and a warm way in",
      "Your resume, rewritten for this exact role, from your own story",
      "A cover letter that sounds like you, not a template",
      "The message to send them, built on what you have actually done",
    ];
    const li = items.map((t) => `<tr>
        <td style="width:16px;vertical-align:top;padding:0 0 8px;"><div style="width:5px;height:5px;border-radius:50%;background:${P.accent};margin-top:8px;"></div></td>
        <td style="font-family:${SANS};font-size:14px;line-height:1.55;color:${P.text};padding:0 0 8px;">${esc(t)}</td>
      </tr>`).join("");
    const proBody = encodeURIComponent("Yes, I'd use this.\n\nThe one I want most:\n\n");
    const proHref = `mailto:start@mail.example.com?subject=${encodeURIComponent(PRO_SUBJECT)}&body=${proBody}`;
    proGrp = `${lbl("What else I could do for you")}
      <div style="background:${ROLE.box.catch};border-radius:8px;padding:18px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody>${li}</tbody></table>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;"><tbody>
          <tr><td align="center" style="background:${P.accentDeep};border-radius:6px;text-align:center;">
            <a href="${proHref}" style="display:block;padding:10px 24px;font-family:${SANS};font-size:14px;font-weight:500;color:${ROLE.white};text-decoration:none;text-align:center;">I'm interested</a>
          </td></tr>
          <tr><td style="padding-top:10px;font-family:${SANS};font-size:13px;line-height:1.5;color:${P.sub};">Nothing to pay, nothing to sign up for. I want to know which of these to build first.</td></tr>
        </tbody></table>
      </div>`;
  }

  // The gift-a-role block: send this exact role to a friend who'd fit; they get an honest read (check@).
  // Needs the job id (from findId) to mint the signed, attributable /j link; returns "" without it.
  const giftJobId = (email && findId && findId.startsWith(`${email}:`)) ? findId.slice(email.length + 1) : "";
  // DARK by default: the gift block only enters a live role email when GIFT_A_ROLE=on. That flag is the
  // switch, flipped after the /j route + check@ resolution ship, so a /j link is never dead in an inbox.
  const giftGrp = process.env.GIFT_A_ROLE === "on" ? giftRoleBlock({ email, role: { id: giftJobId, title: fields.role_title, company: fields.company } }) : "";

  // ONE GROUNDED QUESTION (lib/role-ask.mjs), and it is the LAST thing in the email: buried inside the
  // fit block, a skimming reader passes it on the way to the apply button and never registers that
  // they were asked anything. A question nobody notices is not a loop.
  //
  // It gets the same light box "How to position you" uses — an EXISTING token (ROLE.box.position), no
  // new value enters the locked palette — so it reads as its own thing rather than another paragraph.
  // The specific half of the sentence is a verbatim span of the matcher's own uncertainty; the
  // renderer adds no claim of its own. Absent -> nothing renders.
  const askGrp = askLine
    ? `<div style="background:${ROLE.box.position};border-radius:8px;padding:16px 18px;">
      <div style="font-family:${SANS};font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${P.head};margin:0 0 8px;">One question</div>
      <div style="font-family:${SANS};font-size:15px;line-height:1.55;color:${P.head};">${esc(askLine)}</div>
    </div>`
    : "";

  const groups = [
    grp(headerGrp, true),
    frameGrp ? grp(frameGrp) : "",
    summaryGrp ? grp(summaryGrp) : "",
    fitTop ? grp(fitTop) : "",
    notesGrp ? grp(notesGrp) : "",
    fingerprint ? grp(fingerprint) : "",
    payGrp ? grp(payGrp) : "",
    positioningGrp ? grp(positioningGrp) : "",
    referralGrp ? grp(referralGrp) : "",
    proGrp ? grp(proGrp) : "",
    companyGrp ? grp(companyGrp) : "",
    grp(`<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr>${ctaCells}</tr></tbody></table>${secondary}${feedback}`),
    giftGrp ? grp(giftGrp) : "",
    askGrp ? grp(askGrp) : "",   // LAST. See the note above the definition.
  ].filter(Boolean);
  const body = groups.join(""); // no divider lines between groups — padding alone separates them

  const viaLink = via ? `via ${viaUrl ? `<a href="${esc(viaUrl)}" style="color:${P.faint};">${esc(via)}</a>` : esc(via)} &middot; ` : "";
  const unsub = unsubUrl || "#";
  // THE PREHEADER IS THE FIRST LINE A PERSON READS, BEFORE THEY OPEN ANYTHING — so it is the last
  // place a v1 sentence may contradict the engine (e.g. "You cover EVERY NAMED ASK: …" while the engine
  // had 4 of 5 satisfied and one unmet).
  //
  // When the engine decides, the preview is BUILT FROM THE ENGINE'S OWN SATISFIED ROWS and can only
  // name things it certified. It states no total, no proportion and no "every", so there is nothing
  // in it that the record does not already carry.
  const engPreheader = engineOn
    ? (() => { const l = engineRows(engine).map((r) => r.label); return l.length > 1
        ? `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}, shown in your own record.`
        : `${l[0]}, shown in your own record.`; })()
    : null;
  const preheader = esc((engPreheader || (hasReadout && cov.reason) || f.why_you || f.lede || roleLine).slice(0, 110));

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(roleLine)}</title>
<style>
  /* Fluid on phones: fill the screen at true font size instead of scaling the whole 600px down. */
  @media only screen and (max-width:600px){
    .container{width:100%!important;}
    .wrap{padding:14px 8px 34px!important;}
    .gp{padding-left:20px!important;padding-right:20px!important;}
    .foot{padding-left:20px!important;padding-right:20px!important;}
    /* responsive type, job mail only: shrink the big title so it does not overflow, and lift
       the smallest labels/body so they stay comfortably readable on a phone */
    .e-role{font-size:26px!important;line-height:1.2!important;}
    .e-where{font-size:16px!important;line-height:1.5!important;}
    .e-kick,.e-lbl{font-size:11.5px!important;}
    .e-body{font-size:16px!important;line-height:1.5!important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${P.canvas};font-family:${SANS};color:${P.text};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${preheader} charlieroles</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${P.canvas};"><tbody><tr>
    <td align="center" class="wrap" style="padding:24px 12px 44px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="container" style="width:100%;max-width:600px;background:${P.paper};border:1px solid ${P.hair};border-radius:8px;"><tbody>
        <tr><td class="gp" style="padding:16px 40px;"><img src="${HAND}" width="30" height="30" alt="Charlie" style="display:block;"></td></tr>
        ${body}
      </tbody></table>
      <div class="foot" style="font-family:${SANS};font-size:11.5px;line-height:1.5;color:${P.faint};max-width:600px;margin:18px auto 0;padding:0 40px;text-align:center;">
        ${viaLink}<a href="${esc(unsub)}" style="color:${P.faint};">Unsubscribe</a>
      </div>
    </td>
  </tr></tbody></table>
</body>
</html>
`;
}
