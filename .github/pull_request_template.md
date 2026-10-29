<!-- CI must be green before merge (typecheck · lint · test · build · migration-guard). Never bypass or weaken a check to make it pass. -->

## Summary

<!-- What changed and why. Link any issue/spec. -->

## Checklist

- [ ] **Email templates changed?** Snapshot diffs reviewed (`npm run test:emails`); no unintended font/color/spacing change.
- [ ] **Database schema changed?** A **new** migration file was added under `supabase/migrations/` (never edit an applied one) **and** types were regenerated (`npm run db:types`).
- [ ] **Env vars added?** Added to `.env.example` **and** to the Vercel / Railway dashboards (server secrets never on Vercel).
- [ ] **Prompts or scoring logic changed?** The prompt lives in `prompts/` (or its `.md` rubric); model output is still validated against a `lib/schemas/` Zod schema.
- [ ] Grounding preserved (nothing invented/inflated) and no em dashes in user-facing copy.
- [ ] Claude review comments addressed.
