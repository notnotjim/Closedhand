-- 077_whatsapp_known_names.sql: names Closedhand learns from WhatsApp are kept.
--
-- WhatsApp says what a chat is called (the contact book, the name a person or
-- business gives themselves) mostly once, when it is linked, and often after
-- the messages it names were stored. Those names lived only in the bot's
-- memory, so a restart forgot them and hundreds of chats stayed filed under a
-- number. name_whatsapp_chats now also takes the names the bot has learned
-- ("known", chat id to name), puts them first, and writes them into that
-- chat's numbered rows, where they outlast a restart and name the chat's later
-- rows and day summaries (lib/services/wa-digest.js). Called with no names it
-- works as before. Safe to run again.

DROP FUNCTION IF EXISTS name_whatsapp_chats(uuid);

CREATE OR REPLACE FUNCTION name_whatsapp_chats(match_user_id uuid, known jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(chat text, name text)
LANGUAGE sql AS $fn$
  WITH names AS (
    SELECT DISTINCT ON (c.chat) c.chat, c.name FROM (
      SELECT k.key AS chat, k.value AS name, 0 AS pref, now() AS received_at
        FROM jsonb_each_text(coalesce(known, '{}'::jsonb)) k
       WHERE coalesce(k.value, '') !~ '^[0-9+() -]*$'
      UNION ALL
      SELECT dc.data->>'chat', dc.data->>'chat_name', 1, dc.received_at
        FROM data_cache dc
       WHERE dc.user_id = match_user_id AND dc.source = 'whatsapp'
         AND coalesce(dc.data->>'chat_name', '') !~ '^[0-9+() -]*$'
      UNION ALL
      SELECT dc.data->>'chat', dc.data->>'sender', 2, dc.received_at
        FROM data_cache dc
       WHERE dc.user_id = match_user_id AND dc.source = 'whatsapp'
         AND dc.data->>'chat' NOT LIKE '%@g.us'
         AND dc.data->>'sender' <> 'me'
         AND coalesce(dc.data->>'sender', '') !~ '^[0-9+() -]*$'
    ) c
    WHERE c.chat IS NOT NULL
    ORDER BY c.chat, c.pref, c.received_at DESC NULLS LAST
  ), renamed AS (
    -- Runs whether or not anything reads it, as every data-changing WITH does.
    UPDATE data_cache dc
       SET data = jsonb_set(dc.data, '{chat_name}', to_jsonb(n.name))
      FROM names n
     WHERE dc.user_id = match_user_id AND dc.source = 'whatsapp'
       AND dc.data->>'chat' = n.chat
       AND coalesce(dc.data->>'chat_name', '') ~ '^[0-9+() -]*$'
    RETURNING 1
  )
  SELECT n.chat, n.name FROM names n;
$fn$;
