// lib/tally.mjs — read applicants out of a Tally form. READ ONLY, no model, no send, no writes.
//
// Charlie posts a role, applicants answer a Tally form, and this is the seam that brings their
// answers in. Everything here is a pure read: it cannot email anyone, cannot spend anything on a
// model, and cannot write to Supabase.
//
// COMPLETENESS IS OUR JUDGEMENT, NOT TALLY'S. Tally's `isCompleted` means "reached the last page".
// When no field is marked required, a person can be isCompleted:true having typed a name and nothing
// else, and a submission that answered every question may not be isCompleted. Reading `isCompleted`
// as "complete" would put an empty submission in front of a client.
//
// So a required set is named here, in code, and `classify` reports exactly which members are missing
// for each person. That list is not just a gate: it is the text quoted back to a partial applicant in
// their email, so it has to be the real question titles rather than internal slugs.

import { TallySubmissionsPage, answersByTitle, titleIndex } from "./schemas/tally.mjs";

const API = "https://api.tally.so";

/**
 * The questions a person MUST have answered for us to represent them.
 *
 * The four long-form ones carry every piece of evidence a story is built from; without them there is
 * nothing to write and nothing to verify. Consent is separate and absolute (see CONSENT below).
 */
export const REQUIRED_TITLES = [
  "First Name",
  "Last Name",
  "Email Address",
  "How would you describe the kind of engineer you are?",
  "What kind of team do you want to join next?",
  "What's a system you designed end to end?",
  "Tell us about an outage you handled.",
];

/** Wanted, and their absence is reported, but it does not on its own make a submission partial. */
export const DESIRABLE_TITLES = ["Portfolio URL", "LinkedIn Profile URL", "Resume / CV", "Availability", "City", "Country"];

/** Permission to process this application at all. No box, no processing, no email. */
export const CONSENT_TITLE = "I agree that Charlie may process the information in this application to assess me for this role.";

/**
 * Permission to write to them about OTHER roles later. The only thing that can put anyone in a pool.
 *
 * VERBATIM, INCLUDING THE PARENTHESES. A truncated title matches nothing and reports a clean,
 * plausible "opted in: 0". A consent constant that matches no question on the form must stop the run,
 * not quietly mean "nobody consented".
 */
export const OPTIN_TITLE = "Yes, Charlie may also send me roles from other companies it works with. (Optional - answering this has no bearing on how this application is assessed.)";

/**
 * The signed download URLs behind a FILE_UPLOAD answer.
 *
 * SEPARATE FROM answersByTitle ON PURPOSE. That flattens a file answer to its FILENAME, which is what
 * you want when printing a roster and exactly what you must not use when you need the document. A
 * screen that reads only the form answers misses what the resume says (years of experience, previous
 * employment at the hiring company). The resume is evidence; screening without it is screening half
 * the application.
 *
 * The urls are short-lived signed links from storage.tally.so. Fetch them, do not store them.
 */
export function fileUrls(submission, title, titleById) {
  const id = [...titleById].find(([, t]) => t === title)?.[0];
  if (!id) return [];
  const r = (submission.responses || []).find((x) => x.questionId === id);
  const v = r && r.answer;
  if (!Array.isArray(v)) return [];
  return v.map((f) => (f && typeof f === "object" ? { url: f.url, name: f.name || "" } : null)).filter((f) => f && f.url);
}

/** A checkbox is "ticked" when it came back with any text at all; Tally omits or empties it otherwise. */
const ticked = (v) => Boolean(String(v ?? "").trim());

/** An answer counts only if somebody actually wrote something. One character is not an answer to an essay. */
const answered = (v, min = 1) => String(v ?? "").trim().length >= min;

/**
 * Every submission on a form, across all pages, validated at the boundary.
 *
 * @param {object} o
 * @param {string} o.formId
 * @param {string} o.apiKey
 * @param {(m:string)=>void} [o.log]
 * @returns {Promise<{ people: Array<{id:string,isCompleted:boolean,submittedAt:string|null,answers:object}>, titles: string[], skipped: number }>}
 */
export async function fetchSubmissions({ formId, apiKey, log = () => {} }) {
  if (!formId) throw new Error("fetchSubmissions: no formId");
  if (!apiKey) throw new Error("fetchSubmissions: no apiKey (set TALLY_API_KEY)");
  const people = [];
  let titles = [];
  let skipped = 0;
  for (let page = 1; ; page++) {
    const res = await fetch(`${API}/forms/${formId}/submissions?limit=50&page=${page}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Tally ${res.status} on page ${page}: ${(await res.text()).slice(0, 200)}`);
    const parsed = TallySubmissionsPage.safeParse(await res.json());
    if (!parsed.success) {
      // Fail closed on the PAGE: an unreadable page means we do not know who is on it, and guessing
      // that it was empty would silently drop applicants.
      throw new Error(`Tally page ${page} did not match the schema: ${parsed.error.issues.slice(0, 3).map((i) => i.path.join(".")).join(", ")}`);
    }
    const idx = titleIndex(parsed.data.questions);
    if (!titles.length) titles = [...idx.values()];
    for (const s of parsed.data.submissions) {
      try {
        people.push({
          id: s.id,
          isCompleted: s.isCompleted,
          submittedAt: s.submittedAt || s.createdAt || null,
          answers: answersByTitle(s, idx),
          // Kept so fileUrls() can resolve an upload later. answersByTitle flattens a file to its
          // filename, which is useless for actually reading the document.
          _responses: s.responses || [],
          _titleById: idx,
        });
      } catch (e) {
        skipped++; // per-record isolation: one bad record never drops the page
        log(`submission ${s.id}: unreadable, skipped (${e.message})`);
      }
    }
    if (!parsed.data.hasMore) break;
  }
  return { people, titles, skipped };
}

/**
 * What we hold for one person, and therefore which of the three emails they are owed.
 *
 * Three outcomes, and the order matters:
 *   no_consent  they never ticked the processing box. We do not screen them and we do not write.
 *   partial     consented, but the story cannot be built. `missing` is the exact question titles.
 *   complete    everything needed is there. Eligible for the screen.
 *
 * `optedIn` is orthogonal: it never decides whether someone is read, only whether we may write again.
 */
export function classify(person) {
  const a = person.answers || {};
  const consented = ticked(a[CONSENT_TITLE]);
  const optedIn = ticked(a[OPTIN_TITLE]);
  // 40 characters, not 1: these four are essay questions, and "n/a" or "-" is a skipped question
  // wearing an answer's clothes. Names and the address only need to be non-empty.
  const isEssay = (t) => t.endsWith("?") || t.startsWith("Tell us");
  const missing = REQUIRED_TITLES.filter((t) => !answered(a[t], isEssay(t) ? 40 : 1));
  const lacking = DESIRABLE_TITLES.filter((t) => !answered(a[t]));
  const status = !consented ? "no_consent" : missing.length ? "partial" : "complete";
  return { status, consented, optedIn, missing, lacking, email: String(a["Email Address"] || "").trim().toLowerCase(),
    name: `${String(a["First Name"] || "").trim()} ${String(a["Last Name"] || "").trim()}`.trim() };
}
