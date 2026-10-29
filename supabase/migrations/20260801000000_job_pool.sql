-- job_pool — the job pool as rows, so one posting can be read as one row.
--
-- The pool is otherwise a single Supabase storage object, `job-pool/latest.json`, which has two
-- problems at scale:
--
--   1. THE CEILING. Storage has a per-file size limit. When the upload fails, `saveJobPool` throws,
--      `engine:run`'s `&&` chain short-circuits, and the run completes having sent nothing.
--   2. THE READ. There is no way to read ONE posting from a blob: every consumer downloads and parses
--      the whole object, including the server routes that answer a question about a single role.
--
-- Rows fix both, and push region/family/freshness filters into SQL instead of the Node heap.
--
-- The columns are exactly the pool job shape already in the code: JOB_KEY_FIELDS
-- (lib/match-cache-key.mjs) plus the two timestamps scan-jobs stamps on every run. `description` is
-- capped at 2,500 chars by the writer so the fit readout can still see a JD's requirements.
--
-- Code is fail-open and dark: until this table exists AND POOL_TABLE=on, the seam no-ops and every
-- consumer reads the blob. A read error also falls back to the blob, and the blob keeps being written
-- in parallel.
--
-- Apply by hand in the Supabase SQL editor (service-role JS can't run DDL), then `npm run db:types`.

create table if not exists public.job_pool (
  id              text primary key,   -- the scanner's stable posting id ("<source>:<slug>:<jobid>")
  source          text,               -- ashby | greenhouse | lever | keka | kula | workday | amazon | ...
  company         text,
  slug            text,               -- the board slug within that source
  segment         text,               -- base | yc | india | workday
  title           text,
  location        text,
  remote          text,
  team            text,
  employment_type text,
  compensation    text,
  apply_url       text,
  posted_at       text,               -- kept as TEXT: feeds carry unparseable/absent dates and the
                                      -- scanner deliberately holds "unknown" apart from "stale"
  description     text,
  first_seen      timestamptz,
  last_seen       timestamptz
);

-- The read paths this table serves. `id` is the primary key (the single-row lookup). The rest back the
-- filters the pre-filter applies.
create index if not exists job_pool_company_idx   on public.job_pool (company);
create index if not exists job_pool_source_idx    on public.job_pool (source);
create index if not exists job_pool_posted_at_idx on public.job_pool (posted_at);
create index if not exists job_pool_last_seen_idx on public.job_pool (last_seen);

alter table public.job_pool enable row level security;
-- No anon policies: the service role bypasses RLS; anon/authenticated get nothing. The pool is not
-- secret, but it is also not a public API, and the site ships NEXT_PUBLIC_* keys only.
