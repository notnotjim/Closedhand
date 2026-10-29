-- 079_rag_name_search.sql: File Search finds a file by its name as soon as
-- its source has been scanned, close spellings included.
--
-- Until now a file was searchable only once its contents had been read, and a
-- first scan of a Drive full of photos reads them for hours: "certificate"
-- found nothing while the PDFs named so were still waiting behind the photos.
-- Files that can never be read (a .mov, a folder) never appeared at all.
-- rag-processor now lists every file and folder of a source by name first, and
-- this function searches those names for doc-search's name arm. A file that
-- failed to be read is still found by its name.
--
-- pg_trgm makes "certifcate" find "Registration Certificate.pdf". It ships with
-- Postgres's contrib modules, which the Docker image and Railway's have; a
-- Postgres without them (an older Mac app) matches the typed words at the
-- start of words in names instead, never failing the search.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable (%): File Search matches names by the text typed', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_rag_documents_name_trgm ON rag_documents USING gin (lower(name) gin_trgm_ops)';
  END IF;
END $$;

-- What counts as a match: the typed words at the start of words in the name
-- ("cert" finds "Certificate", "0042" finds "IMG_0042.jpg", "rent" does not
-- find "parent"), or, with pg_trgm, a whole word spelt close enough
-- (strict_word_similarity at its 0.5 default: "invoce", "recipt" and
-- "pasport" score 0.5 to 0.7 against the right word, while lookalikes such as
-- "password" for "passport" or "recipe" for "receipt" score 0.25 to 0.29).
CREATE OR REPLACE FUNCTION search_rag_documents_by_name(match_user_id uuid, query text, match_count integer DEFAULT 20)
RETURNS TABLE (id uuid, name text, origin text, file_path text, file_type text, status text, updated_at timestamptz, score real)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  q text := btrim(regexp_replace(lower(query), '[^[:alnum:]]+', ' ', 'g'));
BEGIN
  IF q = '' THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    -- Built at run time so this function exists, and works, without pg_trgm.
    RETURN QUERY EXECUTE
      'SELECT d.id, d.name, d.origin, d.file_path, d.file_type, d.status, d.updated_at,
              greatest(strict_word_similarity($2, lower(d.name)),
                       CASE WHEN position('' '' || $2 in '' '' || regexp_replace(lower(d.name), ''[^[:alnum:]]+'', '' '', ''g'')) > 0 THEN 1 ELSE 0 END)::real AS score
         FROM rag_documents d
        WHERE d.user_id = $1
          AND ($2 <<% lower(d.name) OR position('' '' || $2 in '' '' || regexp_replace(lower(d.name), ''[^[:alnum:]]+'', '' '', ''g'')) > 0)
        ORDER BY score DESC, d.updated_at DESC
        LIMIT $3'
      USING match_user_id, q, match_count;
  ELSE
    RETURN QUERY
      SELECT d.id, d.name, d.origin, d.file_path, d.file_type, d.status, d.updated_at, 1::real AS score
        FROM rag_documents d
       WHERE d.user_id = match_user_id
         AND position(' ' || q in ' ' || regexp_replace(lower(d.name), '[^[:alnum:]]+', ' ', 'g')) > 0
       ORDER BY d.updated_at DESC
       LIMIT match_count;
  END IF;
END $$;
