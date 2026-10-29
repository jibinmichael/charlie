// candidate-card.mjs — one applicant, shaped for a hiring manager rather than for us.
//
// THE PRINCIPLE. A board of fifty names is only useful if a decision can be made from the row. So
// everything that decides gets computed here, once, into flat values: is their notice short, is their
// ask inside the band, may we even show them to a client. Anything a manager has to open a row to
// learn is a thing they will not learn.
//
// EVERY VALUE IS DERIVED FROM THE STORED RECORD, never inferred to fill a gap. Unknown is a real
// answer and it has its own tag, because "Unknown" tells a manager to ask and a guessed value tells
// them nothing while looking like something.

/** Notice, as a band a manager can filter on. Null is Unknown, never assumed short. */
export function readyBand(noticeDays) {
  if (noticeDays == null) return "Unknown";
  if (noticeDays <= 0) return "Immediate";
  if (noticeDays <= 15) return "15 days or less";
  if (noticeDays <= 30) return "30 days or less";
  if (noticeDays <= 60) return "31 to 60 days";
  return "60 days or more";
}

/**
 * Their ask against the mandate's range, in rupees.
 *
 * THE FASTEST DISQUALIFIER THERE IS, and no ATS puts it on the first screen. Somebody 40% above the
 * band is a conversation the client will not have; somebody well below it is usually a signal about
 * seniority worth reading before the call rather than after.
 */
export function bandFit(expected, minLpa, maxLpa) {
  if (expected == null) return "Not stated";
  // An implausible figure is not a low salary expectation, it is a unit we cannot read.
  if (expected < MIN_PLAUSIBLE_ANNUAL) return "Not stated";
  const lpa = expected / 100000;
  if (lpa < minLpa) return "Below band";
  if (lpa > maxLpa) return "Above band";
  return "Inside band";
}

/**
 * The lowest number that can plausibly be an ANNUAL salary in rupees.
 *
 * Applicants often type 1500, 5000 or 15000 into a field labelled "annual CTC": monthly figures, or
 * thousands. Dividing them by 100,000 renders "0.2L", which tells a hiring manager somebody wants
 * twenty thousand rupees a year and gets them dismissed. A wrong number is worse than no number,
 * because no number prompts a question and a wrong one prompts a decision.
 */
export const MIN_PLAUSIBLE_ANNUAL = 100000;

/** Rupees to a readable ask. 1800000 -> "18L". Returns "" rather than a wrong or implausible number. */
export function lakhs(v) {
  if (v == null || Number.isNaN(Number(v))) return "";
  if (Number(v) < MIN_PLAUSIBLE_ANNUAL) return ""; // not an annual figure; see the constant above
  const l = Number(v) / 100000;
  return `${l % 1 === 0 ? l : l.toFixed(1)}L`;
}

/**
 * May this person be shown to a client at all?
 *
 * `consent_share` is per-role permission and `consent_pool` is permission to be written to about
 * other roles. Neither is permission for the other, and a manager reading a name they cannot act on
 * is how somebody gets contacted without having agreed to it.
 */
export function consentTag(row, appliedToThisRole = false) {
  // APPLYING TO A ROLE IS PERMISSION TO BE PUT FORWARD FOR THAT ROLE. It is not permission for any
  // other. Some forms never ask the share question in a form the detector recognises (one asks
  // nothing, another asks it as consent to be contacted by the client's own hiring team). Reading
  // either as a refusal would put "No" beside everyone who applied to that exact mandate.
  if (appliedToThisRole) return row?.consent_share ? "Can share - said yes" : "Can share - they applied";
  if (row?.consent_share) return "Can share with client";
  if (row?.consent_pool) return "Pool only, not asked";
  return "No";
}

/** Mobility, already computed at enrichment. Surfaced as a tag rather than a number. */
export function mobilityTag(m) {
  const v = String(m || "").toLowerCase();
  return ["steady", "stable", "mover", "hopper"].includes(v) ? v[0].toUpperCase() + v.slice(1) : "Unknown";
}

/**
 * What a manager should be told to check, before they spend time.
 *
 * Every flag is a FACT WE DO NOT HAVE rather than a judgement about the person. That is the only kind
 * of warning worth putting on somebody's row: it tells the reader what to ask, not what to think.
 */
export function watchOuts(row, answers = {}) {
  const out = [];
  if (row?.total_years == null) out.push("Years not recorded");
  if (!row?.linkedin_url) out.push("No LinkedIn");
  if (!row?.portfolio_url) out.push("No portfolio or link");
  if (row?.comp_expected == null) out.push("No expected pay");
  else if (row.comp_expected < MIN_PLAUSIBLE_ANNUAL) out.push("Pay figure unclear");
  const written = Object.values(answers || {}).join(" ").trim();
  if (written.length < 250) out.push("Thin answers");
  return out;
}

/** Current role as one cell: "Data Scientist · Turing". Blank halves are dropped, never guessed. */
export function nowLine(title, company) {
  return [String(title || "").trim(), String(company || "").trim()].filter(Boolean).join(" · ");
}
