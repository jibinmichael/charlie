-- pieworks_activations — Pieworks 2call activation. Applied by hand in the Supabase SQL editor, then
-- `npm run db:types`.
--
-- Pieworks pushes candidates who have sat in its 2call (pending) stage for 7+ days to POST /webhooks/pieworks.
-- Charlie emails each one once (lib/pieworks-activation.mjs); a yes moves them to "interested" in Pieworks
-- (the shortlist status update). These people belong to Pieworks, not to Charlie's pool: they live here only,
-- and nothing in the hiring workspace or the job-seeker side reads this table.
--
-- pieworks_activations   one row per Pieworks shortlist id (Pieworks re-sends a person daily while they stay in 2call;
--                        the primary key makes every repeat a no-op, so a person is emailed once, ever)
--   candidate        the webhook record as received, without aiScoreReason. Personal data: service role only
--   ai_score_reason  Pieworks' own AI assessment (HTML). Kept for reference, never emailed, never shown to the person
--   role             role, clientName, location from Pieworks' activeRoles at the time of the first email
--   reply_key        the opaque part of pieworks+<key>@, so a reply finds its row
--   stage            received | emailed | reminded | clarified | interested | declined | closed | skipped
--                    interested = they said yes (pushed_at says whether Pieworks has it yet); skipped = never emailed
--                    (stage_reason says why: the role is no longer active, the address is suppressed, ...)
--   reply_read       yes | no | unclear, read deterministically from their latest reply (lib/qualify/fields.mjs readYesNo)
--   pushed_at        when Pieworks accepted the "interested" status; push_attempts counts tries (the sweep stops at 5)
--
-- Written only by lib/pieworks-activation.mjs. Additive only: a new table; nothing existing is changed. RLS on, no anon
-- policies (the service role bypasses it; anon and authenticated get nothing).

create table if not exists pieworks_activations (
  shortlist_id     bigint primary key,
  requirement_id   bigint not null,
  email            text not null,
  name             text not null,
  candidate        jsonb not null,
  ai_score_reason  text,
  idempotency_key  text,
  received_at      timestamptz not null default now(),
  role             jsonb,
  reply_key        text unique,
  stage            text not null default 'received'
                   check (stage in ('received', 'emailed', 'reminded', 'clarified', 'interested', 'declined', 'closed', 'skipped')),
  stage_reason     text,
  emailed_at       timestamptz,
  reminded_at      timestamptz,
  clarified_at     timestamptz,
  replied_at       timestamptz,
  reply_text       text,
  reply_read       text check (reply_read in ('yes', 'no', 'unclear')),
  pushed_at        timestamptz,
  push_attempts    integer not null default 0,
  push_result      jsonb,
  updated_at       timestamptz not null default now()
);

create index if not exists pieworks_activations_stage_idx on pieworks_activations (stage);
create index if not exists pieworks_activations_email_idx on pieworks_activations (lower(email));

alter table pieworks_activations enable row level security;
