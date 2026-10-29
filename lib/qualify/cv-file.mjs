// lib/qualify/cv-file.mjs — is this attached PDF the person's CV? PURE.
//
// The PDF kept as their CV is the file an employer receives (Pieworks submitReferral's `cv`), so a payslip, a
// receipt, an appointment, offer or relieving letter, or an appraisal must never become it. Two kinds of marker,
// read in the file's opening only:
//   STRONG  a letter's or a payment document's header. It rejects the file whatever its name.
//   SOFT    pay or review words ("net pay", "appraisal") that an HR or payroll person's CV can contain in its
//           summary. They reject only a file NOT named as a CV.
// A file counts when its name says CV as a word (not "ACVL_payslip.pdf"), or when its text has a CV's sections.
// When unsure, it is not the CV: the person is asked for one.
// A file NAMED as their CV is taken unless it opens as a payment document (a real CV can open with a cover letter or
// a payroll or HR summary). Nothing is submitted until the person has seen the file's name in the
// final confirm email and replied YES (lib/qualify/agent.mjs).

const CV_NAME = /(^|[^a-z])(cv|resume|r[eé]sum[eé]|curriculum[ _-]?vitae|biodata)([^a-z]|$)/i;
const NOT_A_CV_NAME = /pay ?slip|salary|receipt|invoice|statement|offer[ _-]?letter|relieving|appraisal|appointment[ _-]?letter|experience[ _-]?letter/i;
const SECTIONS = [/\b(work |professional )?experience\b|\bemployment( history)?\b|\bwork history\b|\bcareer (history|summary)\b/i, /\beducation\b|\b(key |core )?skills\b|\bprojects\b|\bqualifications?\b|\bcore competencies\b|\bcertifications?\b/i];
const STRONG = /\b(dear\s+(?!(hiring|recruit\w*|team|sir|madam|hr|talent|selection|search)\b)[a-z]+|we are pleased|letter of (offer|appointment|relieving|experience|increment)|(appointment|offer|relieving|experience|increment|revision|verification|confirmation) letter|salary revision|employee verification|relieved from|to whom(so)?ever it may concern|this is to certify|pay ?slip|salary (slip|statement)|payment receipt|receipt (no|number|#)|invoice (no|number|#)|tax invoice|annual review|performance (review|appraisal) (for|fy|20\d\d))\b|\bnet pay\b[\s\S]{0,400}\bdeductions\b|\bdeductions\b[\s\S]{0,400}\bnet pay\b/i;
const PAYMENT_HEAD = /^\W*(pay ?slip|salary (slip|statement)|payment receipt|tax invoice|invoice)\b/i;
const SOFT = /\b(net pay|gross (pay|earnings)|deductions|amount paid|performance (review|appraisal)|appraisal (for|form|period)|annual appraisal)\b/i;

/** @returns {boolean} */
export function looksLikeCv(filename, text) {
  const name = String(filename || "").replace(/\.[a-z0-9]+$/i, "");
  const top = String(text || "").slice(0, 600);
  if (CV_NAME.test(name)) return !/pay ?slip|receipt|invoice/i.test(name) && !PAYMENT_HEAD.test(top);
  if (STRONG.test(top)) return false;
  if (NOT_A_CV_NAME.test(name) || SOFT.test(top)) return false;
  return SECTIONS.every((re) => re.test(String(text || "")));
}
