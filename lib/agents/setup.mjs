// lib/agents/setup.mjs — what the workspace's Setup card shows for a Qualify & Submit connection, beyond the saved
// settings themselves: what the destination needs, the agent's timings, the real emails, what Charlie does at each
// step with the model it uses, and the guardrails. PURE: the route passes the connection, a role and the env.
//
// Nothing here is written by hand for the screen. Timings are the agent's own constants (lib/qualify/agent.mjs),
// the emails are the real templates (email-kit.mjs) filled for a placeholder person and, when the connection has
// one, a real role; the models are the ones the code reads from the environment. lib/agents/setup.test.mjs pins it.
import { renderQualifyVerify, renderQualifyReminder, renderQualifyConfirm, renderQualifyPutForward, renderQualifyClosed } from "../../email-kit.mjs";
import { FULL_PASS_HOURS, REMIND_AFTER_HOURS, CLOSE_AFTER_HOURS, CONFIRM_ASKS, confirmFacts } from "../qualify/agent.mjs";
import { questionsFor } from "../qualify/fields.mjs";
import { AGENTS } from "./registry.mjs";
import { EVALUATIONS_PER_PASS } from "../qualify/wiring.mjs";
import { verifyCopy } from "../qualify/copy.mjs";
import { ADAPTERS } from "../qualify/adapters.mjs";

/** A rendered email as paragraphs; the connection's own two lines marked editable. */
function paragraphs(mail, own = []) {
  const mine = new Set(own.filter(Boolean).map((x) => x.trim()));
  const lines = String(mail.text || "").split(/\n{2,}/).map((p) => p.trim()).filter((p) => p && p !== "Charlie" && !/unsubscribe/i.test(p));
  return { subject: mail.subject, lines: lines.map((text) => ({ text, editable: mine.has(text) })) };
}

// The templates keep their variables as {tokens}, so the workspace shows what is copy and what is filled per person
// and per role (tags kept distinct from copy). Each token, and what fills it.
export const TEMPLATE_VARIABLES = {
  name: "Their first name", role: "The role", company: "The employer", city: "The role's city", partner: "The employer system",
  fixed: "Current fixed pay", variable: "Current variable pay", expected: "Expected pay", days: "Notice, in days",
  email: "Their email", phone: "Their phone", code: "Country code", linkedin: "Their LinkedIn", their_company: "Their company",
  their_city: "Their city", years: "Years of experience", cv: "Their CV file", note: "The note about them", total: "Current total pay",
};

export function qualifySetup({ connection, env = {} }) {
  const partner = connection?.destination?.via || connection?.name || "the employer system";
  const ex = { name: "{name}", role: "{role}", company: "{company}", city: "{city}", partner: "{partner}" };
  const copy = verifyCopy(connection?.sequence, ex);
  const plain = String(renderQualifyVerify({ ...ex, questions: ["x"] }).text).split(/\n{2,}/).map((p) => p.trim());
  const own = [copy.intro || plain[1], copy.closing || plain[plain.length - 2]];
  // every question the agent can ask, from its own question builder (a person whose record holds nothing yet); a
  // real person is asked only the ones their record leaves open
  const questions = questionsFor({ fields: {}, role: ex.role, company: ex.company, city: ex.city, personCity: null, haveCvPdf: false }).map((q) => q.text);
  // the confirm's lines from the agent's own builder, for placeholder values
  const P = (v) => ({ value: v });
  const facts = confirmFacts({ name: P("{name}"), emailId: P("{email}"), countryCode: P("+{code}"), phoneNo: P("{phone}"), linkedInUrl: P("{linkedin}"), currentCompany: P("{their_company}"), currentLocation: P("{their_city}"), experience: P("{years}"), currentCtcFixed: P("{fixed}"), currentCtcVariable: P("{variable}"), expectedCtc: P("{expected}"), noticePeriod: P("{days}") }, "{cv}", "{note}");
  const emails = [
    { id: "verify", name: "Verify", when: "First, after the scorer passes them", ...paragraphs(renderQualifyVerify({ ...ex, questions, intro: copy.intro, closing: copy.closing }), own) },
    { id: "reminder", name: "Reminder", when: `If there is no reply in ${REMIND_AFTER_HOURS} hours; sent once`, ...paragraphs(renderQualifyReminder(ex)) },
    { id: "followup", name: "Follow-up", when: "If details are still missing after their reply; asked once", ...paragraphs(renderQualifyVerify({ ...ex, questions: ["Only the details still missing"], intro: `Thanks for your reply. To put you forward to ${ex.company} I still need a few things:`, closing: "Thank you. That is all I need before I put you forward." })) },
    { id: "confirm", name: "Confirm", when: `When every detail is in; only a reply of just YES goes on, at most ${CONFIRM_ASKS} confirms`, ...paragraphs(renderQualifyConfirm({ ...ex, facts })) },
    { id: "putforward", name: "Put forward", when: `Right after they are submitted to ${partner}`, ...paragraphs(renderQualifyPutForward(ex)) },
    { id: "closed", name: "Closed", when: "When they say no, the role closes, pay is above the band, or there is no plain YES", ...paragraphs(renderQualifyClosed(ex)) },
  ];
  const model = (k, d) => String(env[k] || d);
  return {
    example: ex,
    variables: TEMPLATE_VARIABLES,
    // who each email is from and to: the sender the server sends as, and the person
    sender: String(env.CHARLIE_FROM || "").trim() || null,
    recipient: "{name}",
    needs: ADAPTERS[connection?.source?.type]?.needs ?? [],
    // a connection line the email will not use (a dash, a promise, a banned word, an unknown field, the length): said,
    // so the screen never shows a rejected line as if it were sent
    verify_issues: copy.issues,
    audience: [`People the candidate scorer passes (${String(env.CANDIDATE_SCORER || "").trim() || "pieworks"})`, "Never anyone a person passed on", "In your pool, and agreed to hear about other roles", "Never anyone unsubscribed, paused or not looking", "Inside the role's years of experience"],
    copy_rules: "You can use {name}, {role}, {company}, {city} and {partner}. A line with a dash, a promise of a job or pay, the words screening, record, status or dossier, an unknown {field}, or under 20 or over 400 characters is not used; Charlie's wording goes out instead.",
    timings: { full_pass_hours: FULL_PASS_HOURS, reply_minutes: Number(AGENTS.outreach.every_minutes), remind_after_hours: REMIND_AFTER_HOURS, close_after_hours: CLOSE_AFTER_HOURS, confirm_asks: CONFIRM_ASKS, evaluations_per_pass: EVALUATIONS_PER_PASS },
    emails,
    abilities: [
      { id: "judge", name: "Scores fit", what: `Asks the candidate scorer about each person, up to ${EVALUATIONS_PER_PASS} new people per role per pass`, model: `Scorer: ${String(env.CANDIDATE_SCORER || "").trim() || "pieworks"}` },
      { id: "answers", name: "Reads answers", what: "Files each reply against the questions, word for word", model: model("HIRE_MANDATE_ANSWERS_MODEL", "claude-haiku-4-5-20251001") },
      { id: "note", name: "Writes the note", what: "Only from their own words, then checked against them", model: model("HIRE_WHY_MODEL", "claude-sonnet-4-6") },
      { id: "check", name: "Checks the note", what: "Drops any claim their words do not support", model: model("VERIFY_MODEL", "claude-haiku-4-5") },
      { id: "submit", name: "Submits", what: `Hands the confirmed details, the CV and the note to ${partner}, once per person per role`, model: "No AI" },
    ],
    guardrails: [
      "Their yes to this company, for this role, before anything else",
      "A reply of just YES to the exact details before anything is handed off",
      // the code refuses a put-forward without it (lib/qualify/agent.mjs)
      "Put forward only once a person approved them in the Inbox",
      "Never anyone unsubscribed, paused or not looking",
      "One conversation per person at a time",
      "No emails in quiet hours, and never past the daily limit",
      "The note says only what their own words say",
    ],
  };
}
