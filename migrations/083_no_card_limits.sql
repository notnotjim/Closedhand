-- 083_no_card_limits.sql: spending rules are one set for every card, set in
-- the Wallet's Spending rules; a card no longer has limits of its own.
ALTER TABLE wallet_cards DROP COLUMN IF EXISTS limits;
