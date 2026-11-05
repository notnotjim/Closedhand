-- A Closedhand account made with an account number instead of a Google or
-- Microsoft sign-in (lib/account-number.js): provider 'anonymous', its
-- subject the one-way fingerprint of the number. The number itself and any
-- email are never kept.
ALTER TABLE owners DROP CONSTRAINT IF EXISTS owners_provider_check;
ALTER TABLE owners ADD CONSTRAINT owners_provider_check CHECK (provider IN ('google', 'microsoft', 'anonymous'));

-- Such an account is paid for first, in crypto (lib/ahead.js): until the
-- payment settles, the claim waits here with the computer that asked (by the
-- hash of its secret), the months and the invoice, and nothing about the
-- person. Once paid, the account, its personal URL and its plan are made
-- together and the number waits, sealed, for that computer to collect it
-- once (lib/addresses.js). An invoice that expires discards the claim.
CREATE TABLE IF NOT EXISTS anonymous_pending (
  id uuid PRIMARY KEY,
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  web_port integer NOT NULL CHECK (web_port BETWEEN 1024 AND 65535),
  months integer NOT NULL,
  terms_version text,
  invoice_id text,
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'making', 'paid')),
  owner_id uuid REFERENCES owners(id) ON DELETE CASCADE,
  number text,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS anonymous_pending_copy ON anonymous_pending (secret_hash, created_at);
CREATE INDEX IF NOT EXISTS anonymous_pending_invoice ON anonymous_pending (invoice_id);
