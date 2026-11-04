-- 089_people.sql — one person, however many names and addresses they go by.
--
-- A man saved on the person's phone as "Dad" moved, as WhatsApp is moving
-- everyone, to a private id carrying the name he gives himself, "Rowan", and
-- Closedhand had him as two people. lib/people.js keeps what the data itself
-- says about who is who: links between two handles of one person (a
-- platform's pairing of two ids, a contact that carries both) and the names
-- each handle goes by, by kind (saved, chat, own). Pinned Facts and
-- relations join them as it reads; nothing here is written by an LLM.
--
-- Runner-managed: idempotent.

CREATE TABLE IF NOT EXISTS person_links (
  user_id uuid NOT NULL,
  a text NOT NULL,
  b text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, a, b)
);

CREATE TABLE IF NOT EXISTS person_names (
  user_id uuid NOT NULL,
  handle text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, handle, kind)
);
