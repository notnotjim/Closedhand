-- Every Closedhand Managed Models key that leaves included_ai_keys, replaced
-- by a new claim or gone with its account in any way (a cascade included),
-- waits here until OpenRouter has deleted it, so no key outlives its account.
CREATE TABLE IF NOT EXISTS retired_ai_keys (
  key_hash text PRIMARY KEY,
  retired_at timestamptz NOT NULL DEFAULT now(),
  tries integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION retire_ai_key() RETURNS trigger AS $$
BEGIN
  INSERT INTO retired_ai_keys (key_hash) VALUES (OLD.key_hash) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS included_ai_keys_gone ON included_ai_keys;
CREATE TRIGGER included_ai_keys_gone AFTER DELETE ON included_ai_keys
  FOR EACH ROW EXECUTE FUNCTION retire_ai_key();
DROP TRIGGER IF EXISTS included_ai_keys_replaced ON included_ai_keys;
CREATE TRIGGER included_ai_keys_replaced AFTER UPDATE OF key_hash ON included_ai_keys
  FOR EACH ROW WHEN (OLD.key_hash IS DISTINCT FROM NEW.key_hash) EXECUTE FUNCTION retire_ai_key();

-- This month's limit differs from the plan's by carry_usd, in carry_month
-- only: a key made again mid-month carries what the one before it used, and
-- a subscription that starts after a first month leaves what that used out.
ALTER TABLE included_ai_keys ADD COLUMN IF NOT EXISTS carry_usd numeric(10, 2);
ALTER TABLE included_ai_keys ADD COLUMN IF NOT EXISTS carry_month text;
