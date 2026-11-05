-- Closedhand Managed Models moved from OpenRouter to NEAR AI
-- (lib/included-ai.js): a key is known by NEAR's id for it. A key made at
-- OpenRouter means nothing to NEAR, so those are let go here (and deleted in
-- OpenRouter's dashboard). A subscriber's computer collects a NEAR key at its
-- next hourly check; a first month is not given again (starter_grants keeps
-- the sign-in).
DELETE FROM included_ai_keys;
DELETE FROM retired_ai_keys;
ALTER TABLE included_ai_keys RENAME COLUMN key_hash TO key_id;
ALTER TABLE retired_ai_keys RENAME COLUMN key_hash TO key_id;

CREATE OR REPLACE FUNCTION retire_ai_key() RETURNS trigger AS $$
BEGIN
  INSERT INTO retired_ai_keys (key_id) VALUES (OLD.key_id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS included_ai_keys_replaced ON included_ai_keys;
CREATE TRIGGER included_ai_keys_replaced AFTER UPDATE OF key_id ON included_ai_keys
  FOR EACH ROW WHEN (OLD.key_id IS DISTINCT FROM NEW.key_id) EXECUTE FUNCTION retire_ai_key();

-- closedhand.com's sign-in at NEAR AI (lib/near-session.js), one row: the
-- refresh token in use now, sealed; a hash of the one last handed over
-- (NEAR_REFRESH_TOKEN), so handing over a new one is noticed; when it ends;
-- and when NEAR last refused it and its end was last warned of, so the
-- maintainer is told each once.
CREATE TABLE IF NOT EXISTS near_session (
  id integer PRIMARY KEY CHECK (id = 1),
  refresh_token text NOT NULL,
  seed_hash text NOT NULL,
  expires_at timestamptz,
  failed_at timestamptz,
  warned_for timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
