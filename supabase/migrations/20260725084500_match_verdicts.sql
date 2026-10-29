-- match_verdicts — incremental matching: the memoized daily match verdict.
--
-- Most of the job pool is the same roles day to day. A match verdict is a pure function of its inputs
-- (model + matcher rubric + dossier + posting content), so it is memoized here: one row per cache_key (see
-- lib/match-cache-key.mjs) holds the scored output. On the next run, a pair whose inputs are unchanged
-- reads its verdict instead of paying to re-score it. Same score, not an approximation — zero quality
-- change. Any real change (dossier edit, rubric change, edited posting, model swap) yields a new
-- cache_key and re-scores; a short TTL on the read side re-scores anything older than N days.
--
-- Code is fail-open and dark: until this table exists AND MATCH_CACHE=on, the cache seam no-ops and
-- matching scores every pair. A cache read/write error also falls back to
-- full scoring — the cache can only make a run cheaper, never wrong.
--
-- Apply by hand in the Supabase SQL editor (service-role JS can't run DDL), then `npm run db:types`.

create table if not exists public.match_verdicts (
  cache_key text primary key,          -- sha-256 over (version, model, matcher, dossier, semantic job fields)
  email     text not null,             -- the person the verdict is for (for pruning + observability)
  output    jsonb not null,            -- the MatchOutput verdict (score, verdict, chips, why_you, ...)
  scored_at timestamptz not null default now()
);

-- Prune / TTL scans go by age; per-person invalidation (a dossier change already changes the key, but
-- an explicit purge on account deletion goes by email).
create index if not exists match_verdicts_scored_at_idx on public.match_verdicts (scored_at);
create index if not exists match_verdicts_email_idx on public.match_verdicts (email);

alter table public.match_verdicts enable row level security;
-- No anon policies: the service role bypasses RLS; anon/authenticated get nothing.
