-- 080_agent_teams.sql: a task worked on by a team keeps each agent's name,
-- job, state and findings, so the Agents tab shows a line per agent while the
-- team works and the person can read what any of them found.
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS team jsonb;
