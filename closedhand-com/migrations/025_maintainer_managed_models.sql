-- The maintainer's own account (lib/maintainer.js) has Closedhand Managed
-- Models with no charge (lib/included-ai.js): the same monthly fair use as a
-- subscription, renewing on the first of each month with the same carry-over,
-- and nothing that ends free days or a subscription stops it. This marks its
-- key; Closedhand's own email address comes with it like any other Managed
-- Models (migration 023).
ALTER TABLE included_ai_keys ADD COLUMN IF NOT EXISTS maintainer boolean NOT NULL DEFAULT false;
