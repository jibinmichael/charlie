// lib/schemas/vv-dashboard.mjs — the shapes of what the dashboard sends to /voice/api/*. Dashboard
// input is external data; it is safeParse'd in server/voice.ts before anything reads it.
import { z } from "zod";
import { STATUSES } from "../../voice/statuses.mjs";

/** A new job: the mandate, HR's questions, and the session length HR chose (default 600). */
export const JobInput = z.object({
  role: z.string().trim().min(2).max(120),
  client: z.string().trim().max(120).nullable().default(null),
  contact_email: z.string().trim().email(),
  // The mandate: pasted text, or an attached file the server reads verbatim with
  // server/resume-extract.mjs (pdf, docx, txt, rtf, md). One of the two is required.
  jd_text: z.string().trim().min(40).max(60000).optional(),
  jd_file: z.object({ name: z.string().trim().min(1).max(200), base64: z.string().min(16).max(14_000_000) }).optional(),
  questions: z.array(z.string().trim().min(3).max(400)).max(20).default([]),
  session_budget_seconds: z.number().int().min(60).max(7200),
  next_step_text: z.string().trim().max(400).nullable().default(null),
}).refine((b) => Boolean(b.jd_text) || Boolean(b.jd_file), { message: "jd_text or jd_file is required", path: ["jd_text"] });

export const ApproveInput = z.object({
  by: z.string().trim().email(),
  override: z.string().trim().min(3).max(300).nullable().default(null),
});

/** A candidate to invite, or an HR tester for a test session. The CV is required for a candidate. */
export const CandidateInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("candidate"),
    email: z.string().trim().email(),
    name: z.string().trim().min(1).max(120),
    cv_text: z.string().trim().min(40).max(60000),
    expires_in_days: z.number().int().min(1).max(30).default(7),
  }),
  z.object({
    kind: z.literal("test"),
    tester_email: z.string().trim().email(),
    // The Studio's name for this role-play ("strong candidate", "refuses"); stored in vv_sessions.conditions.label.
    label: z.string().trim().max(80).nullable().default(null),
    cv_text: z.string().trim().max(60000).nullable().default(null),
    expires_in_days: z.number().int().min(1).max(30).default(7),
  }),
]);

export const DISAGREEMENT_REASONS = ["evidence_missed", "evidence_insufficient", "evaluator_rule_incorrect", "mandate_ambiguous", "candidate_answer_ambiguous"];

/** One reviewer's pass over one report: the ground-truth row (vv_reviews). */
export const ReviewInput = z.object({
  reviewer: z.string().trim().email(),
  report_version: z.number().int().min(1).default(1),
  per_signal: z.array(z.object({
    signal_id: z.uuid(),
    human_status: z.enum(STATUSES),
    disagreement_reason: z.enum(DISAGREEMENT_REASONS).nullable().default(null),
    note: z.string().trim().max(600).nullable().default(null),
  })).min(1).max(40),
  evidence_lift: z.object({
    evidence_ids_new_beyond_cv: z.array(z.uuid()).max(100).default([]),
    note: z.string().trim().max(1200).nullable().default(null),
  }).default({ evidence_ids_new_beyond_cv: [], note: null }),
});

// ── the talent pool row the board receives (GET /voice/api/pool) ─────────────
// One person as the board shows them. Every field is nullable because the record may be thin;
// nothing is filled in to look complete. The consent booleans travel with the row so no view can
// hide them: the facts a decision turns on must be in front of the reader.
const nstr = z.string().nullable();
const nnum = z.number().nullable();
export const PoolPerson = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: nstr,
  phone: nstr,
  linkedin_url: nstr,
  portfolio_url: nstr,
  current_title: nstr,
  current_company: nstr,
  previous_title: nstr,
  previous_company: nstr,
  headline: nstr,
  total_years: nnum,
  roles_count: nnum,
  current_tenure_months: nnum,
  seniority: nstr,
  role_family: nstr,
  city: nstr,
  country: nstr,
  willing_to_relocate: nstr,
  work_mode_pref: nstr,
  notice_period_raw: nstr,
  notice_days: nnum,
  seeking_status: nstr,
  available_from: nstr,
  comp_current: nnum,
  comp_expected: nnum,
  comp_currency: nstr,
  mobility_profile: nstr,
  top_skills: z.array(z.string()),
  domains: z.array(z.string()),
  consent_process: z.boolean(),
  consent_share: z.boolean(),
  consent_pool: z.boolean(),
  source_form: nstr,
  source_role: nstr,
  applied_at: nstr,
  completeness: nnum,
  enriched_at: nstr,
});
export const PoolResponse = z.object({ people: z.array(PoolPerson), total: z.number().int(), skipped: z.number().int() });
