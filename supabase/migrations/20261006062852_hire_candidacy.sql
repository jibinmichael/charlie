-- hire_candidacy — the candidacy lifecycle. Applied by hand in the Supabase SQL editor, then `npm run db:types`.
--
-- 1. hire_orgs                  the organisation (tenant): an employer or a recruiting agency. Seeded with Charlie, which
--                               is the default owner. Every hiring row carries org_id.
-- 2. org_id                     on hire_jobs, hire_connections and hire_qualify_threads, defaulting to 'charlie', so
--                               every existing row belongs to Charlie and nothing changes for it.
-- 3. hire_candidacy_events      every change to a candidacy, appended and never edited: what happened, from what stage
--                               to what, who caused it (an agent, a person, the candidate, the employer or the system),
--                               why, the message or approval it rests on. The Inbox timeline is read from here.
-- 4. hire_candidacy_proposals   what an agent may not do alone and asks a person for ("Needs you"): currently, closing
--                               someone as not a fit. A person approves or keeps them; the decision is recorded.
-- 5. hire_qualify_threads       a new stage 'held' (waiting for a person's decision on a proposal) and `overrides`, the
--                               decisions a person made that the agent must respect ({keep: {gate, fit, pay}}).
--
-- Code reading these fails open: until this is applied, Qualify & Submit runs without them.

create table if not exists hire_orgs (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name        text not null,
  kind        text not null default 'employer' check (kind in ('employer', 'agency', 'charlie')),
  created_at  timestamptz not null default now()
);
insert into hire_orgs (id, name, kind) values ('charlie', 'Charlie', 'charlie') on conflict (id) do nothing;

alter table hire_jobs            add column if not exists org_id text not null default 'charlie' references hire_orgs(id);
alter table hire_connections     add column if not exists org_id text not null default 'charlie' references hire_orgs(id);
alter table hire_qualify_threads add column if not exists org_id text not null default 'charlie' references hire_orgs(id);
create index if not exists hire_jobs_org on hire_jobs (org_id);
create index if not exists hire_connections_org on hire_connections (org_id);
create index if not exists hire_qualify_threads_org on hire_qualify_threads (org_id);

alter table hire_qualify_threads add column if not exists overrides jsonb not null default '{}'::jsonb;
alter table hire_qualify_threads drop constraint if exists hire_qualify_threads_stage_check;
alter table hire_qualify_threads add constraint hire_qualify_threads_stage_check
  check (stage in ('verify_sent', 'reminded', 'answered', 'held', 'confirming', 'ready', 'submitting', 'submitted', 'closed', 'failed'));

create table if not exists hire_candidacy_events (
  id            uuid primary key default gen_random_uuid(),
  org_id        text not null default 'charlie' references hire_orgs(id),
  job_id        uuid not null references hire_jobs(id) on delete cascade,
  thread_id     uuid references hire_qualify_threads(id) on delete cascade,
  candidate_id  uuid,                                 -- the person (lib/qualify/wiring.mjs candidateIdFor)
  type          text not null,                        -- e.g. stage.changed, proposal.made, proposal.decided
  actor_type    text not null check (actor_type in ('agent', 'person', 'candidate', 'employer', 'system')),
  actor_id      text,                                 -- the agent id, the person, the candidate's address, 'workspace'
  from_stage    text,
  to_stage      text,
  reason        text,
  ref           text,                                 -- the message id or run id it rests on
  approval_id   uuid,                                 -- the proposal a person decided, when there was one
  at            timestamptz not null default now()
);
create index if not exists hire_candidacy_events_thread on hire_candidacy_events (thread_id, at);
create index if not exists hire_candidacy_events_org on hire_candidacy_events (org_id, at desc);

-- Append-only. A delete is allowed only when the thread or the job itself is gone.
create or replace function hire_candidacy_events_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then raise exception 'hire_candidacy_events is append-only'; end if;
  if old.thread_id is not null and exists (select 1 from hire_qualify_threads where id = old.thread_id) then raise exception 'hire_candidacy_events is append-only'; end if;
  return old;
end $$;
drop trigger if exists hire_candidacy_events_guard on hire_candidacy_events;
create trigger hire_candidacy_events_guard before update or delete on hire_candidacy_events for each row execute function hire_candidacy_events_guard();

create table if not exists hire_candidacy_proposals (
  id            uuid primary key default gen_random_uuid(),
  org_id        text not null default 'charlie' references hire_orgs(id),
  job_id        uuid not null references hire_jobs(id) on delete cascade,
  thread_id     uuid not null references hire_qualify_threads(id) on delete cascade,
  kind          text not null check (kind in ('close_not_fit')),
  check_id      text not null check (check_id in ('gate', 'fit', 'pay')),   -- which check would close them
  proposed_by   text not null,                        -- the agent id
  reason        text not null,
  evidence      jsonb not null default '{}'::jsonb,   -- what the check read: fit label, gate status, pay figures
  status        text not null default 'pending' check (status in ('pending', 'approved', 'kept', 'void')),
  decided_by    text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
-- one open question per thread at a time
create unique index if not exists hire_candidacy_proposals_open on hire_candidacy_proposals (thread_id) where status = 'pending';
create index if not exists hire_candidacy_proposals_org on hire_candidacy_proposals (org_id, status, created_at desc);

alter table hire_orgs enable row level security;
alter table hire_candidacy_events enable row level security;
alter table hire_candidacy_proposals enable row level security;
