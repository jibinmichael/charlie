-- Hiring workspace: whether a role is open. Applied by hand in the Supabase SQL editor, then
-- `npm run db:types`.
--
-- The employer's own switch on an approved role: active (sourcing and activation run), paused
-- (nothing new starts; what exists stays), closed (the role is over). It says nothing about the
-- brief, which keeps its own draft/approved versions, and nothing about any candidate.
alter table hire_jobs add column if not exists lifecycle text not null default 'active'
  check (lifecycle in ('active', 'paused', 'closed'));
