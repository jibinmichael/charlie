-- representations — what happened after we put a person in front of a company.
--
-- THE ONE OUTCOME IN OUR LANE IS AN INTERVIEW. This table names the company a person was put in
-- front of, whether it replied, and whether an interview happened. Without it the work is unmeasured
-- and every change to the screening rubric is unfalsifiable: new scores, no way to know if they are
-- better ones.
--
-- A HIRE IS DELIBERATELY NOT THE METRIC. Whether somebody is hired is decided in rooms we are not in,
-- months later, for reasons that have nothing to do with us. Measuring ourselves on it would be
-- measuring somebody else's decision. The interview is the last thing our work can cause.
--
-- IT IS AN OPERATOR'S RECORD, NOT AN AUTOMATED ONE. Companies reply to a human inbox, in prose, often
-- days later and often to a person rather than to a system. A model guessing "they seem interested"
-- from an email would be a number nobody could defend, and this table's entire value is that a person
-- who knew what happened typed it in. Rows are created by operator tooling and by hand.
--
-- SEPARATE FROM talent_pool ON PURPOSE. A person can be represented to several companies, for
-- several roles, over time. That is a one-to-many fact and it does not belong in a column on the
-- candidate.

create table if not exists public.representations (
  id                   bigserial primary key,

  -- who, and where they came from. Email rather than a candidate id because that is the join key the
  -- rest of the system already uses; a stable internal id is a later, larger change.
  candidate_email      text not null,
  candidate_name       text,

  -- what they were put forward for
  company              text not null,
  role_title           text not null,
  job_id               text,                    -- job_pool id when the role came from the scan

  -- how it went out. Not every representation is the same act, and they do not convert the same way:
  --   profile_shared  we sent their story and evidence to a hiring manager
  --   intro           we made a direct introduction
  --   apply_link      we sent them a referral link and they applied themselves
  channel              text,
  represented_at       timestamptz not null default now(),

  -- what came back. All nullable, because "we have not heard" is the normal state for a while and is
  -- different from "they said no". A null responded_at with an old represented_at is the silence we
  -- currently cannot see.
  company_responded_at timestamptz,
  company_response     text,                    -- verbatim, when there is one. Never a summary.
  interview_at         timestamptz,

  -- awaiting | interviewing | rejected | offer | no_response | withdrawn
  outcome              text not null default 'awaiting',
  outcome_at           timestamptz,

  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- ONE ROW PER PERSON PER ROLE. Without this a re-run of a loader, or a second pitch of the same
  -- person to the same role, silently doubles the denominator and every rate computed from this table
  -- is wrong in the flattering direction.
  unique (candidate_email, company, role_title)
);

create index if not exists representations_candidate_idx on public.representations (candidate_email);
create index if not exists representations_company_idx   on public.representations (company, role_title);
create index if not exists representations_outcome_idx   on public.representations (outcome);
create index if not exists representations_waiting_idx   on public.representations (represented_at)
  where company_responded_at is null;
