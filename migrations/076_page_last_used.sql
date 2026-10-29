-- When a page was last opened, downloaded, read or sent, so it moves into
-- Archived a week after its last use and is deleted three months after that
-- (lib/page-expiry.js), rather than counting from when it was made.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS last_opened_at timestamptz;
UPDATE reports SET last_opened_at = created_at WHERE last_opened_at IS NULL;
ALTER TABLE reports ALTER COLUMN last_opened_at SET DEFAULT now();
