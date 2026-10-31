-- M468: Currency-aware payout dedup; depends on M466 currency columns.
-- M467 is reserved by PR #711 for subscription pricing: do not reuse its ID.
-- Existing historical NULL-currency records remain unchanged and require reconciliation.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='business_payouts' AND column_name='currency') THEN
    RAISE EXCEPTION 'M468 requires M466 business_payouts.currency';
  END IF;
END $$;
DROP INDEX IF EXISTS public.idx_business_payouts_period_unique;
CREATE UNIQUE INDEX idx_business_payouts_period_unique
  ON public.business_payouts (business_id, period_start, period_end, COALESCE(currency, '__legacy__'))
  WHERE status NOT IN ('rejected', 'failed');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_business_payouts_period_unique' AND indexdef LIKE '%COALESCE%currency%') THEN
    RAISE EXCEPTION 'M468 currency-aware unique index verification failed';
  END IF;
END $$;
COMMIT;
