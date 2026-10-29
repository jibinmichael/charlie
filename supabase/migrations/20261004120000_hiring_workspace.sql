-- Hiring workspace, migration 1: the job. Applied by hand in the Supabase SQL editor, then `npm run db:types`.
--
-- hire_jobs holds one job per employer-system role that Qualify & Submit works on (lib/qualify/roles.mjs creates
-- them; lib/qualify/jobs.mjs reads and writes them). last_search.qualify keeps the candidate scorer's answers for
-- the job (lib/qualify/wiring.mjs), so a person is scored once per role, scorer and brief.

create table if not exists hire_jobs (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  client      text,
  jd_text     text not null,
  jd_source   text,                                   -- '<connection key>:<role id>' for a synced role
  status      text not null default 'draft'
              check (status in ('draft', 'reviewing', 'approved', 'searching', 'ready')),
  last_search jsonb,                                  -- {qualify: {scorer, brief, scored: {candidate_id: {score, pass, reasons, at}}}}
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create or replace function hire_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists hire_jobs_touch on hire_jobs;
create trigger hire_jobs_touch before update on hire_jobs for each row execute function hire_touch();

alter table hire_jobs enable row level security;
-- No policies: the service role bypasses RLS; anon and authenticated get nothing.

grant select, insert, update, delete on hire_jobs to service_role;
grant select on hire_jobs to anon, authenticated;
