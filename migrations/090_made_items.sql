-- 090_made_items.sql — what Closedhand made in the person's accounts.
--
-- A draft it wrote was edited and sent by the person, and the reply had come,
-- yet the chat said it was "still sat in" their drafts: it remembered what it
-- had done, not what happened after. lib/made.js notes each mail draft and
-- calendar event Closedhand makes here, and each turn reads them as they are
-- now in the synced mail and calendar.
--
-- Runner-managed: idempotent.

CREATE TABLE IF NOT EXISTS made_items (
  user_id uuid NOT NULL,
  kind text NOT NULL,
  ref text NOT NULL,
  source text NOT NULL,
  thread text,
  title text,
  account text,
  detail text,
  made_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, ref)
);

CREATE INDEX IF NOT EXISTS idx_made_items_recent ON made_items (user_id, made_at DESC);
