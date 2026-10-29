-- hire_agents: admit the 'rediscovery' agent id.
--
-- The agents are listed in lib/agents/registry.mjs. The three agent-id checks from
-- 20261005150000_hire_agents.sql are widened to admit 'rediscovery'. The ids 'qualifier' and
-- 'concierge' stay allowed so no stored row breaks. Additive only; nothing is dropped but the checks.

alter table hire_agents drop constraint if exists hire_agents_id_check;
alter table hire_agents add constraint hire_agents_id_check
  check (id in ('outreach', 'qualifier', 'followup', 'concierge', 'rediscovery'));

alter table hire_agent_runs drop constraint if exists hire_agent_runs_agent_check;
alter table hire_agent_runs add constraint hire_agent_runs_agent_check
  check (agent in ('outreach', 'qualifier', 'followup', 'concierge', 'rediscovery'));

alter table hire_agent_drafts drop constraint if exists hire_agent_drafts_agent_check;
alter table hire_agent_drafts add constraint hire_agent_drafts_agent_check
  check (agent in ('outreach', 'qualifier', 'followup', 'concierge', 'rediscovery'));
