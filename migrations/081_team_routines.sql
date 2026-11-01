-- 081_team_routines.sql: a routine can be a team. The routine keeps its
-- agents (each a name and its part), and each run keeps their state and
-- findings for a line per agent on the Agents tab, as a team task does.
ALTER TABLE automations ADD COLUMN IF NOT EXISTS members jsonb;
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS team jsonb;
