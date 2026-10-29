# data/india-seed.json — curated India VC-portfolio seed list

A hand-curated list of Indian startups that `india-ingest.mjs` resolves to live ATS boards and
tags `segment:"india"`. YC's own India-region list is small, so most India breadth comes from here.

## Format

A JSON array of company rows (validated by `lib/schemas/india-seed.mjs`):

```json
[
  { "name": "Razorpay", "website": "https://razorpay.com" },
  { "name": "Meesho", "website": "https://meesho.com", "slug": "meesho" }
]
```

- `name` (required) — the human label on the resolved watchlist entry.
- `website` (required) — the company homepage; `resolveAts()` probes it for a live board.
- `slug` (optional) — an ATS-slug hint if you know it (usually unnecessary; resolveAts derives it).

## Where to source companies

Public portfolio pages of India-focused VCs: Peak XV / Sequoia India, Accel India, Blume,
Elevation, Lightspeed India, Matrix / Z47, Nexus, Chiratae, Kalaari, etc. Names + websites only —
`india-ingest` does the rest and keeps only companies whose board `resolveAts()` can find on a
supported keyless ATS (Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Workable, Kula).
Keka boards need a tenant handshake that a slug probe cannot do, so they do not resolve from this
list. Companies on Darwinbox (not supported), Freshteam or Zoho Recruit do not resolve either.

## Notes

- Duplicates are harmless — `india-ingest` dedupes by website against the YC-India set, and by
  `source:slug` against the base watchlist, so nothing is scanned twice.
- Empty (`[]`) is valid: `india-ingest` then ingests only the YC India-region companies.
