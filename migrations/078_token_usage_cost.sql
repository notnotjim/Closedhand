-- 078: Usage keeps, beside the tokens, how many of those sent the LLM
-- provider had already seen (cached: charged far less) and, where the
-- provider reports it in its reply, what the calls cost. Usage then shows
-- what the person's own LLM provider charges. cache_known marks the rows
-- counted this way: older ones never told cached tokens apart.

ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS tokens_cached bigint NOT NULL DEFAULT 0;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS cost_usd numeric NOT NULL DEFAULT 0;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS costed_calls integer NOT NULL DEFAULT 0;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS cache_known boolean NOT NULL DEFAULT false;

-- One function: the old one, without these, would make named calls ambiguous.
DROP FUNCTION IF EXISTS public.record_token_usage(uuid, date, text, text, integer, bigint, bigint);

CREATE OR REPLACE FUNCTION public.record_token_usage(
  p_user_id uuid,
  p_day date,
  p_feature text,
  p_model text,
  p_calls integer,
  p_tokens_in bigint,
  p_tokens_out bigint,
  p_tokens_cached bigint DEFAULT 0,
  p_cost_usd numeric DEFAULT 0,
  p_costed_calls integer DEFAULT 0
) RETURNS void
LANGUAGE sql
AS $function$
  INSERT INTO token_usage (user_id, day, feature, model, calls, tokens_in, tokens_out, tokens_cached, cost_usd, costed_calls, cache_known)
  VALUES (p_user_id, p_day, p_feature, p_model, p_calls, p_tokens_in, p_tokens_out, p_tokens_cached, p_cost_usd, p_costed_calls, true)
  ON CONFLICT (user_id, day, feature, model) DO UPDATE SET
    calls = token_usage.calls + EXCLUDED.calls,
    tokens_in = token_usage.tokens_in + EXCLUDED.tokens_in,
    tokens_out = token_usage.tokens_out + EXCLUDED.tokens_out,
    tokens_cached = token_usage.tokens_cached + EXCLUDED.tokens_cached,
    cost_usd = token_usage.cost_usd + EXCLUDED.cost_usd,
    costed_calls = token_usage.costed_calls + EXCLUDED.costed_calls,
    updated_at = now();
$function$;
