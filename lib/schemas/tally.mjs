// lib/schemas/tally.mjs — the boundary for everything that comes back from Tally.
//
// Tally is where applicants to a posted role answer, and it is the first external service whose
// payload describes a REAL PERSON we will then write about. So the schema does two jobs: it refuses a
// structurally broken payload, and it names the shape the rest of the pipeline is allowed to assume.
//
// THE ONE THING TO KNOW ABOUT THIS API. A submission's answers are NOT keyed by question title. Each
// response carries a `questionId`, and the titles live in a separate `questions` array on the same
// page of results. Joining them is the caller's job, and getting it wrong does not throw: it silently
// yields empty answers for everybody, which looks completely plausible. `answersByTitle` below is the only
// supported way to read a submission, so nothing can re-derive the join by hand and get it wrong.
//
// FAIL PER RECORD, NEVER PER BATCH: a submission that does not parse is logged with its id and
// skipped. One malformed row must not cost the rest.

import { z } from "zod";

/** One answer. `answer` is the field that holds the value; there is no `value` field, whatever it looks like. */
export const TallyResponse = z.object({
  questionId: z.string(),
  answer: z.unknown().nullish(),
}).passthrough();

/** A question definition, as returned alongside the submissions. */
export const TallyQuestion = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string().default("UNKNOWN"),
}).passthrough();

/**
 * One submission.
 *
 * `isCompleted` is Tally's own flag and means "reached the end of the form", which is NOT the same as
 * "answered the things we need". On a form where no field is marked required, a person can be
 * isCompleted:true having answered almost nothing. Completeness is our judgement, made downstream
 * against a named required set, and never read off this flag.
 */
export const TallySubmission = z.object({
  id: z.string(),
  respondentId: z.string().nullish(),
  isCompleted: z.boolean().default(false),
  submittedAt: z.string().nullish(),
  createdAt: z.string().nullish(),
  responses: z.array(TallyResponse).default([]),
}).passthrough();

/** One page of `GET /forms/:id/submissions`. */
export const TallySubmissionsPage = z.object({
  page: z.number().nullish(),
  hasMore: z.boolean().default(false),
  questions: z.array(TallyQuestion).default([]),
  submissions: z.array(TallySubmission).default([]),
}).passthrough();

/**
 * Flatten one answer to a string.
 *
 * Checkboxes, dropdowns and file uploads all come back as arrays of objects rather than scalars, and
 * each uses a different key for the human-readable part. A missing answer and an answer we could not
 * read both become "", because for every use here they mean the same thing: we do not have it.
 */
export function answerText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((v) => (v && typeof v === "object" ? (v.name ?? v.text ?? v.label ?? v.value ?? "") : v))
      .filter((v) => v !== "" && v != null)
      .map(String)
      .join(" | ");
  }
  if (typeof value === "object") return String(value.name ?? value.text ?? value.value ?? "");
  return String(value);
}

/**
 * A submission as { question title -> answer text }. The ONLY supported way to read one.
 *
 * @param {object} submission a parsed TallySubmission
 * @param {Map<string,string>} titleById  questionId -> title, built by titleIndex()
 */
export function answersByTitle(submission, titleById) {
  const out = {};
  for (const r of submission.responses || []) {
    const title = titleById.get(r.questionId);
    if (!title) continue; // a question deleted from the form after this person answered it
    const text = answerText(r.answer);
    // Keep the first non-empty. A form edited mid-flight can yield two ids with the same title.
    if (!out[title] || (!String(out[title]).trim() && String(text).trim())) out[title] = text;
  }
  return out;
}

/** questionId -> title, from a page's `questions` array. */
export function titleIndex(questions) {
  return new Map((questions || []).map((q) => [q.id, q.title]));
}

/**
 * The forms list: GET https://api.tally.so/forms
 *
 * Ad-hoc parsing (`j.items || j.forms || j`) would not fail if Tally reshapes the response or emits a
 * numeric id; it would silently produce a shorter or empty list of form ids, and a caller reading four
 * forms instead of eight would report "nothing is wrong".
 *
 * The wrapper key has genuinely varied across Tally's own docs, so both shapes are accepted and a
 * bare array is too. What is NOT optional is that every id is a non-empty string.
 */
export const TallyForm = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  status: z.string().optional(),
  numberOfSubmissions: z.number().optional(),
}).passthrough();

export const TallyFormsPage = z.union([
  z.object({ items: z.array(TallyForm) }).passthrough(),
  z.object({ forms: z.array(TallyForm) }).passthrough(),
  z.array(TallyForm),
]).transform((v) => (Array.isArray(v) ? v : (v.items || v.forms)));
