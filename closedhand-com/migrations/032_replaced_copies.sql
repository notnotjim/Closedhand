-- A personal URL moved to another computer of the same owner: the computer it
-- left is remembered, so when it next asks for a pass it is told it was
-- replaced and where Closedhand now runs, and stops running Closedhand (only
-- one runs for an account). It goes with the account.
CREATE TABLE replaced_copies (
  secret_hash text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX replaced_copies_owner ON replaced_copies (owner_id);
