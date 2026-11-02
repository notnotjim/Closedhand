-- An item longer than the embedder reads in one go is indexed whole, in
-- pieces: its first piece is its own row, and each further piece is a row of
-- its own pointing at it. Deleting the item's row, wherever that happens,
-- takes its pieces with it.
ALTER TABLE data_vectors ADD COLUMN IF NOT EXISTS piece_of uuid REFERENCES data_vectors(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS data_vectors_piece_of_idx ON data_vectors (piece_of) WHERE piece_of IS NOT NULL;
