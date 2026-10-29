-- seeking liveness: when they said it, and when that stops being true.
--
-- WHY. `talent_pool.seeking_status` already records what somebody SAYS about wanting to move, and it
-- does not record WHEN they said it. Without that, an "active_seeker" from three months ago and one
-- from this morning are the same row, and silence is indistinguishable from "I stopped looking".
--
-- THE ANSWER EXPIRES ON PURPOSE. `seeking_until` is a date, set 30 days out when somebody replies
-- "open". After it passes, their status is stale rather than false: we ask again instead of assuming.
-- An expiring answer is the only honest kind, because a person's job search changes and they will
-- never log in to tell us.
--
-- THE OFFER IS SEPARATE, AND IT IS THE VALUABLE ONE. Someone can be actively looking AND holding an
-- offer; those are different facts. "She has a live offer" shortens a hiring manager's decision from
-- weeks to days, which is useful to the candidate and to the client, and no job board asks it.
-- Recorded with its own timestamp because an offer goes stale faster than anything else here.
--
-- NOTHING IS INFERRED INTO THESE COLUMNS. They are set from a person's own reply and from nothing
-- else. A blank means we have not asked or they have not answered, never that the answer is no.

alter table talent_pool
  -- When the current seeking answer stops being trustworthy. NULL = never asked, or they declined.
  add column if not exists seeking_until        date,
  -- When they last told us, in their own words. Distinct from updated_at, which moves for any reason.
  add column if not exists seeking_confirmed_at timestamptz,
  -- Their own words for the offer, verbatim. NULL = not asked or not answered, never "no offer".
  add column if not exists offer_status         text,
  add column if not exists offer_noted_at       timestamptz;

-- The query this exists to serve: who can we honestly say is looking, today.
create index if not exists talent_pool_seeking_until_idx on talent_pool (seeking_until)
  where seeking_until is not null;

comment on column talent_pool.seeking_until is
  'Date the current seeking answer expires. Set from their own reply, 30 days out. NULL means never asked or declined, never "not looking" — that is seeking_status.';
comment on column talent_pool.offer_status is
  'Their own words about holding an offer. NULL means unasked or unanswered, never that they have none.';
