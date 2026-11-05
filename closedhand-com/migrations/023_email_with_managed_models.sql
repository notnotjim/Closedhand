-- Closedhand's own email address comes with Closedhand Managed Models
-- (lib/included-ai.js): it sends and receives only while the account's free
-- 14 days run or its subscription gives access. Otherwise mail to it is
-- refused with one plain line, kept for the person's computer
-- (assistant-mail-worker.js), and nothing is sent. The address itself stays
-- with the account, so Managed Models coming back bring it back. The monthly
-- allowances that only the free tier had are gone; the daily guard against
-- an account sending mail it shouldn't stays, as do the service's own
-- monthly budget and every count.
-- The maintainer's own Managed Models (migration 025) count like any other.
-- Everything else in this function is as migration 014 made it.
CREATE OR REPLACE FUNCTION reserve_mail_relay_usage(event_key text, account uuid, direction_text text, deliveries integer, message_bytes bigint)
RETURNS TABLE (allowed boolean, reason text) LANGUAGE plpgsql AS $$
DECLARE
  owner_key_text text; monthly date := date_trunc('month', now() at time zone 'UTC')::date;
  today date := (now() at time zone 'UTC')::date; global_used mail_relay_usage; user_used mail_relay_usage; daily mail_relay_usage;
  controls mail_relay_controls; charge numeric; answer boolean := true; why text; prior mail_relay_meter; entitled boolean;
BEGIN
  IF event_key IS NULL OR account IS NULL AND direction_text = 'out' OR direction_text IS NULL OR deliveries IS NULL OR message_bytes IS NULL
     OR direction_text NOT IN ('in', 'out') OR deliveries < 1 OR deliveries > 8 OR message_bytes < 0 OR message_bytes > 50000000 OR length(event_key) > 250 THEN
    RAISE EXCEPTION 'Invalid usage event';
  END IF;
  SELECT * INTO controls FROM mail_relay_controls WHERE id = true FOR UPDATE;
  SELECT encode(sha256(convert_to(lower(owner_email), 'UTF8')), 'hex') INTO owner_key_text FROM mail_relay_accounts WHERE id = account;
  IF owner_key_text IS NULL THEN owner_key_text := 'unknown'; END IF;
  entitled := EXISTS (SELECT 1 FROM mail_relay_accounts a JOIN plus_subscriptions s ON s.owner_id = a.owner_id
      WHERE a.id = account AND s.status IN ('active', 'trialing', 'past_due'))
    OR EXISTS (SELECT 1 FROM mail_relay_accounts a JOIN included_ai_keys k ON k.owner_id = a.owner_id
      WHERE a.id = account AND k.stopped_at IS NULL AND (k.ends_at > now() OR k.maintainer));
  SELECT * INTO prior FROM mail_relay_meter WHERE event_id = event_key;
  IF FOUND THEN
    IF prior.owner_key <> owner_key_text OR prior.direction <> direction_text OR prior.deliveries <> deliveries OR prior.bytes <> message_bytes THEN
      RETURN QUERY SELECT false, 'Usage event does not match this request.'::text; RETURN;
    END IF;
    RETURN QUERY SELECT prior.allowed, prior.reason; RETURN;
  END IF;
  INSERT INTO mail_relay_usage (owner_key, period) VALUES ('global', monthly) ON CONFLICT DO NOTHING;
  SELECT * INTO global_used FROM mail_relay_usage WHERE owner_key = 'global' AND period = monthly;
  INSERT INTO mail_relay_usage (owner_key, period) VALUES (owner_key_text, monthly), (owner_key_text || ':daily', today) ON CONFLICT DO NOTHING;
  SELECT * INTO user_used FROM mail_relay_usage WHERE owner_key = owner_key_text AND period = monthly;
  SELECT * INTO daily FROM mail_relay_usage WHERE owner_key = owner_key_text || ':daily' AND period = today;
  charge := deliveries * 0.0005 + message_bytes * deliveries::numeric / 1048576 * 0.002;
  IF controls.paused OR global_used.estimated_usd + charge > controls.monthly_usd THEN
    UPDATE mail_relay_controls SET paused = true WHERE id = true; answer := false; why := 'Email is temporarily paused while capacity is increased.';
  ELSIF owner_key_text = 'unknown' THEN answer := false; why := 'Unknown email address.';
  ELSIF NOT entitled THEN
    answer := false; why := 'Closedhand''s email address sends and receives mail only with Closedhand Managed Models, which this account doesn''t have right now.';
  ELSIF direction_text = 'out' AND daily.sent + deliveries > 1000 OR direction_text = 'in' AND daily.received + deliveries > 2000 THEN
    answer := false; why := 'Your daily email allowance has been reached. It resets at midnight UTC.';
  END IF;
  IF answer OR direction_text = 'in' THEN
    UPDATE mail_relay_usage SET sent = sent + CASE WHEN direction_text = 'out' THEN deliveries ELSE 0 END,
      received = received + CASE WHEN direction_text = 'in' THEN deliveries ELSE 0 END, bytes = bytes + message_bytes * deliveries, estimated_usd = estimated_usd + charge
      WHERE owner_key = 'global' AND period = monthly;
  END IF;
  IF answer THEN
    UPDATE mail_relay_usage SET sent = sent + CASE WHEN direction_text = 'out' THEN deliveries ELSE 0 END,
      received = received + CASE WHEN direction_text = 'in' THEN deliveries ELSE 0 END, bytes = bytes + message_bytes * deliveries, estimated_usd = estimated_usd + charge
      WHERE owner_key IN (owner_key_text, owner_key_text || ':daily') AND period = CASE WHEN owner_key = owner_key_text THEN monthly ELSE today END;
  END IF;
  INSERT INTO mail_relay_meter (event_id, owner_key, direction, allowed, reason, deliveries, bytes)
    VALUES (event_key, owner_key_text, direction_text, answer, why, deliveries, message_bytes);
  RETURN QUERY SELECT answer, why;
END $$;
