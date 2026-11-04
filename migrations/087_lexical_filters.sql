-- 087_lexical_filters.sql — the word search filters before it limits.
--
-- search_data_cache_lexical could filter by one type only. Every other filter
-- (a source, "everything but mail") was applied by its callers to the rows it
-- returned, after its LIMIT. A word common in mail filled every slot: a
-- business partner's name matched 2,058 emails, 87 events and 38 WhatsApp
-- messages, the top 60 were all mail, and a search of WhatsApp for him found
-- nothing, though his message from the day before was there and the newest
-- match. Recall's word arm had the same flaw without any filter: twenty
-- emails, so no chat, event or page could be a candidate however well it
-- matched.
--
-- exclude_type and filter_source (a prefix, so 'gmail' covers every Gmail
-- account) now filter inside the query. per_type caps how many rows one type
-- may take, so a mixed search gives every kind of item a share of the
-- candidates; the best of each is still ordered by rank, then newest first.
--
-- Callers name their arguments, so the existing ones keep working. Adding
-- parameters changes the signature, hence the DROP of the old one.
--
-- Runner-managed: every statement is idempotent (see lib/migrations.js).

DROP FUNCTION IF EXISTS search_data_cache_lexical(uuid, text[], int, text);

CREATE OR REPLACE FUNCTION search_data_cache_lexical(
  match_user_id uuid,
  query_tokens text[],
  match_count int DEFAULT 20,
  filter_type text DEFAULT NULL,
  exclude_type text DEFAULT NULL,
  filter_source text DEFAULT NULL,
  per_type int DEFAULT NULL
) RETURNS TABLE (
  external_id text,
  source text,
  type text,
  data jsonb,
  rank real,
  synced_at timestamptz
) LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  q tsquery := NULL;
  tok text;
  part tsquery;
BEGIN
  IF query_tokens IS NULL OR array_length(query_tokens, 1) IS NULL THEN
    RETURN;
  END IF;

  FOREACH tok IN ARRAY query_tokens LOOP
    part := plainto_tsquery('simple', tok);
    IF part IS NOT NULL AND numnode(part) > 0 THEN
      q := CASE WHEN q IS NULL THEN part ELSE q || part END;
    END IF;
  END LOOP;

  IF q IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT m.external_id, m.source, m.type, m.data, m.rank, m.synced_at
  FROM (
    SELECT dc.external_id, dc.source, dc.type, dc.data, dc.synced_at, dc.received_at,
           ts_rank_cd(dc.fts, q) AS rank,
           row_number() OVER (PARTITION BY dc.type
             ORDER BY ts_rank_cd(dc.fts, q) DESC, dc.received_at DESC NULLS LAST) AS nth
    FROM data_cache dc
    WHERE dc.user_id = match_user_id
      AND (filter_type IS NULL OR dc.type = filter_type)
      AND (exclude_type IS NULL OR dc.type <> exclude_type)
      AND (filter_source IS NULL OR left(dc.source, length(filter_source)) = filter_source)
      AND dc.fts @@ q
  ) m
  WHERE per_type IS NULL OR m.nth <= per_type
  ORDER BY m.rank DESC, m.received_at DESC NULLS LAST
  LIMIT match_count;
END
$fn$;
