-- Reply drafts Closedhand put in the person's mailbox on its own
-- (lib/prepared-drafts.js), kept so each can be removed after 24 hours if
-- untouched, unless the person said to keep it. version is the draft as
-- Closedhand left it (Gmail's message id, Outlook's changeKey, the IMAP
-- draft's number): a different one means the person edited it, and it stays.
CREATE TABLE IF NOT EXISTS prepared_drafts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tool       text NOT NULL,
  account    text,
  draft_id   text NOT NULL,
  version    text,
  thread_id  text,
  kept       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prepared_drafts_user ON prepared_drafts (user_id, created_at);
