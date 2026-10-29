-- Hiring workspace: the agents. Applied by hand in the Supabase SQL editor, then `npm run db:types`.
--
-- 1. hire_agents        one row per agent: on or off, its mode (off / draft / auto) and its settings.
--                       A missing row means the agent's defaults (lib/agents/registry.mjs), so a new
--                       workspace works out of the box; a row exists only once somebody changes it.
-- 2. hire_agent_runs    every run, scheduled or "Run now": when, what it did per person, and its status
--                       (ok, needs_review, failed, skipped). The run details the screen shows.
-- 3. hire_agent_drafts  what an agent in draft mode proposes: the exact email it would send and why. A
--                       person approves (it is sent through sendGuarded) or rejects it. One draft per
--                       agent, person, role and kind, so a re-run never proposes the same thing twice.
-- Written only by lib/agents/store.mjs. Nothing here touches the pursuit tables; an agent's email lands
-- in sent_emails like any other send and the pursuit sync records it.

create table if not exists hire_agents (
  id          text primary key check (id in ('outreach', 'qualifier', 'followup', 'concierge')),
  enabled     boolean not null default true,
  mode        text not null check (mode in ('off', 'draft', 'auto')),
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create table if not exists hire_agent_runs (
  id          uuid primary key default gen_random_uuid(),
  agent       text not null check (agent in ('outreach', 'qualifier', 'followup', 'concierge')),
  trigger     text not null check (trigger in ('schedule', 'manual')),
  mode        text not null check (mode in ('off', 'draft', 'auto')),
  status      text not null default 'running' check (status in ('running', 'ok', 'needs_review', 'failed', 'skipped')),
  counts      jsonb not null default '{}'::jsonb,   -- {considered, sent, drafted, waiting, skipped, failed}
  items       jsonb not null default '[]'::jsonb,   -- [{who, mandate, action, result, reason}]
  note        text,                                 -- why a run was skipped (quiet hours, daily limit, off)
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists hire_agent_runs_agent on hire_agent_runs (agent, started_at desc);

create table if not exists hire_agent_drafts (
  id          uuid primary key default gen_random_uuid(),
  agent       text not null check (agent in ('outreach', 'qualifier', 'followup', 'concierge')),
  run_id      uuid references hire_agent_runs(id) on delete set null,
  mandate     text not null,
  email       text not null check (email = lower(email)),
  name        text,
  kind        text not null,                        -- e.g. followup, questions, answer, closeout, first
  reason      text not null,                        -- why the agent proposes it, in plain words
  subject     text not null,
  body_text   text not null,
  send        jsonb not null,                       -- {template, dedupeKey, html} exactly as it would be sent
  status      text not null default 'pending' check (status in ('pending', 'sent', 'rejected', 'failed', 'expired')),
  result      text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  text,
  unique (agent, email, mandate, kind)
);
create index if not exists hire_agent_drafts_pending on hire_agent_drafts (status, created_at desc);

alter table hire_agents enable row level security;
alter table hire_agent_runs enable row level security;
alter table hire_agent_drafts enable row level security;
