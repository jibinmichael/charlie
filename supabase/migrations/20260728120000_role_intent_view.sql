-- v_role_intent — derives ONE intent tier per (user, find_id) from the
-- existing `signals` table, so Charlie can score on intent STRENGTH, not click-or-not. A VIEW (not a
-- table) so it stays in sync as signals arrive — nothing to backfill, nothing to keep updated.
--
-- Tiers (highest wins per find; explicit rejection is TERMINAL — it is not overridden by an earlier
-- click or share):
--   -1 negative   : not, rejected
--    1 curious    : seen, apply_click
--    2 committed  : worth, share_whatsapp, share_linkedin, share_email, referral_click,
--                   referral_suggested, checkin_applied, applied, interview, chasing
--    0 none       : a sent find with no qualifying signal (via the LEFT JOIN)
--
-- Events NOT in the map (e.g. checkin_good / checkin_off — daily-mood, not role intent) map to NULL
-- and contribute nothing.
--
-- referral_lookups is deliberately NOT joined: its columns are (id, email, domain, company, contacts,
-- chosen, provider, created_at) — it has NO find_id / job_id, so it cannot be attributed to a role.
-- (referral_click / referral_suggested in `signals` DO carry find_id and already cover role-level
-- referral intent.)
--
-- Read-only view; additive; touches no existing object. Applied by hand in the Supabase SQL editor.

create or replace view public.v_role_intent as
with tiered as (
  select
    s.email,
    s.find_id,
    case
      when s.event in ('not','rejected') then -1
      when s.event in ('worth','share_whatsapp','share_linkedin','share_email',
                       'referral_click','referral_suggested','checkin_applied',
                       'applied','interview','chasing') then 2
      when s.event in ('seen','apply_click') then 1
      else null
    end as tier
  from public.signals s
  where s.find_id is not null
),
agg as (
  select
    email,
    find_id,
    -- explicit rejection is terminal: any negative forces -1, even over a later committed/curious signal
    case
      when bool_or(tier = -1) then -1
      else coalesce(max(tier) filter (where tier >= 0), 0)
    end as intent_level
  from tiered
  group by email, find_id
)
select
  f.email,
  f.id as find_id,
  f.status,
  coalesce(a.intent_level, 0) as intent_level,
  case coalesce(a.intent_level, 0)
    when -1 then 'negative'
    when 0  then 'none'
    when 1  then 'curious'
    when 2  then 'committed'
  end as intent_label
from public.finds f
left join agg a on a.email = f.email and a.find_id = f.id;
