-- 082_schedule_kind.sql: a schedule set in chat says what it is. A reminder
-- tells the person something at that moment and shows on Upcoming; a task is
-- work Closedhand does then, waits under Waiting to start on the Agents tab,
-- and runs as a task when it fires.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'reminder';
