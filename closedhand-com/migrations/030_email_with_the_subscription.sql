-- What an account without the free days, the subscription or a plan paid
-- ahead is told when Closedhand's email address refuses mail: the product is
-- the Closedhand subscription now. The function is otherwise as migration 028
-- made it, so only that sentence changes, and a definition that no longer
-- holds it stops the migration rather than passing quietly.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('reserve_mail_relay_usage(text, uuid, text, integer, bigint)'::regprocedure);
  IF position('only with Closedhand Managed Models, which' IN def) = 0 THEN
    RAISE EXCEPTION 'reserve_mail_relay_usage no longer holds the sentence to change';
  END IF;
  EXECUTE replace(def, 'only with Closedhand Managed Models, which', 'only with the Closedhand subscription, which');
END $$;
