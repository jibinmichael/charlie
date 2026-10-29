-- Hiring workspace: the candidate lifecycle. Apply in a dev database first, then `npm run db:types`.
-- The state machine is lib/hire-lifecycle.mjs; this only stores what it decides.
--
-- 1. hire_people: one identity per person, whatever source found them (lib/hire-people.mjs).
-- 2. hire_pursuits: one row per person × job. Current state only; the five dimensions are kept apart.
--    The CHECK lists below must equal the code's enums (lib/hire-pursuit-store.test.mjs parses them).
-- 3. hire_pursuit_keys: every reply key Charlie minted, so a reply resolves to exactly one pursuit.
-- 4. hire_pursuit_events: the append-only record of every transition; updates and deletes refused.
-- 5. hire_pursuit_create / hire_pursuit_apply: the only writes. apply moves the row and records the
--    event in one transaction, refused if the row moved since it was read (seq is the lock).
-- Defence in depth: a trigger refuses any row that is with the employer without THIS job's and THIS
-- employer's consent, whatever code wrote it. Nothing here touches talent_pool. The employer is
-- hire_jobs.client as shown at creation (there is no employer table).

create table if not exists hire_people (
  id              uuid primary key default gen_random_uuid(),
  linkedin_key    text unique,
  email           text unique check (email is null or email = lower(email)),
  full_name       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
  -- no "at least one key" CHECK: lib/hire-people.mjs already refuses a record with no key.
);

create table if not exists hire_pursuits (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references hire_jobs(id) on delete cascade,
  person_id         uuid not null references hire_people(id) on delete restrict,
  employer          text not null check (length(trim(employer)) > 0),
  source            text not null check (source in ('pool', 'sourced')),
  source_at         timestamptz,
  discovery_run     text,
  outreach_type     text not null check (outreach_type in ('warm', 'cold')),
  contact           jsonb not null,
  engagement        text not null check (engagement in ('NOT_CONTACTED', 'AWAITING_REPLY', 'INTERESTED', 'NOT_INTERESTED', 'NO_RESPONSE', 'UNREACHABLE', 'WITHDREW', 'OPTED_OUT')),
  screening_consent jsonb not null check (screening_consent->>'state' in ('NOT_REQUESTED', 'REQUESTED', 'GRANTED', 'DENIED', 'WITHDRAWN')),
  disclosure        jsonb not null check (disclosure->>'state' in ('NOT_REQUESTED', 'REQUESTED', 'GRANTED', 'DENIED', 'WITHDRAWN')),
  screening         jsonb not null check (screening->>'state' in ('NOT_REQUIRED', 'REQUIRED', 'REQUESTED', 'IN_PROGRESS', 'INCOMPLETE', 'COMPLETED', 'EXPIRED')),
  handoff           text not null check (handoff in ('NOT_HANDED_OFF', 'HANDED_OFF', 'EMPLOYER_PROGRESSING', 'EMPLOYER_DECLINED', 'RECALLED')),
  ask               jsonb,                                -- the open question, or null
  waiting_for       text check (waiting_for in ('INTEREST', 'CV', 'SCREENING_CONSENT', 'DISCLOSURE_CONSENT', 'SCREENING_ANSWER', 'CALL', 'EMPLOYER_FEEDBACK')),
  due_at            timestamptz,                          -- ask.due_at, so the sweep is one indexed query
  sent_to           text,
  to_read           jsonb,
  closed_out        boolean not null default false,
  seq               integer not null default 0,           -- events applied; the optimistic lock
  version           text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (job_id, person_id),
  check ((ask is null) = (waiting_for is null)),
  check (engagement <> 'OPTED_OUT' or ask is null)
);
create index if not exists hire_pursuits_due on hire_pursuits (due_at) where due_at is not null;
create index if not exists hire_pursuits_person on hire_pursuits (person_id);

create or replace function hire_pursuits_guard() returns trigger language plpgsql as $$
begin
  if new.handoff in ('HANDED_OFF', 'EMPLOYER_PROGRESSING') and (
       new.disclosure->>'state' is distinct from 'GRANTED'
       or new.disclosure->>'job_id' is distinct from new.job_id::text
       or new.disclosure->>'employer_id' is distinct from new.employer
       or coalesce(new.disclosure->>'evidence', '') = '') then
    raise exception 'hire_pursuits %: with the employer without this job''s and this employer''s consent', new.id;
  end if;
  if tg_op = 'UPDATE' and (new.job_id <> old.job_id or new.person_id <> old.person_id or new.employer <> old.employer or new.source <> old.source) then
    raise exception 'hire_pursuits %: job, person, employer and source never change', old.id;
  end if;
  return new;
end $$;
drop trigger if exists hire_pursuits_guard on hire_pursuits;
create trigger hire_pursuits_guard before insert or update on hire_pursuits for each row execute function hire_pursuits_guard();
drop trigger if exists hire_pursuits_touch on hire_pursuits;
create trigger hire_pursuits_touch before update on hire_pursuits for each row execute function hire_touch();
drop trigger if exists hire_people_touch on hire_people;
create trigger hire_people_touch before update on hire_people for each row execute function hire_touch();

create table if not exists hire_pursuit_keys (
  key        text primary key,
  pursuit_id uuid not null references hire_pursuits(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists hire_pursuit_keys_pursuit on hire_pursuit_keys (pursuit_id);

create table if not exists hire_pursuit_events (
  id          uuid primary key default gen_random_uuid(),
  pursuit_id  uuid not null references hire_pursuits(id) on delete cascade,
  seq         integer not null,
  type        text not null,
  actor       text not null check (actor in ('candidate', 'operator', 'employer', 'charlie', 'system')),
  at          timestamptz not null,
  ref         text,
  from_state  jsonb,
  to_state    jsonb,
  effects     jsonb not null default '[]'::jsonb,
  version     text not null,
  recorded_at timestamptz not null default now(),
  unique (pursuit_id, seq)
);

-- Append-only. A delete is allowed only when the pursuit itself is gone (its job was deleted).
create or replace function hire_pursuit_events_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then raise exception 'hire_pursuit_events is append-only'; end if;
  if exists (select 1 from hire_pursuits where id = old.pursuit_id) then raise exception 'hire_pursuit_events is append-only'; end if;
  return old;
end $$;
drop trigger if exists hire_pursuit_events_guard on hire_pursuit_events;
create trigger hire_pursuit_events_guard before update or delete on hire_pursuit_events for each row execute function hire_pursuit_events_guard();

create or replace function hire_pursuit_create(p_row jsonb, p_event jsonb) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into hire_pursuits (id, job_id, person_id, employer, source, source_at, discovery_run, outreach_type, contact,
    engagement, screening_consent, disclosure, screening, handoff, ask, waiting_for, due_at, sent_to, to_read, closed_out, seq, version)
  values ((p_row->>'id')::uuid, (p_row->>'job_id')::uuid, (p_row->>'person_id')::uuid, p_row->>'employer', p_row->>'source',
    (p_row->>'source_at')::timestamptz, p_row->>'discovery_run', p_row->>'outreach_type', p_row->'contact',
    p_row->>'engagement', p_row->'screening_consent', p_row->'disclosure', p_row->'screening', p_row->>'handoff',
    nullif(p_row->'ask', 'null'::jsonb), p_row->>'waiting_for', (p_row->>'due_at')::timestamptz, p_row->>'sent_to',
    nullif(p_row->'to_read', 'null'::jsonb), (p_row->>'closed_out')::boolean, 0, p_row->>'version')
  returning id into v_id;
  insert into hire_pursuit_events (pursuit_id, seq, type, actor, at, ref, from_state, to_state, effects, version)
  values (v_id, 0, p_event->>'type', p_event->>'actor', (p_event->>'at')::timestamptz, p_event->>'ref', null, null, '[]'::jsonb, p_event->>'version');
  return v_id;
end $$;

create or replace function hire_pursuit_apply(p_id uuid, p_expected_seq integer, p_row jsonb, p_event jsonb, p_new_keys text[]) returns integer language plpgsql as $$
declare n integer;
begin
  update hire_pursuits set
    contact = p_row->'contact', engagement = p_row->>'engagement', screening_consent = p_row->'screening_consent',
    disclosure = p_row->'disclosure', screening = p_row->'screening', handoff = p_row->>'handoff',
    ask = nullif(p_row->'ask', 'null'::jsonb), waiting_for = p_row->>'waiting_for', due_at = (p_row->>'due_at')::timestamptz,
    sent_to = p_row->>'sent_to', to_read = nullif(p_row->'to_read', 'null'::jsonb), closed_out = (p_row->>'closed_out')::boolean,
    version = p_row->>'version', seq = p_expected_seq + 1
  where id = p_id and seq = p_expected_seq;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'hire_pursuit_apply: % moved since it was read (expected seq %)', p_id, p_expected_seq using errcode = '40001';
  end if;
  insert into hire_pursuit_events (pursuit_id, seq, type, actor, at, ref, from_state, to_state, effects, version)
  values (p_id, p_expected_seq + 1, p_event->>'type', p_event->>'actor', (p_event->>'at')::timestamptz, p_event->>'ref',
    p_event->'from', p_event->'to', coalesce(p_event->'effects', '[]'::jsonb), p_event->>'version');
  if p_new_keys is not null and array_length(p_new_keys, 1) > 0 then
    insert into hire_pursuit_keys (key, pursuit_id) select k, p_id from unnest(p_new_keys) as k;
  end if;
  return p_expected_seq + 1;
end $$;

alter table hire_people enable row level security;
alter table hire_pursuits enable row level security;
alter table hire_pursuit_keys enable row level security;
alter table hire_pursuit_events enable row level security;
