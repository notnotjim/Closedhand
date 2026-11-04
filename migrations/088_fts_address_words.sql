-- 088_fts_address_words.sql — the words inside an email or web address are
-- found by the word search.
--
-- Postgres's text-search parser keeps an email address or a host name as one
-- token: info@harbour-homes.example and www.harbour-homes.example never gave
-- "harbour" or "homes" as words of their own. A task asked to find what an
-- estate agency had sent searched for the agency by name, and a message that
-- held only its address, on a line of its own, could not match; neither
-- could a link to its site. Measured on a real cache: the two messages
-- holding an agency's address and website were not found by its name, and
-- are with this.
--
-- Each address in an item's own text (not its From and To lines, which carry
-- the sender's name already and would make every email match its mail
-- provider) adds its words: the part before the @, and the name of the place,
-- without "www" or the endings (.com, .co.uk). A free mail provider's name
-- (gmail, outlook, icloud) says nothing about whose address it is, so it adds
-- nothing. The address itself stays a word too, so a search for the whole
-- address still finds it.
--
-- Existing rows are rebuilt once, in committed batches, as 032 and 037 did.
--
-- Runner-managed: idempotent.

CREATE OR REPLACE FUNCTION data_cache_fts(d jsonb) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fts$
  WITH t AS (SELECT regexp_replace(left(
    coalesce(d->>'from', '')        || ' ' ||
    coalesce(d->>'to', '')          || ' ' ||
    coalesce(d->>'subject', '')     || ' ' ||
    coalesce(d->>'summary', '')     || ' ' ||
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
    '[/?&=#]+', ' ', 'g') AS s)
  SELECT to_tsvector('simple', t.s) || to_tsvector('simple', regexp_replace(coalesce((
    SELECT string_agg(regexp_replace(regexp_replace(regexp_replace(m[1], '^www\.', '', 'i'), '(\.[A-Za-z0-9]{1,3})+$', ''), '[@.]', ' ', 'g'), ' ')
    FROM regexp_matches(substr(t.s, length(coalesce(d->>'from', '') || ' ' || coalesce(d->>'to', '') || ' ') + 1), '([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})', 'g') m), ''),
    '\m(gmail|googlemail|outlook|hotmail|live|msn|icloud|me|mac|yahoo|ymail|aol|proton|protonmail|pm|gmx)\M', ' ', 'gi'))
  FROM t
$fts$;

CREATE OR REPLACE PROCEDURE data_cache_fts_rebuild()
LANGUAGE plpgsql AS $proc$
DECLARE
  last_id uuid := '00000000-0000-0000-0000-000000000000';
  batch_max uuid;
  touched int;
BEGIN
  LOOP
    SELECT id INTO batch_max FROM (
      SELECT id FROM data_cache WHERE id > last_id ORDER BY id LIMIT 2000
    ) b ORDER BY id DESC LIMIT 1;
    EXIT WHEN batch_max IS NULL;

    UPDATE data_cache SET fts = data_cache_fts(data)
    WHERE id > last_id AND id <= batch_max;
    GET DIAGNOSTICS touched = ROW_COUNT;

    last_id := batch_max;
    COMMIT;
    EXIT WHEN touched = 0;
  END LOOP;
END
$proc$;

CALL data_cache_fts_rebuild();

DROP PROCEDURE IF EXISTS data_cache_fts_rebuild();
