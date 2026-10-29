// role-answer.mjs — answer a candidate's question about the role they are already talking about.
//
// PURE, AND DELIBERATELY NOT A MODEL. Every sentence this returns is built from a stored field. There
// is no generation step and nothing to prompt, which is what makes "it cannot invent a salary" a
// property of the code rather than an instruction somebody hopes a model follows. It is also why the
// whole thing is table-testable: the same question and the same job produce the same sentence, twice.
//
// WHAT IT ANSWERS, AND ONLY THIS: the role in play. Pay, location, remote, and whether they can be put
// forward. Four things a candidate actually asks after a role email, all of them already on the record.
// It is not a chatbot and must never grow into one: a question it does not recognise returns null and
// the existing human fallback runs, exactly as it does today.
//
// AN ABSENT FIELD IS NOT A FACT. Title, company, location and apply_url are always populated on a
// find; `remote` and `compensation` usually are not. So the common case for "is it remote?" is that WE
// DO NOT KNOW, and the honest answer says so and offers to ask.
// Reading a null `remote` as "on-site" would be inventing a working arrangement for a real job, which
// is the same class of error as inventing a salary. It is never done here.
//
// COPY RULES: sentence case, no em dashes, contractions on. These are answers a person reads in a
// thread they are already in, so they read like a reply and not like a template.

const ASKS_PAY = /\b(how much|pay|paying|pays|salary|salaries|compensation|ctc|package|remuneration|stipend|budget)\b/i;
const ASKS_REMOTE = /\b(remote|wfh|work from home|hybrid|on.?site|onsite|in office|in the office|relocat)\b/i;
const ASKS_APPLY = /\b(can i apply|should i apply|how do i apply|apply for|apply to|put me forward|go ahead|am i eligible)\b/i;
const ASKS_WHERE = /\b(where|located|location|based)\b/i;
/** "Is that in Nagpur?" — a yes/no about a named place. */
const PLACE_CHECK = /\b(?:is|are)\s+(?:that|this|it|the role|the job)?\s*(?:role|job|one|position)?\s*(?:in|at|based in)\s+([A-Za-z][A-Za-z .'-]{1,30})\s*\??/i;

/** Does the job's location mention this place, or the other way round? */
function samePlace(location, place) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const a = norm(location), b = norm(place);
  if (!a.length || !b.length) return null; // cannot tell, which is not the same as "no"
  return b.some((w) => a.includes(w));
}

/**
 * @param {{question: string, job: object, name?: string}} input
 * @returns {{text: string, kind: string}|null}  null means "not answerable here" -> human fallback
 */
export function answerAboutRole({ question, job, name = "" } = {}) {
  const q = String(question || "").trim();
  const j = job || {};
  const title = String(j.title || "").trim();
  const company = String(j.company || "").trim();
  const location = String(j.location || "").trim();
  // A blank string is as absent as a null. Both mean the listing did not say.
  const remote = String(j.remote ?? "").trim();
  const pay = String(j.compensation ?? "").trim();
  if (!q || !title) return null;

  // NO NAME IN THE ANSWER. This is a reply inside a thread the person is already in, and a recruiter
  // answering "is that in Nagpur?" says "yes, it's in Nagpur", not "Yes, Priya, it's in
  // Nagpur". Re-greeting somebody mid-conversation is the tell that a template wrote it, and it
  // avoids "Priya, The listing says..." with a capital letter mid-sentence.
  const role = company ? `${title} role at ${company}` : `${title} role`;

  // "Is that in Nagpur?" — checked before the general location branch, because it is a yes/no
  // and a yes/no question deserves a yes or a no as its first word.
  const m = q.match(PLACE_CHECK);
  if (m && location) {
    const place = m[1].trim();
    const same = samePlace(location, place);
    if (same === true) return { kind: "place", text: `Yes, it's in ${location}.` };
    if (same === false) return { kind: "place", text: `No, that one's in ${location}.` };
  }

  if (ASKS_PAY.test(q)) {
    return pay
      ? { kind: "pay", text: `The listing says ${pay}.` }
      // The role is already established in the thread; naming it again is the machine restating
      // context nobody asked it to restate.
      : { kind: "pay_unknown", text: `They haven't published a range. I can ask if you'd like.` };
  }

  if (ASKS_REMOTE.test(q)) {
    if (remote) return { kind: "remote", text: `It's ${remote.toLowerCase()}${location ? ` in ${location}` : ""}.` };
    // THE COMMON CASE. We know where it is and we do not know the working arrangement. Say both.
    return location
      ? { kind: "remote_unknown", text: `The listing doesn't say whether it's remote. It's based in ${location}. I can ask.` }
      : null;
  }

  if (ASKS_APPLY.test(q)) {
    return { kind: "apply", text: `Yes. That's the ${role}${location ? ` in ${location}` : ""}. Reply yes and I'll put you forward.` };
  }

  if (ASKS_WHERE.test(q) && location) {
    return { kind: "where", text: `It's in ${location}.` };
  }

  return null; // not something we can answer from the record
}

/**
 * Have they already asked this, and been answered?
 *
 * If somebody asks the same thing twice, our first answer did not land. Sending it again word for
 * word is the single most machine-like thing this system could do, and it is what "I already told you
 * that" sounds like from the other side. So a repeat escalates to a person instead of repeating.
 *
 * Compared on the normalised opening of the message, because people re-ask in slightly different
 * words and the opening is what carries the question.
 *
 * @param {string} current   their words this time
 * @param {string[]} priors  their previous messages, most recent first, EXCLUDING this one
 */
export function askedBefore(current, priors = []) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const c = norm(current);
  if (c.length < 8) return false; // too short to match on safely
  return (priors || []).some((p) => norm(p) === c);
}
