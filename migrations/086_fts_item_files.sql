-- The files that come with any item (an email's attachments, an event's
-- Drive files, a chat's photos, documents and voice notes) are read whole
-- (lib/item-files.js) and kept on its cached row as file_texts, and an
-- email's body is kept whole too. The word search reads the files as well, so
-- a booking reference that is only in a PDF is found by its exact words; the
-- trigger rebuilds a row's words whenever it is written. A row's words are
-- taken from its first million characters, so one enormous document can
-- never make saving it fail (a tsvector must stay under a megabyte); its
-- meaning search covers all of it.
CREATE OR REPLACE FUNCTION data_cache_fts(d jsonb) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fts$
  SELECT to_tsvector('simple', regexp_replace(left(
    coalesce(d->>'subject', '')     || ' ' ||
    coalesce(d->>'summary', '')     || ' ' ||
    coalesce(d->>'from', '')        || ' ' ||
    coalesce(d->>'to', '')          || ' ' ||
    coalesce(d->>'location', '')    || ' ' ||
    coalesce(d->>'description', '') || ' ' ||
    coalesce(d->>'snippet', '')     || ' ' ||
    coalesce(d->>'body', '')        || ' ' ||
    coalesce(d->>'text', '')        || ' ' ||
    coalesce(d->>'sender', '')      || ' ' ||
    coalesce(d->>'chat_name', '')   || ' ' ||
    coalesce(d->>'title', '')       || ' ' ||
    coalesce(d->>'content', '')     || ' ' ||
    coalesce((SELECT string_agg(a->>'text', ' ') FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(d->'file_texts') = 'array' THEN d->'file_texts' ELSE '[]'::jsonb END) a), ''),
    1000000),
    '[/?&=#]+', ' ', 'g'))
$fts$;
