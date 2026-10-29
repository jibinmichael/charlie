// lib/schemas/india-seed.mjs — Zod schema for the curated India VC-portfolio seed list.
// Boundary: each row of data/india-seed.json (a hand-curated list of Indian startups), BEFORE
// india-ingest.mjs resolves it. name + website are required (website is what resolveAts probes);
// slug is an optional hint. A malformed row is skipped (fail-closed), never crashes the batch.
import { z } from "zod";

export const IndiaSeedCompany = z
  .object({
    name: z.string(), // human label on the resolved watchlist entry
    website: z.string(), // company homepage -> resolveAts()
    slug: z.string().nullish(), // optional ATS-slug hint
  })
  .passthrough();

export const IndiaSeed = z.array(IndiaSeedCompany);
