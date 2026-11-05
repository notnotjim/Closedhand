-- Messages people send from the website's "Send us a message"
-- (lib/messages.js): the words, the page they were sent from and, if given,
-- an email to reply to. Nothing else about the sender: no name, no internet
-- address. Each is told to the maintainer as a notice (notice_id), and the
-- two are deleted together once answered, or after 90 days.
CREATE TABLE IF NOT EXISTS site_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message text NOT NULL,
  reply_to text,
  page text,
  notice_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_messages_age ON site_messages (created_at);
