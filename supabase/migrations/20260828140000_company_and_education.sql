-- What kind of company they worked at, and where they studied. Recorded, never scored.
--
-- WHY THESE ARE FACTS AND NOT SCORE INPUTS. The rubric forbids a university or an employer's
-- prestige from moving an evidence level, and that rule is why a review can be defended line by
-- line. But refusing to RECORD pedigree is a different thing from refusing to score it: a client may
-- gate on pedigree, and a fact that is not stored cannot be shown as a filter. This is the
-- eligibility/evidence split: recorded as a fact, never an input to a score.
--
-- WHAT company_type IS FOR, and it is not ranking. A claim can be structurally unlikely for the kind
-- of company it was made at (an agency designer claiming a closed A/B test on a live product). That
-- is a QUESTION FOR A HUMAN, never a lower number, because agencies do sometimes embed with clients
-- and get real access.
--
-- NEVER AN INVENTED TIER. A bare "Tier 1/2" is a standard nobody can check. institution_tier_source
-- records WHICH published list produced the label, so a board can read "Tier 1 (NIRF top 25)" rather than a bare
-- word nobody can argue with. A tier with no source is not written.
--
-- BLANK MEANS UNKNOWN. Not "no", not "poor", not "unranked". Every one of these is null until
-- something we can cite fills it.

alter table talent_pool
  -- What kind of organisation their current employer is. product | enterprise | services | agency |
  -- consultancy | startup | unknown. Cached per company, so this costs once per employer ever.
  add column if not exists company_type          text,
  add column if not exists company_scale         text,
  add column if not exists company_typed_at      timestamptz,

  -- Education, extracted from their own CV. Verbatim: the institution as they wrote it.
  add column if not exists institution           text,
  add column if not exists degree                text,
  add column if not exists grad_year             int,
  -- The tier label AND the list it came from. Neither is written without the other.
  add column if not exists institution_tier      text,
  add column if not exists institution_tier_source text,
  add column if not exists education_read_at     timestamptz;

create index if not exists talent_pool_company_type_idx on talent_pool (company_type)
  where company_type is not null;
create index if not exists talent_pool_institution_tier_idx on talent_pool (institution_tier)
  where institution_tier is not null;

comment on column talent_pool.company_type is
  'What kind of organisation the current employer is. A fact for filtering and for the claim-vs-context check. NEVER an input to an evidence score.';
comment on column talent_pool.institution_tier is
  'Tier label from a NAMED published list, see institution_tier_source. Never written without a source, never invented, never an input to an evidence score.';
