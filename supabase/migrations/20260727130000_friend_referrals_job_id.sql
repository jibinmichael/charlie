-- friend_referrals.job_id — the exact role a gift-a-role referral is about (the "see your fit" loop).
-- The friend-drip shares Charlie (no job, job_id stays null); the gift-a-role loop shares ONE role, so
-- its click / fit-check events carry the job id. Nullable + additive, so existing friend-drip rows are
-- untouched. Applied by hand in the Supabase SQL editor. Fail-open: recordReferralEvent only sets job_id
-- when it has one, so before this is applied a friend-drip write still succeeds; a gift-a-role write
-- (which sets job_id) no-ops until the column exists, never blocking the /j redirect or the check@ read.

alter table public.friend_referrals add column if not exists job_id text;
create index if not exists friend_referrals_job_idx on public.friend_referrals (job_id) where job_id is not null;
