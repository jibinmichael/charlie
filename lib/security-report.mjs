// lib/security-report.mjs — is an inbound email a SECURITY / vulnerability report about Charlie's
// own systems (as opposed to a person trying to sign up)?
//
// The one inbound door (start@) treats every stranger's mail as onboarding: no resume attached =>
// "send me your resume". A security researcher reporting a bug is NOT onboarding and must never get
// that reply. This deterministic classifier lets /inbound route such mail to a human (forward to the
// owner) instead of the onboarding nudge. No model in the loop — pure and exhaustively testable.
//
// PRECISION over recall, because the two failure modes are asymmetric:
//   - False NEGATIVE (a real report reads as onboarding): annoying, but the researcher still reached
//     a mailbox a human watches and can reply again — recoverable.
//   - False POSITIVE (a genuine SIGN-UP is diverted to the owner instead of onboarded): the worst
//     case is a CYBERSECURITY job seeker ("I'm a pentester, I want in") — the exact population whose
//     vocabulary overlaps with a report. So we (a) require the language of a flaw IN *your* system or
//     an unambiguous disclosure-program term, and (b) BAIL the moment the mail shows onboarding intent.
//     The caller ALSO gates on "no resume attached" — a report never ships a resume, a sign-up does.

// Onboarding intent — if any of these appear it is a sign-up, never a security report. Checked FIRST
// so a security professional's application ("I do vulnerability research, looking for a role") is
// never mistaken for a disclosure.
const ONBOARDING_INTENT = new RegExp(
  [
    "i want in", "sign me up", "hire me", "onboard me",
    "find me (a |an )?(job|role|position|opportunit)",
    "looking for (a |an )?(job|role|work|position|opportunit|gig)",
    "seeking (a |an )?(job|role|position|opportunit|work)",
    "open to (work|roles|opportunit|new)",
    "want to (join|work (with|at|for))", "join your team", "apply(ing)? (for|to)",
    "my (resume|cv|profile) (is )?(attached|here)?", "here.?s my (resume|cv)",
    "attach(ed|ing) (is |is my )?(resume|cv|profile)",
    "job search", "job hunt", "career (change|switch|move)",
  ].join("|"),
  "i",
);

// Unambiguous disclosure vocabulary — nobody signing up for a job writes these about you.
const DISCLOSURE_TERMS =
  /\b(bug bounty|bounty program|responsible disclosure|coordinated disclosure|security\.txt|proof[- ]of[- ]concept|vulnerability disclosure|security advisory)\b/i;

// A CVE reference is unambiguous.
const CVE = /\bCVE-\d{4}-\d{3,7}\b/i;

// A flaw named as being IN *your* system. Two-part on purpose: a security noun AND, within a short
// window, "your <asset>". This keeps it tight — "vulnerability management experience" or "I want to
// exploit my skills on your platform" (a cover-letter line) will not trip it, because the security
// noun must sit right before an explicit "your <asset>". Requires "your" (not "the"): a report is
// about YOUR system; generic prose about "the system" is not.
const FLAW_IN_YOUR_SYSTEM = new RegExp(
  "\\b(bug|vulnerabilit(y|ies)|security (issue|flaw|hole|problem|risk|gap)|" +
    "xss|csrf|ssrf|rce|idor|sqli|sql injection|open redirect|clickjack|" +
    "misconfigurat|subdomain takeover|privilege escalation|remote code execution|" +
    "exposed (secret|credential|api ?key|token|bucket|database|\\.env|password))" +
    "\\b[\\s\\S]{0,40}\\byour\\s+(?:[a-z0-9.'-]+\\s+){0,2}" +
    "(site|website|web ?site|system|systems|app|application|platform|api|asset|assets|" +
    "server|infrastructure|infra|product|page|portal|domain|endpoint|code ?base|backend)\\b",
  "i",
);

/**
 * Is this inbound email a security/vulnerability report about Charlie's systems (not a job sign-up)?
 * @param {string} [subject] the inbound Subject line.
 * @param {string} [body]    the inbound body text (already recovered from HTML/Receiving API upstream).
 * @returns {boolean}
 */
export function isSecurityReport(subject = "", body = "") {
  const s = `${subject || ""}\n${body || ""}`;
  if (ONBOARDING_INTENT.test(s)) return false; // a sign-up, even if it name-drops security terms
  if (DISCLOSURE_TERMS.test(s) || CVE.test(s)) return true;
  return FLAW_IN_YOUR_SYSTEM.test(s);
}
