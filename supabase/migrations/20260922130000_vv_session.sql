-- Voice verification, migration 2 of 3: candidate, session, invitation, consent, conversation,
-- canonical transcript, events. Applied by hand in the Supabase SQL editor, then `npm run db:types`.
-- Migration 1 (20260922120000_vv_plan.sql) must be applied first.
--
-- WHY vv_candidates IS NOT candidates. `candidates` is the email product: its `status` decides who
-- receives a role email. A person who takes a voice verification has not asked for that, and the
-- one way to guarantee they never get it is a table the role mailer has never heard of.
--
-- WHY kind IS A CHECK CONSTRAINT AND NOT A CONVENTION. A test session (HR acting as the candidate)
-- runs the identical pipeline and must never become evidence about a real person. The constraint
-- says a test session cannot reference a candidate and a candidate session cannot lack one; every
-- table below hangs off the session, so the distinction is inherited, not repeated.
--
-- TWO RECORDS OF A CONVERSATION, KEPT APART. The live path logs each turn as a vv_events row of
-- type turn.recorded (operational: what the provider delivered mid-call, the plan item, the move,
-- latency, whether the fallback fired). vv_turns is the CANONICAL transcript only, written after the
-- call from the provider's post-call transcript with per-turn STT confidence, timestamps and the
-- audio reference. Evidence extraction reads vv_turns and nothing else.
--
-- WHY version IS ON vv_sessions. The live controller writes the cursor once per turn. Two instances
-- writing one session must not interleave; a stale write is refused by comparing version, and the
-- refused turn is covered by the scripted fallback, never retried.
--
-- WHY vv_events HAS NO UPDATE. It is the audit log. Rows leave it only when the candidate's data is
-- deleted, through the cascade from vv_sessions, which is a consent operation.

create table if not exists vv_candidates (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique check (email = lower(email)),
  name_as_given text,             -- exactly as the hiring team wrote it
  cv_ref        text,             -- storage object path, null when no CV was provided
  created_at    timestamptz not null default now()
);

create table if not exists vv_sessions (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('candidate', 'test')),
  candidate_id uuid references vv_candidates(id) on delete cascade,
  tester_email text,
  plan_id      uuid not null references vv_plans(id) on delete restrict,
  state        text not null default 'invited' check (state in (
                 'invited', 'consented', 'in_progress', 'completed', 'transcript_ready', 'evidence_ready',
                 'evaluated', 'blocked', 'awaiting_review', 'reviewed', 'reported',
                 'declined', 'unreachable', 'expired', 'abandoned')),
  cursor       jsonb not null default '{}'::jsonb,   -- the controller's position; shape is voice/controller.mjs
  conditions   jsonb not null default '{}'::jsonb,   -- audio band, fallback rate, judge availability, mismatch flags
  version      integer not null default 1,           -- optimistic write; a stale cursor write is refused
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint vv_sessions_kind_shape check (
    (kind = 'test'      and candidate_id is null     and tester_email is not null) or
    (kind = 'candidate' and candidate_id is not null and tester_email is null)
  )
);

create index if not exists vv_sessions_candidate_idx on vv_sessions (candidate_id);
create index if not exists vv_sessions_kind_state_idx on vv_sessions (kind, state);

create table if not exists vv_invitations (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references vv_sessions(id) on delete cascade,
  token_hash text not null unique,   -- never the token
  expires_at timestamptz not null,
  sent_at    timestamptz,
  opened_at  timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists vv_consents (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references vv_sessions(id) on delete cascade,
  scope        text not null check (scope in ('recording', 'retention', 'pool')),
  text_version text not null,        -- the exact consent text shown, by version (voice/consent.mjs)
  granted      boolean not null,
  recorded_at  timestamptz not null default now(),
  user_agent   text
);

create index if not exists vv_consents_session_idx on vv_consents (session_id, scope, recorded_at desc);

create table if not exists vv_conversations (
  id                       uuid primary key default gen_random_uuid(),
  session_id               uuid not null references vv_sessions(id) on delete cascade,
  provider_conversation_id text not null unique,   -- ElevenLabs conversation_id; ingest is idempotent on it
  started_at               timestamptz not null default now(),
  ended_at                 timestamptz,
  end_reason               text,
  raw_payload_ref          text,                   -- storage path of the post-call webhook payload, stored before anything else
  audio_ref                text,                   -- storage path of the post-call audio
  transcript_hash          text                    -- sha256 of the canonical turns, once written
);

create table if not exists vv_turns (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references vv_conversations(id) on delete cascade,
  seq             integer not null,
  speaker         text not null check (speaker in ('agent', 'candidate')),
  text            text not null,
  t_start         numeric,                         -- seconds into the conversation
  t_end           numeric,
  stt_confidence  numeric,                         -- provider-reported where available
  usable          boolean not null default true,   -- false: too unreliable to found evidence, a contradiction, or a marker
  plan_item_id    uuid references vv_plan_items(id) on delete restrict,
  move            text,
  superseded_by   uuid references vv_turns(id),    -- set when a candidate restarted the item
  unique (conversation_id, seq)
);

create table if not exists vv_events (
  id         bigserial primary key,
  session_id uuid not null references vv_sessions(id) on delete cascade,
  kind       text not null check (kind in ('candidate', 'test')),   -- copied from the session so analytics can filter without a join
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);

create index if not exists vv_events_session_idx on vv_events (session_id, at);
create index if not exists vv_events_kind_type_idx on vv_events (kind, type, at);

create or replace function vv_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'vv_events is append-only';
end $$;

drop trigger if exists vv_events_append_only on vv_events;
create trigger vv_events_append_only before update on vv_events
  for each row execute function vv_events_append_only();

create or replace function vv_sessions_touch() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists vv_sessions_touch on vv_sessions;
create trigger vv_sessions_touch before update on vv_sessions
  for each row execute function vv_sessions_touch();

alter table vv_candidates    enable row level security;
alter table vv_sessions      enable row level security;
alter table vv_invitations   enable row level security;
alter table vv_consents      enable row level security;
alter table vv_conversations enable row level security;
alter table vv_turns         enable row level security;
alter table vv_events        enable row level security;
-- No policies: the service role bypasses RLS; anon and authenticated get nothing.

comment on table vv_sessions is
  'One attempt of one candidate (kind=candidate) or one HR tester (kind=test) against one plan version. The kind constraint is what keeps test data out of candidate evidence, the pool, and analytics.';
comment on table vv_turns is
  'The CANONICAL post-call transcript, from the provider webhook, with per-turn STT confidence and a usable flag. Evidence extraction reads this and only this. The live per-turn log is vv_events type turn.recorded.';
comment on column vv_sessions.version is
  'Optimistic write for the cursor. A stale write is refused and the turn falls back to the scripted line; it is never retried.';
