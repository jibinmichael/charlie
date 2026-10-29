-- inbound_messages — keep what people actually write to Charlie.
--
-- Charlie's entire surface is email. Resend delivers to a webhook rather than a mailbox, so without
-- this table /inbound would read a body, act on it, and drop it, and "has anybody asked us something
-- we have not answered" could not be answered.
--
-- Bodies are what a person chose to send us in reply to our own email. Keep them, and keep them
-- honestly: no parsing, no summary, no model in between.

create table if not exists public.inbound_messages (
  id          bigserial primary key,
  email       text not null,
  subject     text,
  body        text,
  -- Resend's own id for the delivery. UNIQUE so a webhook replay cannot double-store: the /inbound
  -- route is already replay-safe for sends via sendGuarded's dedupe key, and this mirrors it.
  email_id    text unique,
  stage       text,                      -- which inbound branch handled it, for tracing a wrong answer
  received_at timestamptz not null default now()
);

create index if not exists inbound_messages_email_idx on public.inbound_messages (email, received_at desc);
create index if not exists inbound_messages_received_idx on public.inbound_messages (received_at desc);
