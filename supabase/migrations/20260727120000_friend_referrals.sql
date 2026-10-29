-- friend_referrals — the attribution + A/B log for the bring-a-friend share loop (the friend-drip).
-- Append-only event log, one row per event. A 'click' lands when a friend opens the giver's /g/<token>
-- link; a 'signup' lands when that friend onboards via start@ carrying the ref code. `variant` is the
-- share-note A/B ('A'|'B'), derived deterministically from the giver's address (friendVariant in
-- charlie-store.mjs) and stored so "which note pulled more people in" is a plain group-by.
--
-- Identity is the mailbox (email), same as the rest of Charlie; no hard FK to candidates (keeps the loop
-- decoupled, and a click has no friend identity yet). Applied by hand in the Supabase SQL editor.
--
-- Fail-open contract: every write goes through a best-effort store fn that logs +
-- returns null on error, so before this migration is applied the loop silently no-ops — a click still
-- redirects, an onboarding still completes. Nothing here can block a send or an onboarding.

create table if not exists public.friend_referrals (
  id            bigint generated always as identity primary key,
  giver_email   text not null,                          -- the user who shared (lowercased in code)
  variant       text,                                   -- 'A' | 'B' share-note variant (derived from giver)
  kind          text not null,                          -- 'click' (friend opened /g) | 'signup' (friend onboarded)
  friend_email  text,                                   -- the referred person, known only on 'signup'
  ref_code      text,                                   -- the signed /g token that carried the attribution (audit)
  created_at    timestamptz not null default now()
);

-- the two reads: a giver's own funnel, and the A/B readout (variant x kind counts).
create index if not exists friend_referrals_giver_idx on public.friend_referrals (giver_email, created_at desc);
create index if not exists friend_referrals_variant_idx on public.friend_referrals (variant, kind);

-- service-role bypasses RLS; no anon/authenticated policies (matches join_applicants + the rest).
alter table public.friend_referrals enable row level security;
