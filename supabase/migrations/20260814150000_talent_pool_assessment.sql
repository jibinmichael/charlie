-- talent_pool: the assessment layer. Everything the screen and the story already produced, mapped
-- onto the canonical record so the whole profile lives in one queryable row.
--
-- WHY THESE ARE COLUMNS AND NOT A BLOB. `screen_score` and `shortlisted` are filtered on. The
-- dimensions and evidence are read, not filtered, so they are jsonb: anything you would put in a
-- WHERE clause is a column; anything you would read in a drawer is a document.
--
-- ASSESSMENT IS ROLE-FAMILY SPECIFIC AND SAYS SO. A design score means nothing to a PM role. The
-- family it was scored against travels with the score so nobody compares across rubrics by accident.

alter table public.talent_pool
  add column if not exists assessed_family    text,      -- which rubric produced the score
  add column if not exists screen_score       int,       -- 0..max
  add column if not exists screen_max         int,
  add column if not exists shortlisted        boolean default false,
  add column if not exists dimensions         jsonb default '{}'::jsonb,  -- { key: {score, quote, why} }
  add column if not exists evidence           jsonb default '[]'::jsonb,  -- verbatim spans behind each score
  add column if not exists story_client       text,      -- third person, for a hiring manager
  add column if not exists story_candidate    text,      -- second person, handed to them
  add column if not exists standout           text,      -- one grounded sentence
  add column if not exists screen_flags       text[] default '{}',
  add column if not exists assessed_at        timestamptz;

create index if not exists talent_pool_shortlisted_idx on public.talent_pool (shortlisted, screen_score desc);
create index if not exists talent_pool_assessed_idx    on public.talent_pool (assessed_family, screen_score desc);
create index if not exists talent_pool_dimensions_idx  on public.talent_pool using gin (dimensions);
