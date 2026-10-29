-- join_applicants — the isolated state and audit trail for the join@ hiring campaign.
-- Separate from the product on purpose: a person becomes a row here only when they email join@ as an
-- applicant. Identity is the mailbox (email), same as the rest of Charlie; the "onboarded first" gate
-- reads `candidates` in code, so there is no hard FK (the two systems stay decoupled). All of this is
-- inert until JOIN_CAMPAIGN=on.
--
--  * The full bounded transcript and the model's FACTUAL per-dimension summary are persisted, so a
--    verdict is always reconstructable.
--  * The verdict is 100% human: `verdict` is written ONLY by an owner reply; the model never sets it.
--    `scores` is a factual summary Charlie assembles, never a pass/fail decision.

create table if not exists public.join_applicants (
  email          text primary key,                       -- identity = the applicant's mailbox (lowercased in code)
  stage          text not null default 'applied',        -- applied|prescreen_passed|challenge|awaiting_verdict|advanced|rejected|stalled|redirected|closed
  transcript     jsonb not null default '[]'::jsonb,      -- the bounded loop, append-only in code: [{ role:'charlie'|'candidate', text, at }]
  turns          integer not null default 0,             -- Charlie messages sent in the challenge loop (hard cap = JOIN_LOOP_MAX_TURNS)
  scores         jsonb,                                   -- the model's FACTUAL per-dimension summary of the answers (NOT a verdict)
  verdict        text,                                    -- 'advance' | 'reject' — set ONLY by a human owner reply, never by the model
  verdict_by     text,                                    -- the owner address that cast the verdict (audit)
  verdict_at     timestamptz,
  redirect_count integer not null default 0,             -- Case 2 order-gate redirects (mechanical: wrote in before onboarding + a match)
  last_msg_at    timestamptz,                             -- last Charlie->applicant send (quiet-hours + stall detection)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- stage sweeps (find awaiting_verdict / stalled) stay cheap as the pipeline grows.
create index if not exists join_applicants_stage_idx on public.join_applicants (stage);
