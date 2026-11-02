-- 084_paying_for.sql: what the person pays for again and again (lib/paying-for.js),
-- one picture each, built from every source Closedhand indexes.
CREATE TABLE IF NOT EXISTS paying_for (
  user_id uuid NOT NULL,
  picture jsonb NOT NULL DEFAULT '[]'::jsonb,   -- one entry per thing paid for
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,   -- the kinds of source it was built from
  built_at timestamp with time zone,
  first_look_at timestamp with time zone,       -- when the page was made and they were told
  page_id uuid,
  told jsonb NOT NULL DEFAULT '{}'::jsonb,      -- entry key -> what Pulse told them about it, and when
  CONSTRAINT paying_for_pkey PRIMARY KEY (user_id)
);

-- The items that look like paying, a page at a time: mail by its subject or
-- billing phrases, anything else by the same words in its text. Bank payments
-- are read apart (lib/paying-for.js), where a steady interval is what counts.
CREATE OR REPLACE FUNCTION public.paying_candidates(p_user_id uuid, p_since timestamp with time zone, p_subject text, p_body text, p_offset integer, p_limit integer)
RETURNS TABLE (source text, type text, external_id text, received_at timestamp with time zone, created_at timestamp with time zone, data jsonb)
LANGUAGE sql STABLE AS $function$
  SELECT d.source, d.type, d.external_id, d.received_at, d.created_at, d.data
    FROM data_cache d
   WHERE d.user_id = p_user_id AND d.received_at > p_since
     AND d.type NOT IN ('bank_transaction', 'bank_account')
     AND CASE WHEN d.type = 'email'
       THEN coalesce(d.data->>'subject', '') ~* p_subject OR left(coalesce(d.data->>'body', d.data->>'snippet', ''), 4000) ~* p_body
       ELSE left(concat_ws(' ', d.data->>'text', d.data->>'summary', d.data->>'title', d.data->>'description', d.data->>'content'), 4000) ~* (p_subject || '|' || p_body)
     END
   ORDER BY d.received_at DESC, d.id
  OFFSET p_offset LIMIT p_limit
$function$;

-- A sign each sender is still used: its newest email that is not about
-- paying (an order, a booking, a summary of activity), one per address domain.
CREATE OR REPLACE FUNCTION public.paying_activity(p_user_id uuid, p_since timestamp with time zone, p_domains text[], p_subject text)
RETURNS TABLE (domain text, received_at timestamp with time zone, subject text)
LANGUAGE sql STABLE AS $function$
  SELECT DISTINCT ON (x.domain) x.domain, x.received_at, x.subject
    FROM (SELECT lower(substring(d.data->>'from' from '@([^>[:space:]]+)')) AS domain, d.received_at, d.data->>'subject' AS subject
            FROM data_cache d
           WHERE d.user_id = p_user_id AND d.type = 'email' AND d.received_at > p_since
             AND coalesce(d.data->>'subject', '') !~* p_subject
             AND NOT coalesce((d.data->'labels') ? 'SENT', false)) x
   WHERE x.domain = ANY(p_domains)
   ORDER BY x.domain, x.received_at DESC
$function$;
