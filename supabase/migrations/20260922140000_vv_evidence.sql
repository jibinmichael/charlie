-- Voice verification, migration 3 of 3: evidence, contradictions, signals, reports, reviews, disputes.
-- Applied by hand in the Supabase SQL editor, then `npm run db:types`. Migrations 1 and 2 must be
-- applied first.
--
-- THE CHAIN IS IN THE SCHEMA. An evidence row carries a verbatim quote and the turn ids it came from
-- (provenance); a signal carries the evidence ids it rests on OR a reason for having none, and the
-- check constraint refuses a signal with neither. A status outside the six
-- is refused by the check constraint; voice/statuses.mjs is the same list in code, and
-- voice/status-names.test.mjs reads this file to prove they match.
--
-- NO SCORE ANYWHERE. There is no numeric column that ranks a person, on purpose. coverage_band is
-- one of four words about how much of the contract was exercised, and the inputs it was computed
-- from sit beside it in coverage_inputs so a reader can disagree from the same facts.
--
-- vv_reviews IS THE ONE GROUND-TRUTH LOOP. Per signal: Charlie's status, the reviewer's, agreement,
-- and one of five reasons; plus the evidence-lift note. Nothing else scores the evaluator.

create table if not exists vv_evidence (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references vv_sessions(id) on delete cascade,
  plan_item_id      uuid not null references vv_plan_items(id) on delete restrict,
  requirement_id    uuid references vv_requirements(id) on delete restrict,
  contract_element  text not null,
  type              text not null check (type in ('claim', 'account', 'mechanism', 'ownership', 'tradeoff', 'number', 'scenario_reasoning', 'answer', 'refusal', 'meta')),
  quote             text not null,           -- verbatim from a candidate turn; validated before insert
  provenance        jsonb not null,          -- {conversation_id, turn_ids[], audio_start_secs, audio_end_secs}
  reliability       text not null check (reliability in ('usable', 'low_confidence', 'unusable')),
  specificity       integer not null check (specificity between 0 and 2),
  ownership         text not null check (ownership in ('self', 'shared', 'team', 'unclear')),
  probe_depth       integer not null check (probe_depth between 0 and 2),   -- set in code from the preceding agent move
  typed_facts       jsonb not null default '[]'::jsonb,   -- [{claim, subject, scope, time, ownership, source}]
  extractor_version text not null,
  created_at        timestamptz not null default now()
);

create index if not exists vv_evidence_session_item_idx on vv_evidence (session_id, plan_item_id);

create table if not exists vv_contradictions (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null references vv_sessions(id) on delete cascade,
  plan_item_id        uuid references vv_plan_items(id) on delete restrict,
  requirement_id      uuid references vv_requirements(id) on delete restrict,
  field               text not null check (field in ('time', 'ownership', 'claim', 'subject', 'scope')),
  evidence_a          uuid not null references vv_evidence(id) on delete cascade,
  evidence_b          uuid references vv_evidence(id) on delete cascade,   -- null when the other side is the CV
  cv_line             text,                                                 -- verbatim CV line when evidence_b is null
  resolved            boolean not null default false,
  resolution_evidence uuid references vv_evidence(id) on delete set null,   -- the self-correction, when resolved
  created_at          timestamptz not null default now(),
  constraint vv_contradictions_two_sides check (evidence_b is not null or cv_line is not null)
);

create table if not exists vv_signals (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references vv_sessions(id) on delete cascade,
  plan_item_id      uuid references vv_plan_items(id) on delete restrict,   -- null for the session-level communication signal
  requirement_id    uuid references vv_requirements(id) on delete restrict,
  category          text not null check (category in ('capability', 'hard_requirement', 'hr_fact', 'hr_capability', 'intent', 'communication')),
  status            text not null check (status in ('strongly_supported', 'supported', 'stated_only', 'contradicted', 'insufficient', 'not_assessed')),
  basis             text not null,           -- 'conversation_only' | 'conversation_and_cv'
  coverage_band     text not null check (coverage_band in ('strong_coverage', 'partial_coverage', 'limited_coverage', 'no_usable_evidence')),
  coverage_inputs   jsonb not null,          -- the facts the band was computed from
  evaluator_version text not null,
  evidence_ids      uuid[] not null default '{}',
  reason            text,                    -- when evidence_ids is empty: why (insufficient / not_assessed reason)
  limitations       text[] not null default '{}',
  created_at        timestamptz not null default now(),
  constraint vv_signals_evidence_or_reason check (cardinality(evidence_ids) > 0 or reason is not null)
);

create index if not exists vv_signals_session_idx on vv_signals (session_id);

create table if not exists vv_reports (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references vv_sessions(id) on delete cascade,
  version      integer not null check (version >= 1),
  package      jsonb not null,               -- lib/schemas/vv-report.mjs ReportPackage, the data the email is rendered from
  rendered_ref text,                         -- storage path of the rendered email, once rendered
  released_at  timestamptz,
  reviewed_by  text,
  created_at   timestamptz not null default now(),
  unique (session_id, version)
);

create table if not exists vv_reviews (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references vv_sessions(id) on delete cascade,
  report_version integer not null,
  reviewer       text not null,
  per_signal     jsonb not null,             -- [{signal_id, charlie_status, human_status, agrees, disagreement_reason}]
  evidence_lift  jsonb not null default '{}'::jsonb,   -- {evidence_ids_new_beyond_cv: [], note}
  recorded_at    timestamptz not null default now()
);

create table if not exists vv_disputes (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references vv_sessions(id) on delete cascade,
  turn_id    uuid not null references vv_turns(id) on delete cascade,
  reason     text not null,
  created_at timestamptz not null default now()
);

alter table vv_evidence       enable row level security;
alter table vv_contradictions enable row level security;
alter table vv_signals        enable row level security;
alter table vv_reports        enable row level security;
alter table vv_reviews        enable row level security;
alter table vv_disputes       enable row level security;
-- No policies: the service role bypasses RLS; anon and authenticated get nothing.

comment on table vv_signals is
  'One per plan item (plus one session-level communication signal). status is one of six words computed by voice/evaluate.mjs from validated evidence against the item''s contract; never set by a model. A signal has evidence_ids or a reason, never neither.';
comment on column vv_evidence.quote is
  'Verbatim from a candidate turn in vv_turns. voice/evidence-validate.mjs drops any quote not found in the referenced turns before it can be inserted.';
comment on table vv_reviews is
  'The one human ground-truth and evidence-lift loop. Per signal: Charlie''s status, the reviewer''s status, agreement, and one of: evidence_missed, evidence_insufficient, evaluator_rule_incorrect, mandate_ambiguous, candidate_answer_ambiguous.';
