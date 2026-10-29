-- finds send-time context. Without these, an outcome cannot be attributed to the decision that
-- produced it. All three are nullable + additive; older rows stay null (no slot/version is guessed
-- for a role decided before the columns existed).
--
--   slot            : the role's 1-based rank in the matcher's ordered candidate list for that run
--                     (1 = the matcher's top pick). It answers "do rank-1 roles out-convert rank-5,
--                     or is the matcher shuffling?". For a solo
--                     role email it is the sent role's rank among that run's candidates; for a digest
--                     near-miss it is that role's rank. NOTE: this is matcher rank, not the cosmetic
--                     display order of the weekly digest — the display order for un-sent near-misses is
--                     undefined at write time, and rank is what attribution actually needs.
--   matcher_version : the matcher/scoring version at write time (lib/matcher-version.mjs, MATCHER_VERSION).
--                     Bumped on any matcher-rubric / scorer / selection change so outcomes can be split
--                     by which decision logic produced them.
--   sent_variant    : nullable, reserved for an A/B of the send itself. Currently written null.
--
-- Written by upsertFind (charlie-store.mjs), which degrades gracefully (retries the write WITHOUT these
-- columns and warns) if this migration has not been applied yet — so deploy/migration order can never
-- fail-to-zero the daily send. Applied by hand in the Supabase SQL editor; run `npm run db:types` after.

alter table public.finds
  add column if not exists slot smallint,
  add column if not exists matcher_version text,
  add column if not exists sent_variant text;
