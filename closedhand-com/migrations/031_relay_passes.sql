-- Personal URLs move from Cloudflare tunnels to Closedhand's own relay
-- (relay/relay.js). A computer takes its address there with a pass from
-- closedhand.com for its own key (lib/addresses.js), so nothing is built or
-- taken down for an address, and nothing about a route is kept. An address
-- is pending until its computer proves it answers there, then active; one let
-- go is deleted at once, its names held for six months (held_names).

-- Addresses let go, or that the tunnels' Worker was still taking down, go now:
-- their names are already held. One on its way to another computer waits
-- there for that computer to answer.
DELETE FROM addresses WHERE owner_id IS NULL OR (state = 'revoked' AND NOT reprovision);
UPDATE addresses SET state = 'pending' WHERE state <> 'active';
ALTER TABLE addresses DROP CONSTRAINT IF EXISTS addresses_state_check;
ALTER TABLE addresses ADD CONSTRAINT addresses_state_check CHECK (state IN ('pending', 'active'));
ALTER TABLE addresses ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE addresses DROP COLUMN tunnel_id, DROP COLUMN tunnel_token, DROP COLUMN dns_id, DROP COLUMN attempt_id,
  DROP COLUMN lease_until, DROP COLUMN revocation_complete, DROP COLUMN reprovision, DROP COLUMN web_port;

-- An old name after a rename is only reserved to its owner now: no redirect,
-- no route of its own. Those of accounts let go are held already.
DELETE FROM retired_names WHERE owner_id IS NULL;
ALTER TABLE retired_names ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE retired_names DROP COLUMN redirect_to, DROP COLUMN redirect_until, DROP COLUMN dns_id,
  DROP COLUMN announced, DROP COLUMN dns_removed;

-- The port a computer's dashboard listens on was for its tunnel.
ALTER TABLE approvals DROP COLUMN web_port;
ALTER TABLE anonymous_pending DROP COLUMN web_port;

-- The DNS records alert went with the tunnels' records.
DROP TABLE service_alerts;

-- When the relay last reported a computer connected at an active personal
-- URL (lib/addresses.js, relay-seen). Unused addresses are let go only while
-- this is recent, so a relay that stops reporting never makes every address
-- look unused.
CREATE TABLE relay_seen (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  seen_at timestamptz NOT NULL
);
