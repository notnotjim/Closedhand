-- A paid month of Closedhand Managed Models begins with what the period
-- before left unused, up to one month's fair use (lib/included-ai.js
-- subscribe): carry_usd is what this paid month carried in, kept for the
-- month so carrying on past it adds to the same total; left_usd is what a key
-- stopped at the end of its free days or a subscription had left, for a
-- subscription that comes later.
ALTER TABLE included_ai_keys ADD COLUMN IF NOT EXISTS carry_usd numeric NOT NULL DEFAULT 0;
ALTER TABLE included_ai_keys ADD COLUMN IF NOT EXISTS left_usd numeric;
