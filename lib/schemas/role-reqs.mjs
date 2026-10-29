// lib/schemas/role-reqs.mjs — the structured HARD requirements extracted from a role's JD + ATS fields,
// the input to the knockout gate (eligibility-gate.mjs). External/derived-data boundary: role-reqs.mjs
// produces this, safeParse guards the shape before knockouts() reads it.
//
// EVERY field is nullable on purpose: an UNSTATED requirement must never manufacture a knockout. A JD
// that names no experience floor has min_years null → the experience knockout can never fire on it (we
// never invent a floor); comp unstated → the comp knockout never fires.
import { z } from "zod";

export const RoleReqs = z
  .object({
    // stated professional-experience floor in YEARS (the minimum the JD asks for), null when unstated.
    min_years: z.number().nullable(),
    // normalized employment type; null when neither the ATS field nor the JD makes it clear.
    employment_type: z.enum(["intern", "contract", "full_time", "part_time"]).nullable(),
    // stated comp band (same currency as comp_currency); null when the JD/ATS does not state it.
    comp_min: z.number().nullable(),
    comp_max: z.number().nullable(),
    comp_currency: z.string().nullable(),
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof RoleReqs>} RoleReqsType */
