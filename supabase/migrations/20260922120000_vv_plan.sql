-- Voice verification, migration 1 of 3: the mandate and the verification plan.
-- Applied by hand in the Supabase SQL editor, then `npm run db:types`.
--
-- WHY THESE TABLES ARE PREFIXED vv_. The repo already has `candidates` (the email product; its
-- `status` decides who receives a role email) and `talent_pool` (the client boards). A person who
-- takes a voice verification is neither of those things, and a name collision is how they would
-- silently become one. Everything voice verification writes is vv_, and nothing in voice/ reads
-- or writes the other tables.
--
-- WHY THE PLAN IS IMMUTABLE ONCE APPROVED, IN THE DATABASE. A plan is what a candidate is asked
-- and what their evidence is read against. If it can change after a session ran, the session's
-- signals no longer say what they were computed from. So an approved plan can only move to
-- `superseded`, and its items cannot be inserted, updated, or deleted. A change is a new version.
-- The trigger is the rule; voice/plan.mjs checking it first is a courtesy.
--
-- WHY evidence_contract IS jsonb. Its shape is lib/schemas/vv-plan.mjs and it changes as the set of
-- elements that matter changes. A column per element would mean a migration per change.
--
-- WHY dropped IS STORED NEXT TO parsed. verifyQuotes removes every requirement whose quote is not
-- in the job description. A clean parse and a parse that silently lost three requirements look
-- identical without this column.

create table if not exists vv_mandates (
  id            uuid primary key default gen_random_uuid(),
  client        text,
  role          text not null,
  contact_email text not null,
  jd_text       text not null,
  hr_questions  jsonb not null default '[]'::jsonb,   -- [string], verbatim as HR wrote them
  next_step_text text,                                -- HR's own "what happens next" sentence, spoken at the close and put in the closing email; null = Charlie says it does not set the timeline
  parsed        jsonb,                                -- MandateParse output after verifyQuotes
  dropped       jsonb,                                -- what verifyQuotes removed, reported never silent
  status        text not null default 'parsed' check (status in ('parsed', 'parse_failed')),
  created_at    timestamptz not null default now()
);

create table if not exists vv_requirements (
  id               uuid primary key default gen_random_uuid(),
  mandate_id       uuid not null references vv_mandates(id) on delete cascade,
  ref              text not null,   -- position in the matrix: hard:0, preferred:1, capabilities:2, ambiguous:0
  kind             text not null check (kind in ('hard', 'preferred', 'capability', 'ambiguous')),
  text             text not null,
  quote            text not null,   -- verbatim from the JD; verifyQuotes already checked it
  evidence_needed  text,
  observable       jsonb,           -- [string], capabilities only
  skill_cluster_id text,            -- link to a skill cluster; null when unset
  created_at       timestamptz not null default now(),
  unique (mandate_id, ref)
);

create table if not exists vv_plans (
  id                     uuid primary key default gen_random_uuid(),
  mandate_id             uuid not null references vv_mandates(id) on delete cascade,
  version                integer not null check (version >= 1),
  status                 text not null default 'draft'
                         check (status in ('draft', 'awaiting_approval', 'approved', 'rejected', 'superseded')),
  session_budget_seconds integer not null check (session_budget_seconds between 60 and 7200),
  consent_text_version   text,                       -- set at approval from voice/consent.mjs (migration 2)
  flagged                jsonb not null default '[]'::jsonb,   -- [{ref, reason}] HR questions the generator would not plan
  override_reason        text,                       -- if approved despite `flagged`, who said why
  approved_by            text,
  approved_at            timestamptz,
  created_at             timestamptz not null default now(),
  unique (mandate_id, version)
);

create table if not exists vv_plan_items (
  id                uuid primary key default gen_random_uuid(),
  plan_id           uuid not null references vv_plans(id) on delete cascade,
  requirement_id    uuid references vv_requirements(id) on delete restrict,   -- null for HR questions and intent
  ref               text not null,
  kind              text not null
                    check (kind in ('capability', 'hard_requirement', 'hr_fact', 'hr_capability', 'intent', 'communication_context')),
  priority          integer not null check (priority >= 1),
  budget_seconds    integer not null check (budget_seconds between 30 and 1800),
  evidence_contract jsonb not null,   -- lib/schemas/vv-plan.mjs EvidenceContract
  created_at        timestamptz not null default now()
);

create index if not exists vv_plan_items_plan_idx on vv_plan_items (plan_id, priority);

create table if not exists vv_agent_versions (
  id                        uuid primary key default gen_random_uuid(),
  controller_version        text not null,
  writer_prompt_version     text not null,
  judge_prompt_version      text not null,
  extractor_prompt_version  text not null,
  evaluator_version         text not null,
  elevenlabs_agent_id       text,
  created_at                timestamptz not null default now()
);

-- Immutability. An approved plan may only become superseded, and nothing else about it may move.
create or replace function vv_plans_guard() returns trigger language plpgsql as $$
begin
  if old.status = 'superseded' then
    raise exception 'vv_plans % is superseded and cannot change', old.id;
  end if;
  if old.status = 'approved' then
    if new.status <> 'superseded'
       or new.version <> old.version
       or new.mandate_id <> old.mandate_id
       or new.session_budget_seconds <> old.session_budget_seconds
       or new.consent_text_version is distinct from old.consent_text_version
       or new.flagged <> old.flagged
       or new.override_reason is distinct from old.override_reason
       or new.approved_by is distinct from old.approved_by
       or new.approved_at is distinct from old.approved_at then
      raise exception 'vv_plans % is approved; the only permitted change is status -> superseded', old.id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists vv_plans_guard on vv_plans;
create trigger vv_plans_guard before update on vv_plans
  for each row execute function vv_plans_guard();

-- Items of an approved or superseded plan cannot be added, changed, or removed.
create or replace function vv_plan_items_guard() returns trigger language plpgsql as $$
declare s text;
begin
  select status into s from vv_plans where id = coalesce(new.plan_id, old.plan_id);
  if s in ('approved', 'superseded') then
    raise exception 'vv_plan_items of plan % cannot change: plan is %', coalesce(new.plan_id, old.plan_id), s;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists vv_plan_items_guard on vv_plan_items;
create trigger vv_plan_items_guard before insert or update or delete on vv_plan_items
  for each row execute function vv_plan_items_guard();

alter table vv_mandates       enable row level security;
alter table vv_requirements   enable row level security;
alter table vv_plans          enable row level security;
alter table vv_plan_items     enable row level security;
alter table vv_agent_versions enable row level security;
-- No policies: the service role bypasses RLS; anon and authenticated get nothing.

comment on table vv_plans is
  'One version of a verification plan for one mandate. Immutable once approved (trigger); a change is a new version. A session keeps the version it ran against.';
comment on column vv_plan_items.evidence_contract is
  'jsonb, lib/schemas/vv-plan.mjs EvidenceContract: mandate_quote, why_it_matters, elements (which are required, which is core), anchor, probes each targeting an element, scenario, hooks, expected_evidence, fallback_text for every move. What counts as sufficient evidence for THIS requirement, decided and approved before anyone is asked.';
comment on column vv_plans.flagged is
  'jsonb [{ref, reason}]. HR questions the plan generator declined to plan (a protected topic, or unanswerable in a conversation). A plan with a non-empty flagged cannot be approved without override_reason.';
