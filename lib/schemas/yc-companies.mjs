// lib/schemas/yc-companies.mjs — Zod schema for the RAW YC company objects Charlie ingests.
// External boundary: each item in https://yc-oss.github.io/api/companies/hiring.json, BEFORE
// yc-ingest.mjs reads it. Only the fields the ingester actually uses are typed; .passthrough()
// keeps the many fields we ignore. A structurally broken item is caught and that record is
// skipped (fail-closed), never turned into a bad watchlist entry.
import { z } from "zod";

// hiring.json items: name + website are what we need (name to label, website to resolve the ATS
// board). status/isHiring/regions are read as filters; all nullish so a missing field just fails
// the filter rather than crashing the batch.
export const YcCompany = z
  .object({
    name: z.string(), // required: the human label on the watchlist entry
    website: z.string().nullish(), // company homepage -> resolveAts(); missing => unresolvable, queued
    slug: z.string().nullish(), // YC's own slug (used only for logging/queue keys, NOT the ATS token)
    status: z.string().nullish(), // "Active" | "Acquired" | "Public" | "Inactive"
    isHiring: z.boolean().nullish(),
    regions: z.array(z.string()).nullish(), // e.g. ["America / Canada"], ["India"]
    batch: z.string().nullish(),
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof YcCompany>} YcCompanyItem */
