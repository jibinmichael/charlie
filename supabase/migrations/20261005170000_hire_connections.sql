-- hire_connections — the Qualify & Submit agent: one connection per employer system. Briefs are built
-- from the role's own fields; at most `per_role_cap` people per role, in batches of `batch_size`.
-- Applied by hand in the Supabase SQL editor, then `npm run db:types`.
--
-- 1. hire_connections        one row per employer system (e.g. Pieworks): where its roles
--                            come from, where candidates go, the email copy, the limits, and the mode
--                            (off | shadow | live). Shadow does everything except send and submit.
-- 2. hire_connection_roles   the employer system's role id beside the hire_jobs row it became. One row per external
--                            role; the raw payload and its hash, so a change is noticed and an unchanged role is not
--                            rewritten.
-- 3. hire_qualify_threads    one person, one role: the stage of the email exchange, the questions asked, the answers
--                            filed verbatim, the fields resolved for the employer (each with where it came from), the
--                            consent to be put forward (with the message it came from and the wording version), and
--                            the stored CV file. Nothing is submitted until the person replies YES to a final
--                            confirm email that lists exactly what will be sent (stage confirming).
-- 4. hire_submissions        every attempt to submit a person to an employer system: the payload sent (never the CV
--                            bytes), the response, and the outcome. A person is submitted for a role at most ONCE: the
--                            partial unique index refuses a second sent/duplicate row.
-- 5. storage bucket `cvs`    the original CV files people send (private).
--
-- Written only by lib/connections/store.mjs. Nothing here alters an existing table.

create table if not exists hire_connections (
  id           uuid primary key default gen_random_uuid(),
  key          text not null unique check (key ~ '^[a-z0-9-]{2,40}$'),
  name         text not null,
  source       jsonb not null default '{}'::jsonb,   -- {type: "pieworks", statuses: ["Hot","Warm"]}
  destination  jsonb not null default '{}'::jsonb,   -- {type: "pieworks"}
  sequence     jsonb not null default '{}'::jsonb,   -- per-email copy overrides; empty = Charlie's default copy
  settings     jsonb not null default '{}'::jsonb,   -- {min_fit, per_role_cap, batch_size}
  mode         text not null default 'off' check (mode in ('off', 'shadow', 'live')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   text
);

create table if not exists hire_connection_roles (
  id               uuid primary key default gen_random_uuid(),
  connection_id    uuid not null references hire_connections(id) on delete cascade,
  external_id      text not null,
  job_id           uuid references hire_jobs(id) on delete set null,
  external_status  text,
  payload          jsonb not null,
  payload_hash     text not null,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  unique (connection_id, external_id)
);
create index if not exists hire_connection_roles_job on hire_connection_roles (job_id);

create table if not exists hire_qualify_threads (
  id             uuid primary key default gen_random_uuid(),
  connection_id  uuid not null references hire_connections(id) on delete cascade,
  job_id         uuid not null references hire_jobs(id) on delete cascade,
  candidate_id   uuid not null,                       -- the person (lib/qualify/wiring.mjs candidateIdFor)
  email          text not null check (email = lower(email)),
  name           text,
  stage          text not null check (stage in ('verify_sent', 'reminded', 'answered', 'confirming', 'ready', 'submitting', 'submitted', 'closed', 'failed')),
  fit            text,                                -- the evaluator's label when the thread opened, then after answers
  reply_key      text not null unique,                -- replies come back to apply+<reply_key>@
  questions      jsonb not null default '[]'::jsonb,  -- [{id, text, field?}] exactly as asked
  answers        jsonb not null default '{}'::jsonb,  -- {question_id: verbatim span | null}
  fields         jsonb not null default '{}'::jsonb,  -- {field: {value, source}} resolved for the destination
  consent        jsonb,                               -- {state, company_shown, wording_version, evidence, at}
  cv_path        text,                                -- path in the cvs bucket
  cv_text        text,                                -- the CV's text, read again with their answers
  rounds         integer not null default 1 check (rounds between 1 and 2),   -- one follow-up at most
  evaluation     jsonb,                               -- the re-read after their answers: fit, criteria, cited evidence
  external_role_id text,                            -- the employer system's role id the submission goes to
  close_reason   text,
  last_error     text,
  verify_sent_at timestamptz,
  replied_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (job_id, candidate_id)
);
create index if not exists hire_qualify_threads_stage on hire_qualify_threads (connection_id, stage);

create table if not exists hire_submissions (
  id                uuid primary key default gen_random_uuid(),
  connection_id     uuid not null references hire_connections(id) on delete cascade,
  job_id            uuid not null references hire_jobs(id) on delete cascade,
  candidate_id      uuid not null,
  thread_id         uuid references hire_qualify_threads(id) on delete set null,
  external_role_id  text not null,
  mode              text not null check (mode in ('shadow', 'live')),
  status            text not null check (status in ('shadow', 'sent', 'duplicate', 'refused', 'failed')),
  payload           jsonb not null,                   -- the candidate fields as sent; never the CV bytes
  payload_hash      text not null,
  response          jsonb,
  attempt           integer not null default 1 check (attempt >= 1),
  created_at        timestamptz not null default now()
);
create unique index if not exists hire_submissions_once on hire_submissions (job_id, candidate_id) where status in ('sent', 'duplicate');
create index if not exists hire_submissions_connection on hire_submissions (connection_id, created_at desc);

alter table hire_connections enable row level security;
alter table hire_connection_roles enable row level security;
alter table hire_qualify_threads enable row level security;
alter table hire_submissions enable row level security;

insert into storage.buckets (id, name, public) values ('cvs', 'cvs', false) on conflict (id) do nothing;

-- The first connection, OFF until an operator switches it on.
insert into hire_connections (key, name, source, destination, settings, mode)
values ('pieworks', 'Pieworks', '{"type": "pieworks", "statuses": ["Hot", "Warm"]}', '{"type": "pieworks", "via": "Pieworks"}',
        '{"min_fit": "strong", "per_role_cap": 16, "batch_size": 4}', 'off')
on conflict (key) do nothing;
