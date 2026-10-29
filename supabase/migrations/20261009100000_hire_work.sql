-- hire_work — the work queue for hiring at volume. Applied by hand in the Supabase SQL editor, then
-- `npm run db:types`.
--
-- hire_work   one row per step of work (e.g. evaluate one candidate for one search). Read and written only by lib/work-store.mjs.
--   key           unique: the kind, the subject and its version, so enqueueing the same step twice is one row
--   status        pending → running (leased to one worker) → done | failed (after max_attempts)
--   run_after     not before this time: new work is now, a retry waits its backoff
--   lease_until   a running row whose lease has passed is claimable again (its worker died); attempts counts every claim
--   company       for per-company limits; null when the work has no company
--
-- hire_work_claim(kind, limit, worker, lease_seconds)   takes up to `limit` claimable rows of one kind for one worker,
-- skipping rows another worker holds (for update skip locked), so any number of workers can run side by side and no
-- row is worked twice at once. A row that has used all its attempts is never claimed; lib/work-store.mjs marks it failed.
--
-- Additive only: a new table and a new function. Nothing existing is changed.

create table if not exists hire_work (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (length(kind) between 3 and 80),
  key           text not null unique check (length(key) between 3 and 300),
  payload       jsonb not null default '{}'::jsonb,
  company       text,
  status        text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts      integer not null default 0,
  max_attempts  integer not null default 5 check (max_attempts between 1 and 20),
  run_after     timestamptz not null default now(),
  leased_by     text,
  lease_until   timestamptz,
  last_error    text,
  result        jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists hire_work_claimable on hire_work (kind, run_after) where status in ('pending', 'running');
create index if not exists hire_work_failed on hire_work (kind, updated_at) where status = 'failed';

alter table hire_work enable row level security;

create or replace function hire_work_claim(p_kind text, p_limit integer, p_worker text, p_lease_seconds integer)
returns setof hire_work
language sql
as $$
  update hire_work w
     set status = 'running',
         leased_by = p_worker,
         lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)),
         attempts = w.attempts + 1,
         updated_at = now()
   where w.id in (
     select id from hire_work
      where kind = p_kind
        and attempts < max_attempts
        and ((status = 'pending' and run_after <= now()) or (status = 'running' and lease_until < now()))
      order by run_after
      limit greatest(least(p_limit, 100), 0)
      for update skip locked
   )
  returning w.*;
$$;
