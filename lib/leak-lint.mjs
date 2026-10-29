// lib/leak-lint.mjs — no internal identifier may reach a person's inbox.
//
// The failure it prevents: a confirmation that reads "I've updated where you want to work, your pay
// currency, home_place, ..." because a helper fell back to printing a dossier key it had no English
// phrase for, and nothing between that line and the send looked at the result.
//
// WHY IT LIVES AT THE SEND DOOR AND NOT IN THE TEMPLATE. lib/convo-lint checks dark patterns and
// voice, but only on model-generated replies; fixed templates are the majority of what goes out.
// There are dozens of render functions, so the only place that covers all of them is the one door
// they all pass through.
//
// A DENY LIST, NOT A snake_case BAN, AND THAT CHOICE IS LOAD-BEARING. Banning every snake_case token
// looks stronger and is worse: role emails quote job descriptions verbatim, resumes contain things
// like `user_id`, and tracking URLs carry `gh_src`. A blanket rule would block real sends, and a guard
// that silently produces silence is its own failure. The list below is
// our actual vocabulary, so a match is almost certainly a real bug rather than somebody's prose.
//
// IT READS THE TEXT BODY, WITH URLS REMOVED. Links legitimately carry underscores and are not
// visible copy. Scanning raw HTML would trip on markup and attributes that no reader ever sees.

/**
 * Column and enum names from our own schema that would be meaningless or alarming to a reader.
 * Ordinary English words are deliberately absent: "stable", "steady" and "mover" are real
 * mobility_profile values and also words people write, so they cannot be banned by spelling.
 */
export const INTERNAL_TOKENS = [
  // dossier + preference keys, the family that actually leaked
  "home_place", "comp_floor", "comp_currency", "comp_current", "comp_expected", "ping_bar",
  "may_share", "may_write_again", "proof_points", "case_studies", "professional_years",
  // talent_pool: private judgements and machine labels
  "mobility_profile", "seeking_status", "role_family", "assessed_family", "screen_score",
  "screen_flags", "screen_max", "notice_days", "notice_period_raw", "total_years", "top_skills",
  "consent_pool", "consent_share", "consent_process", "consent_text", "enrichment_version",
  "missing_fields", "avg_tenure_months", "longest_tenure_months", "current_tenure_months",
  // enum VALUES that are snake_case, so unambiguous
  "active_seeker", "open_to_right_thing", "not_looking", "contract_only", "first_job",
  "product_design", "product_management", "customer_success", "senior_ic", "cannot_verify",
  "prior_employer_match", "unverified_quote", "send_failed", "profile_shared", "apply_link",
  // plumbing a reader should never see
  "dedupe_key", "resend_id", "find_id", "job_id", "email_id", "candidate_email", "source_form",
];

/**
 * The private label for how often somebody changes job. Not a column name, a judgement, and the one
 * word on this list that would genuinely wound the person who read it about themselves.
 */
export const JUDGEMENT_WORDS = ["hopper"];

const URLS = /https?:\/\/\S+|\bwww\.\S+|mailto:\S+/gi;
const EMAILS = /[\w.+-]+@[\w.-]+\.\w+/g;

/** Visible words only: drop script/style blocks, then tags (which takes their attributes with them). */
const visibleFromHtml = (html) =>
  String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");

/**
 * @param {{ text?: string, subject?: string, html?: string }} msg the rendered message
 * @returns {{ ok: boolean, hits: Array<{token: string, kind: string, context: string}> }}
 */
export function leakLint({ text = "", subject = "", html = "" } = {}) {
  // BOTH HALVES, because they are not guaranteed to carry the same words. Every template today
  // builds them from the same values, and the sweep over all snapshotted output confirms it, but
  // nothing enforces it: a future template could interpolate a value into a badge that exists only
  // in the html. Assuming the invariant and being wrong would mean the leak check passes on the half
  // nobody reads. Tags and their attributes are stripped first, so markup cannot false-positive.
  //
  // Links and addresses are dropped from both: they are not visible copy and legitimately contain
  // underscores (a Greenhouse tracking URL carries gh_src).
  const hay = `${subject}\n${text}\n${visibleFromHtml(html)}`.replace(URLS, " ").replace(EMAILS, " ");
  const low = hay.toLowerCase();
  const hits = [];

  for (const t of INTERNAL_TOKENS) {
    const i = low.indexOf(t);
    if (i > -1) hits.push({ token: t, kind: "internal-field", context: hay.slice(Math.max(0, i - 40), i + t.length + 40).replace(/\s+/g, " ").trim() });
  }
  for (const w of JUDGEMENT_WORDS) {
    const m = low.match(new RegExp(`\\b${w}\\b`));
    if (m) hits.push({ token: w, kind: "private-judgement", context: hay.slice(Math.max(0, low.indexOf(m[0]) - 40), low.indexOf(m[0]) + 60).replace(/\s+/g, " ").trim() });
  }
  // A bare screen score. No candidate-facing copy shows this number, and it is easy to interpolate
  // by accident from a scorecard object.
  const score = hay.match(/\b\d{1,2}\s*\/\s*18\b/);
  if (score) hits.push({ token: score[0], kind: "screen-score", context: hay.slice(Math.max(0, hay.indexOf(score[0]) - 40), hay.indexOf(score[0]) + 40).replace(/\s+/g, " ").trim() });

  return { ok: hits.length === 0, hits };
}
