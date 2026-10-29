-- hire_pursuit_events: an agent may be the actor of a lifecycle event. lib/hire-lifecycle.mjs lets the Follow-up agent cause `time.tick` (its one follow-up
-- and the give-up), each agent only inside its scope (AGENT_SCOPES). The database's actor list must equal the
-- engine's (lib/hire-pursuit-store.test.mjs pins it). Applied by hand in the Supabase SQL editor. Additive: every
-- existing row stays valid.
alter table hire_pursuit_events drop constraint if exists hire_pursuit_events_actor_check;
alter table hire_pursuit_events add constraint hire_pursuit_events_actor_check
  check (actor in ('candidate', 'operator', 'employer', 'charlie', 'system', 'agent'));
