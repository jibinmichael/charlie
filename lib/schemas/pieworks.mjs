// lib/schemas/pieworks.mjs — the Pieworks partner API's shapes (external data is parsed where it enters).
// Covers the partner API's Candidate Referral and Active Roles endpoints, the 2call webhook and the status update.
//
// IN: an active role and the activeRoles page. A role that does not parse is logged by id and skipped, never
// guessed. Fields the agent does not use are allowed through (passthrough), because the doc's own sample carries
// counts and display fields that may grow.
// OUT: the candidate part of submitReferral. Every field the doc marks required is required here, so a payload
// with a gap can never be built, let alone sent (a gap is asked of the person, never filled in).
import { z } from "zod";

const num = z.number().finite();
const numOrNull = num.nullable().optional();

export const PieworksRole = z
  .object({
    id: z.number().int().positive(),
    role: z.string().trim().min(1),
    clientName: z.string().trim().min(1),
    location: z.string().nullable().optional(),
    jobFamily: z.string().nullable().optional(),
    minExperience: numOrNull,
    maxExperience: numOrNull,
    minCtc: numOrNull,
    maxCtc: numOrNull,
    minVariablePay: numOrNull,
    maxVariablePay: numOrNull,
    mandatorySkill: z.string().nullable().optional(),
    okr: z.string().nullable().optional(),
    status: z.string().trim().min(1),
    noOfVaccancyPending: numOrNull,
    activeFrom: z.string().nullable().optional(),
    createdOn: z.string().nullable().optional(),
    sentToClients: numOrNull,
    interviews: numOrNull,
    interested: numOrNull,
    toCall: numOrNull,
    totalDiscoveries: numOrNull,
  })
  .passthrough();

/** The activeRoles envelope. The roles themselves are parsed one by one (PieworksRole), so one bad role never drops a page. */
export const PieworksRolesPage = z
  .object({
    result: z.number(),
    message: z.string().nullable().optional(),
    dataObject: z.object({ totalRows: z.number().int().nonnegative(), rows: z.number().int().nonnegative() }).passthrough().nullable(),
    dataArray: z.array(z.unknown()).nullable(),
  })
  .passthrough();

/** submitReferral's reply: 200 saved, 300 refused (the doc's example: "This candidate is already discovered for this role"). */
export const PieworksSubmitReply = z
  .object({
    result: z.number(),
    message: z.string().nullable().optional(),
  })
  .passthrough();

const text = z.string().trim().min(1);

/** The `candidate` multipart part, exactly the API's required fields. */
export const PieworksCandidate = z
  .object({
    experience: num.nonnegative(),
    linkedInUrl: z.string().trim().url(),
    name: text,
    currentCompany: text,
    emailId: z.string().trim().email(),
    phoneNo: z.string().trim().regex(/^\d{6,15}$/),
    countryCode: z.string().trim().regex(/^\+\d{1,4}$/),
    currentLocation: text,
    currentCtcFixed: num.nonnegative(),
    currentCtcVariable: num.nonnegative(),
    currentCtcTotal: num.nonnegative(),
    expectedCtc: num.nonnegative(),
    noticePeriod: z.string().trim().regex(/^\d{1,3}$/),
    referralCode: text,
    justification: z.string().trim().min(20).max(1500),
  })
  .strict()
  .refine((c) => Math.abs(c.currentCtcTotal - (c.currentCtcFixed + c.currentCtcVariable)) < 0.01, {
    message: "currentCtcTotal must equal currentCtcFixed + currentCtcVariable (doc 1.4.1)",
  });

// ── the 2call webhook and the status update ──────────────────────────────────────────────────────
//
// IN: one candidate of a webhook batch. Only what the activation needs is required (the ids, a name, an address);
// the rest of the doc's fields pass through untouched, because a record missing, say, currentCtcVariable is still a
// person who can be asked whether they are interested. A record that fails is logged by shortlistId and skipped.
// noticePeriod is a string in the doc's payload and a number in its curl example, so either is accepted.

export const PieworksWebhookCandidate = z
  .object({
    shortlistId: z.number().int().positive(),
    requirementId: z.number().int().positive(),
    name: text,
    emailId: z.string().trim().email(),
    noticePeriod: z.union([z.string(), num]).nullable().optional(),
    aiScoreReason: z.string().nullable().optional(),
  })
  .passthrough();

/** The webhook body: a JSON array, at most 10 per the doc; a little room is left, never an unbounded batch. */
export const PieworksWebhookBatch = z.array(z.unknown()).max(50);

/** OUT: the `shortlist` multipart part. Only "interested" (2) is ever sent: activation moves a person from 2call to interested only. */
export const PieworksShortlistUpdate = z
  .object({
    id: z.number().int().positive(),
    status: z.object({ id: z.literal(2), name: z.literal("interested") }).strict(),
  })
  .strict();
