-- The Polar order that carried this month on past fair use, so a webhook sent
-- again for it is the same purchase, and a second one is given back.
ALTER TABLE plus_subscriptions ADD COLUMN IF NOT EXISTS extended_order text;
