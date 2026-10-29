-- A table Closedhand keeps up to date is a page (lib/table-pages.js): one row
-- in reports per table, rewritten as the table changes, never archived, and
-- deleted with the table.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS dataset_id uuid REFERENCES datasets(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS reports_dataset_id_key ON reports(dataset_id) WHERE dataset_id IS NOT NULL;
