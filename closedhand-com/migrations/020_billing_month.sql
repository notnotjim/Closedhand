-- Closedhand+ fair use follows each person's own billing month, from the day
-- they subscribed, not the calendar month. A subscriber's key keeps no
-- OpenRouter reset: its limit is the use it had when this paid month began
-- (base_usd, for the month starting base_for) plus the month's fair use.
ALTER TABLE plus_subscriptions ADD COLUMN IF NOT EXISTS current_period_start timestamptz;
ALTER TABLE plus_subscriptions ADD COLUMN IF NOT EXISTS extended_for timestamptz;
ALTER TABLE plus_subscriptions DROP COLUMN IF EXISTS extended_month;
ALTER TABLE included_ai_keys ADD COLUMN IF NOT EXISTS base_usd numeric(10, 2);
ALTER TABLE included_ai_keys ADD COLUMN IF NOT EXISTS base_for timestamptz;
ALTER TABLE included_ai_keys DROP COLUMN IF EXISTS carry_usd;
ALTER TABLE included_ai_keys DROP COLUMN IF EXISTS carry_month;
