-- Migration 243: Growth credit system hardening — setup DDL only
-- Functions moved to migrations 255-258 for single-statement compatibility.
DO $setup$ BEGIN
  -- 1. Add CHECK constraints independently (one failing must not skip others)
  BEGIN
    ALTER TABLE public.growth_credits ADD CONSTRAINT chk_credits_amount_positive CHECK (amount > 0);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER TABLE public.growth_credits ADD CONSTRAINT chk_credits_remaining_non_negative CHECK (remaining >= 0);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER TABLE public.growth_credits ADD CONSTRAINT chk_credits_remaining_lte_amount CHECK (remaining <= amount);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  -- 2. Add reservation lifecycle tracking to growth_campaigns
  ALTER TABLE public.growth_campaigns
    ADD COLUMN IF NOT EXISTS reservation_id UUID DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS reservation_status TEXT DEFAULT 'none'
      CHECK (reservation_status IN ('none', 'reserved', 'partially_consumed', 'consumed', 'released', 'expired')),
    ADD COLUMN IF NOT EXISTS reservation_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_idempotency
    ON public.growth_campaigns(business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

  -- 3. Drop old campaign unique constraint
  ALTER TABLE public.growth_campaigns DROP CONSTRAINT IF EXISTS uq_growth_campaign_dedup;
END $setup$;
