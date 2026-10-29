-- When Closedhand last opened a file the person sent (lib/attachments.js),
-- so the file is deleted 90 days after its last use rather than its arrival
-- (lib/file-expiry.js).
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
UPDATE attachments SET last_used_at = created_at WHERE last_used_at IS NULL;
ALTER TABLE attachments ALTER COLUMN last_used_at SET DEFAULT now();
