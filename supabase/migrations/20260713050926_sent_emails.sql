-- sent_emails — the universal pre-send idempotency backstop.
--
-- One row per (email, template, dedupe_key) makes a duplicate send physically impossible: the send
-- path CLAIMS the key with an insert before sending, and the unique constraint rejects a second claim
-- (a cron retry, a crash-and-restart mid-run, or an overlapping run), so that caller skips the send.
-- On a failed send the claim is released so a retry can re-send. Code is fail-open: until this table
-- exists, the seam no-ops and sends behave exactly as before.
--
-- Apply by hand in the Supabase SQL editor (service-role JS can't run DDL), then `npm run db:types`.

create table if not exists public.sent_emails (
  id         bigint generated always as identity primary key,
  email      text not null,               -- recipient (lowercased)
  template   text not null,               -- email type: 'role' | 'digest' | 'newsletter' | 'welcome' | 'whatsnew' | ...
  dedupe_key text not null,               -- per-send idempotency key (e.g. findId, an ISO week, or a content hash)
  resend_id  text,                        -- the Resend message id, recorded after a successful send
  sent_at    timestamptz not null default now(),
  constraint sent_emails_uniq unique (email, template, dedupe_key)
);

create index if not exists sent_emails_email_idx on public.sent_emails (email);

alter table public.sent_emails enable row level security;
-- No anon policies: the service role bypasses RLS; anon/authenticated get nothing.
