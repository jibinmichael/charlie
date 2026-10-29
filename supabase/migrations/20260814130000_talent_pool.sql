-- talent_pool — one canonical row per person, every column an enrichment field, every field
-- queryable.
--
-- SEPARATE FROM `candidates` ON PURPOSE. `candidates` is the email product's table: status drives who
-- gets a weekly role email, and its dossier is a JSON blob you cannot filter on. Nothing here writes
-- to it and nothing here reads its status. A person can exist in both, in one, or in neither.
--
-- FLAT COLUMNS, NOT A BLOB. The whole point is the query:
--   "product managers in India, 8+ years, notice under 60 days, actively looking, not a hopper"
-- That is impossible against JSON. Every field somebody would filter on is its own typed column.
-- `provenance` carries the source and confidence for each of them, so a flat value never loses the
-- answer to "how do you know that".
--
-- TWO DIFFERENT AXES, DELIBERATELY NOT MERGED:
--   seeking_status   what they SAY about wanting to move   (intent, from their own words)
--   mobility_profile what their HISTORY says about staying  (behaviour, computed from tenure)
-- An active seeker who has held two roles in ten years and an active seeker who has held five in
-- four are different people to a hiring manager, and collapsing them destroys the distinction.

create table if not exists public.talent_pool (
  id                    bigserial primary key,
  email                 text not null unique,          -- the join key, lowercased
  full_name             text,
  phone                 text,
  linkedin_url          text,
  portfolio_url         text,

  -- current and previous position
  current_title         text,
  current_company       text,
  previous_title        text,
  previous_company      text,
  headline              text,                          -- their own one-liner, verbatim

  -- experience
  total_years           numeric(4,1),
  roles_count           int,
  avg_tenure_months     int,
  longest_tenure_months int,
  current_tenure_months int,
  seniority             text,   -- ic | senior_ic | lead | manager | head | unknown
  role_family           text,   -- product_design | product_management | customer_success | sales | marketing | ops | data | other

  -- location and mobility
  city                  text,
  country               text,
  willing_to_relocate   text,   -- verbatim answer; yes/no/conditional live in their words
  work_mode_pref        text,   -- remote | hybrid | onsite | flexible | unknown

  -- availability. notice_days is the normalised twin of notice_period_raw, for range queries.
  notice_period_raw     text,
  notice_days           int,
  seeking_status        text,   -- active_seeker | open_to_right_thing | passive | not_looking | unknown
  available_from        date,

  -- compensation. Indian conventions: LPA and lakhs parsed into a plain annual number.
  comp_current          bigint,
  comp_expected         bigint,
  comp_currency         text,

  -- behaviour, computed from employment dates. Never asked, never guessed from a title.
  mobility_profile      text,   -- stable | steady | mover | hopper | unknown

  -- signal
  top_skills            text[],
  domains               text[],

  -- consent. Booleans for filtering, verbatim text for defending a decision later.
  consent_process       boolean default false,
  consent_share         boolean default false,
  consent_pool          boolean default false,
  consent_text          jsonb default '{}'::jsonb,

  -- provenance and quality
  source_form           text,
  source_role           text,
  applied_at            timestamptz,
  completeness          int default 0,                 -- 0-100
  missing_fields        text[] default '{}',           -- drives the gap-fill ask
  provenance            jsonb default '{}'::jsonb,     -- per-field { value_source, confidence }
  enrichment_version    text,
  enriched_at           timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- The indexes exist for the queries the product is FOR. Anything filtered on gets one.
create index if not exists talent_pool_family_idx     on public.talent_pool (role_family, seniority);
create index if not exists talent_pool_years_idx      on public.talent_pool (total_years);
create index if not exists talent_pool_notice_idx     on public.talent_pool (notice_days);
create index if not exists talent_pool_seeking_idx    on public.talent_pool (seeking_status);
create index if not exists talent_pool_mobility_idx   on public.talent_pool (mobility_profile);
create index if not exists talent_pool_location_idx   on public.talent_pool (country, city);
create index if not exists talent_pool_consent_idx    on public.talent_pool (consent_pool, consent_share);
create index if not exists talent_pool_completeness_idx on public.talent_pool (completeness desc);
create index if not exists talent_pool_skills_idx     on public.talent_pool using gin (top_skills);
create index if not exists talent_pool_domains_idx    on public.talent_pool using gin (domains);
