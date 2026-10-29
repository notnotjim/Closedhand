-- More than one way into a Closedhand account. Every Google or Microsoft
-- account connected through Closedhand's own apps on the computer holding the
-- personal URL signs in to that account, not only the first, which claimed it
-- (owners.provider/subject). A sign-in belongs to one account at most, and is
-- never moved or merged; an account's sign-ins go with it.
CREATE TABLE IF NOT EXISTS owner_sign_ins (
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  subject text NOT NULL,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS owner_sign_ins_owner ON owner_sign_ins (owner_id);
