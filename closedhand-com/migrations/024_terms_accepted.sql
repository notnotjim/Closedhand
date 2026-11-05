-- Which version of the Terms each account agreed to, and when: the setup
-- page asks once, before the personal URL is claimed, and the claim says so
-- (lib/addresses.js, TERMS_VERSION).
ALTER TABLE owners ADD COLUMN IF NOT EXISTS terms_version text;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
