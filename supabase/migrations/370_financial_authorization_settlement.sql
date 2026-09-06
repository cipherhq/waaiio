-- ═══════════════════════════════════════════════════════
-- 370: Financial Authorization & Settlement (S-2, #260)
--
-- Atomic spend authorization and terminal settlement RPCs.
-- Business-scoped only: platform attempts are rejected.
-- Multi-currency: pricing, allowances, and spend caps are
-- currency-isolated with zero cross-currency leakage.
--
-- Surfaces:
--   NEW TABLE: messaging_spend_periods
--   ALTERED CHECK: message_cost_events.charge_type adds 'mixed'
--   NEW RPC: authorize_message_send(UUID) — reservation authority
--   NEW RPC: settle_message_cost(UUID, TEXT) — terminal settlement
--
-- No runtime wiring, no send-path changes, no #261 implementation.
-- ═══════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════
-- 1. messaging_spend_periods — business-owned monthly spend caps
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.messaging_spend_periods (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  currency_code     TEXT NOT NULL,
  period_start      TIMESTAMPTZ NOT NULL,
  cap_minor         INTEGER NOT NULL CHECK (cap_minor >= 0),
  reserved_minor    INTEGER NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  spent_minor       INTEGER NOT NULL DEFAULT 0 CHECK (spent_minor >= 0),
  config_version_id UUID REFERENCES public.platform_config_versions(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(business_id, currency_code, period_start),
  CHECK (reserved_minor + spent_minor <= cap_minor)
);

CREATE INDEX IF NOT EXISTS idx_msp_business ON messaging_spend_periods(business_id);
CREATE INDEX IF NOT EXISTS idx_msp_business_currency_period
  ON messaging_spend_periods(business_id, currency_code, period_start);

-- ── 1b. RLS ──

ALTER TABLE messaging_spend_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY msp_owner_select ON messaging_spend_periods
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.businesses WHERE id = messaging_spend_periods.business_id AND owner_id = auth.uid()
  ));

CREATE POLICY msp_admin_select ON messaging_spend_periods
  FOR SELECT USING (public.is_admin());

-- ── 1c. Grants ──

REVOKE ALL ON messaging_spend_periods FROM PUBLIC, authenticated, service_role, anon;
GRANT SELECT ON messaging_spend_periods TO authenticated;
GRANT SELECT, INSERT, UPDATE ON messaging_spend_periods TO service_role;

-- ══════════════════════════════════════════════════════════
-- 2. Extend message_cost_events.charge_type CHECK to include 'mixed'
-- ══════════════════════════════════════════════════════════

-- Drop the existing CHECK constraint on charge_type and re-add with 'mixed'
DO $$
DECLARE
  v_constraint_name TEXT;
BEGIN
  -- Find the CHECK constraint that enforces charge_type values
  SELECT conname INTO v_constraint_name
    FROM pg_constraint
    WHERE conrelid = 'public.message_cost_events'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%charge_type%'
      AND pg_get_constraintdef(oid) LIKE '%included%'
    LIMIT 1;

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.message_cost_events DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END;
$$;

ALTER TABLE public.message_cost_events
  ADD CONSTRAINT chk_charge_type CHECK (
    charge_type IS NULL OR charge_type IN ('included', 'overage', 'mixed', 'waived', 'unpriced')
  );

-- Verify the unpriced invariant CHECK still exists (it references charge_type too)
-- (It was a separate CHECK on the column, so dropping the enum CHECK should not affect it)
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_constraint
    WHERE conrelid = 'public.message_cost_events'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%unpriced%'
      AND pg_get_constraintdef(oid) LIKE '%amount_minor%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 370 VERIFICATION FAILED: unpriced invariant CHECK missing after charge_type modification';
  END IF;
END;
$$;

-- ══════════════════════════════════════════════════════════
-- 3. authorize_message_send(UUID) — atomic reservation authority
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.authorize_message_send(p_attempt_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  -- Attempt state
  v_attempt RECORD;
  -- Pricing resolution
  v_config RECORD;
  v_pricing JSONB;
  v_currency_bucket JSONB;
  v_resolved_currency TEXT;
  v_resolved_cost INTEGER;
  v_country TEXT;
  v_category TEXT;
  v_matching_currencies TEXT[];
  -- Spend period
  v_period_start TIMESTAMPTZ;
  v_period RECORD;
  -- Allowance reservation
  v_allowance RECORD;
  v_slice INTEGER;
  v_remaining_cost INTEGER;
  v_total_reserved INTEGER := 0;
  v_has_included BOOLEAN := false;
  v_has_purchased BOOLEAN := false;
  v_charge_type TEXT;
BEGIN
  -- ── Step 1: Lock attempt row ──
  SELECT * INTO v_attempt
    FROM public.message_send_attempts
    WHERE id = p_attempt_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'attempt_not_found');
  END IF;

  -- ── Step 2: Check financial_disposition ──
  IF v_attempt.financial_disposition = 'reserved' THEN
    -- Idempotent replay: return existing reservation
    RETURN jsonb_build_object('authorized', true, 'reason', 'already_reserved', 'idempotent', true);
  END IF;

  IF v_attempt.financial_disposition IN ('charged', 'released') THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'attempt_terminally_settled');
  END IF;

  IF v_attempt.financial_disposition <> 'pending_authorization' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'unexpected_disposition');
  END IF;

  -- ── Step 3: Business-only boundary ──
  IF v_attempt.attempt_scope <> 'business' OR v_attempt.business_id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'not_business_scoped');
  END IF;

  -- ── Step 4: Resolve trusted pricing from effective-dated config ──
  SELECT id, config_snapshot INTO v_config
    FROM public.platform_config_versions
    WHERE effective_from <= NOW()
    ORDER BY effective_from DESC
    LIMIT 1;

  IF v_config.id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_pricing_config');
  END IF;

  v_pricing := v_config.config_snapshot -> 'messaging_pricing';
  IF v_pricing IS NULL OR jsonb_typeof(v_pricing) <> 'object' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_messaging_pricing');
  END IF;

  -- Resolve country and category from attempt
  v_country := v_attempt.recipient_country_code;
  v_category := v_attempt.message_category;

  IF v_country IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'missing_country_code');
  END IF;

  -- Find which currency bucket(s) contain a rate for this country
  v_matching_currencies := ARRAY[]::TEXT[];
  FOR v_resolved_currency IN SELECT key FROM jsonb_each(v_pricing)
  LOOP
    v_currency_bucket := v_pricing -> v_resolved_currency;
    IF jsonb_typeof(v_currency_bucket) = 'object' THEN
      -- Check if this bucket has rates for the country OR a default_cost_minor
      IF v_currency_bucket -> 'rates' -> v_country IS NOT NULL THEN
        v_matching_currencies := v_matching_currencies || v_resolved_currency;
      ELSIF v_currency_bucket -> 'default_cost_minor' IS NOT NULL THEN
        -- Only count as matching if there are no country-specific rates at all,
        -- or if this is the only bucket. We'll handle this below.
        NULL;
      END IF;
    END IF;
  END LOOP;

  -- If no country-specific match found, look for buckets with default_cost_minor as fallback
  IF array_length(v_matching_currencies, 1) IS NULL OR array_length(v_matching_currencies, 1) = 0 THEN
    FOR v_resolved_currency IN SELECT key FROM jsonb_each(v_pricing)
    LOOP
      v_currency_bucket := v_pricing -> v_resolved_currency;
      IF jsonb_typeof(v_currency_bucket) = 'object'
         AND v_currency_bucket -> 'default_cost_minor' IS NOT NULL THEN
        v_matching_currencies := v_matching_currencies || v_resolved_currency;
      END IF;
    END LOOP;
  END IF;

  -- Exactly one currency must match — zero or multiple = fail closed
  IF array_length(v_matching_currencies, 1) IS NULL OR array_length(v_matching_currencies, 1) = 0 THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_currency_for_country');
  END IF;

  IF array_length(v_matching_currencies, 1) > 1 THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'ambiguous_currency_for_country');
  END IF;

  v_resolved_currency := v_matching_currencies[1];
  v_currency_bucket := v_pricing -> v_resolved_currency;

  -- Resolve rate: rates[country][category] → rates[country] default → default_cost_minor
  v_resolved_cost := NULL;

  IF v_category IS NOT NULL
     AND v_currency_bucket -> 'rates' -> v_country -> v_category IS NOT NULL
     AND jsonb_typeof(v_currency_bucket -> 'rates' -> v_country -> v_category) = 'number' THEN
    v_resolved_cost := (v_currency_bucket -> 'rates' -> v_country -> v_category)::INTEGER;
  ELSIF v_currency_bucket -> 'rates' -> v_country IS NOT NULL THEN
    -- If the country key exists but not the specific category, try default_cost_minor
    IF v_currency_bucket -> 'default_cost_minor' IS NOT NULL
       AND jsonb_typeof(v_currency_bucket -> 'default_cost_minor') = 'number' THEN
      v_resolved_cost := (v_currency_bucket -> 'default_cost_minor')::INTEGER;
    END IF;
  ELSIF v_currency_bucket -> 'default_cost_minor' IS NOT NULL
     AND jsonb_typeof(v_currency_bucket -> 'default_cost_minor') = 'number' THEN
    v_resolved_cost := (v_currency_bucket -> 'default_cost_minor')::INTEGER;
  END IF;

  IF v_resolved_cost IS NULL OR v_resolved_cost < 0 THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'unresolved_rate');
  END IF;

  -- Never synthesize a zero price for missing configuration
  -- (zero is a valid explicitly-configured price, but NULL resolution means missing)

  -- ── Step 4b: Validate against any prepopulated attempt pricing ──
  IF v_attempt.estimated_cost_minor IS NOT NULL AND v_attempt.estimated_cost_minor <> v_resolved_cost THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'pricing_mismatch',
      'expected_cost', v_resolved_cost, 'prepopulated_cost', v_attempt.estimated_cost_minor);
  END IF;

  IF v_attempt.currency_code IS NOT NULL AND v_attempt.currency_code <> v_resolved_currency THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'currency_mismatch',
      'expected_currency', v_resolved_currency, 'prepopulated_currency', v_attempt.currency_code);
  END IF;

  IF v_attempt.config_version_id IS NOT NULL AND v_attempt.config_version_id <> v_config.id THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'config_version_mismatch');
  END IF;

  -- ── Step 5: Determine UTC period key ──
  v_period_start := date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  -- ── Step 6: Find or create spend period ──
  -- Race-safe: INSERT ON CONFLICT DO NOTHING then SELECT FOR UPDATE
  DECLARE
    v_cap_minor INTEGER;
  BEGIN
    -- Resolve cap from config
    v_cap_minor := NULL;
    IF v_currency_bucket -> 'default_spend_cap_minor' IS NOT NULL
       AND jsonb_typeof(v_currency_bucket -> 'default_spend_cap_minor') = 'number' THEN
      v_cap_minor := (v_currency_bucket -> 'default_spend_cap_minor')::INTEGER;
    END IF;

    IF v_cap_minor IS NULL THEN
      RETURN jsonb_build_object('authorized', false, 'reason', 'no_spend_cap_for_currency');
    END IF;

    INSERT INTO public.messaging_spend_periods (business_id, currency_code, period_start, cap_minor, config_version_id)
    VALUES (v_attempt.business_id, v_resolved_currency, v_period_start, v_cap_minor, v_config.id)
    ON CONFLICT (business_id, currency_code, period_start) DO NOTHING;
  END;

  -- ── Step 7: Lock spend-period row ──
  SELECT * INTO v_period
    FROM public.messaging_spend_periods
    WHERE business_id = v_attempt.business_id
      AND currency_code = v_resolved_currency
      AND period_start = v_period_start
    FOR UPDATE;

  -- ── Step 8: Enforce cap headroom ──
  IF v_period.reserved_minor + v_period.spent_minor + v_resolved_cost > v_period.cap_minor THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'spend_cap_exceeded',
      'cap', v_period.cap_minor, 'reserved', v_period.reserved_minor,
      'spent', v_period.spent_minor, 'cost', v_resolved_cost);
  END IF;

  -- ── Step 9: Lock eligible same-currency allowance rows (FIFO, deterministic) ──
  -- Canonical ordering: created_at ASC, id ASC (stable tiebreaker)
  v_remaining_cost := v_resolved_cost;

  FOR v_allowance IN
    SELECT * FROM public.messaging_allowances
    WHERE business_id = v_attempt.business_id
      AND currency_code = v_resolved_currency
      AND remaining_minor > 0
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at ASC, id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_cost <= 0;

    -- ── Step 10: Reserve exact slice ──
    v_slice := LEAST(v_allowance.remaining_minor, v_remaining_cost);

    -- Decrement allowance
    UPDATE public.messaging_allowances
      SET remaining_minor = remaining_minor - v_slice
      WHERE id = v_allowance.id;

    -- Track funding type
    IF v_allowance.type IN ('trial_grant', 'subscription_included', 'promotional') THEN
      v_has_included := true;
    ELSIF v_allowance.type = 'purchased' THEN
      v_has_purchased := true;
    END IF;

    -- ── Step 11a: Append per-allowance reserve event ──
    INSERT INTO public.messaging_allowance_events (
      allowance_id, business_id, event_type, amount_minor, attempt_id,
      charge_type, balance_after_minor
    ) VALUES (
      v_allowance.id, v_attempt.business_id, 'reserve', -v_slice, p_attempt_id,
      CASE
        WHEN v_allowance.type IN ('trial_grant', 'subscription_included', 'promotional') THEN 'included'
        ELSE 'overage'
      END,
      v_allowance.remaining_minor - v_slice
    );

    v_remaining_cost := v_remaining_cost - v_slice;
    v_total_reserved := v_total_reserved + v_slice;
  END LOOP;

  -- Insufficient allowance balance
  IF v_remaining_cost > 0 THEN
    -- Roll back: this will be caught by the transaction abort
    RAISE EXCEPTION 'insufficient_allowance_balance';
  END IF;

  -- ── Step 11b: Determine aggregate charge_type ──
  IF v_has_included AND v_has_purchased THEN
    v_charge_type := 'mixed';
  ELSIF v_has_purchased THEN
    v_charge_type := 'overage';
  ELSE
    v_charge_type := 'included';
  END IF;

  -- ── Step 11c: Append aggregate cost reserve event ──
  INSERT INTO public.message_cost_events (
    attempt_id, event_type, amount_minor, charge_type,
    balance_after_minor, config_version_id
  ) VALUES (
    p_attempt_id, 'reserve', -v_resolved_cost, v_charge_type,
    NULL, v_config.id
  );

  -- ── Step 12: Update period reserved amount ──
  UPDATE public.messaging_spend_periods
    SET reserved_minor = reserved_minor + v_resolved_cost
    WHERE id = v_period.id;

  -- ── Step 13: Atomically bind attempt pricing/period/reservation fields ──
  UPDATE public.message_send_attempts
    SET estimated_cost_minor = v_resolved_cost,
        currency_code = v_resolved_currency,
        config_version_id = v_config.id,
        spend_period_start = v_period_start,
        financial_disposition = 'reserved',
        reserved_at = NOW()
    WHERE id = p_attempt_id;

  -- ── Step 14: Return success ──
  RETURN jsonb_build_object(
    'authorized', true,
    'charge_type', v_charge_type,
    'cost_minor', v_resolved_cost,
    'currency_code', v_resolved_currency,
    'config_version_id', v_config.id::TEXT,
    'idempotent', false
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Transaction-level rollback: all-or-nothing
    -- Re-raise so the caller gets an error and PostgreSQL rolls back
    IF SQLERRM = 'insufficient_allowance_balance' THEN
      RETURN jsonb_build_object('authorized', false, 'reason', 'insufficient_allowance_balance');
    END IF;
    RAISE;
END;
$$;

-- ══════════════════════════════════════════════════════════
-- 4. settle_message_cost(UUID, TEXT) — terminal settlement authority
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.settle_message_cost(p_attempt_id UUID, p_outcome TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_attempt RECORD;
  v_period RECORD;
  v_reserve_event RECORD;
  v_allowance_event RECORD;
  v_allowance RECORD;
  v_cost INTEGER;
  v_charge_type TEXT;
BEGIN
  -- Validate outcome
  IF p_outcome NOT IN ('charged', 'released') THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'invalid_outcome');
  END IF;

  -- ── Step 1: Lock attempt ──
  SELECT * INTO v_attempt
    FROM public.message_send_attempts
    WHERE id = p_attempt_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'attempt_not_found');
  END IF;

  -- ── Step 2: Business-only boundary ──
  IF v_attempt.attempt_scope <> 'business' OR v_attempt.business_id IS NULL THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'not_business_scoped');
  END IF;

  -- ── Step 3: Disposition checks ──
  IF v_attempt.financial_disposition = 'pending_authorization' THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'not_yet_authorized');
  END IF;

  -- Idempotent replay: same terminal outcome
  IF v_attempt.financial_disposition = p_outcome THEN
    RETURN jsonb_build_object('settled', true, 'reason', 'already_settled', 'idempotent', true);
  END IF;

  -- Opposite terminal after one wins
  IF v_attempt.financial_disposition IN ('charged', 'released') THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'already_terminally_settled',
      'current_disposition', v_attempt.financial_disposition);
  END IF;

  IF v_attempt.financial_disposition <> 'reserved' THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'unexpected_disposition');
  END IF;

  -- ── Step 4: Get the reserve cost event to reconstruct cost/charge_type ──
  SELECT * INTO v_reserve_event
    FROM public.message_cost_events
    WHERE attempt_id = p_attempt_id AND event_type = 'reserve';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reserve cost event missing for attempt %', p_attempt_id;
  END IF;

  v_cost := -v_reserve_event.amount_minor;  -- reserve.amount_minor is negative
  v_charge_type := v_reserve_event.charge_type;

  -- ── Step 5: Lock spend period (using persisted spend_period_start) ──
  SELECT * INTO v_period
    FROM public.messaging_spend_periods
    WHERE business_id = v_attempt.business_id
      AND currency_code = v_attempt.currency_code
      AND period_start = v_attempt.spend_period_start
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'spend period missing for attempt %', p_attempt_id;
  END IF;

  -- ── Step 6: Lock and process reserved allowance rows ──
  -- Use same canonical ordering as authorization: created_at ASC, id ASC
  -- Reconstruct exact slices from immutable reserve events
  FOR v_allowance_event IN
    SELECT mae.*, ma.type AS allowance_type
      FROM public.messaging_allowance_events mae
      JOIN public.messaging_allowances ma ON ma.id = mae.allowance_id
      WHERE mae.attempt_id = p_attempt_id
        AND mae.event_type = 'reserve'
      ORDER BY ma.created_at ASC, ma.id ASC
  LOOP
    -- Lock the allowance row
    SELECT * INTO v_allowance
      FROM public.messaging_allowances
      WHERE id = v_allowance_event.allowance_id
      FOR UPDATE;

    IF p_outcome = 'released' THEN
      -- Restore exact slice
      UPDATE public.messaging_allowances
        SET remaining_minor = remaining_minor + (-v_allowance_event.amount_minor)
        WHERE id = v_allowance_event.allowance_id;

      -- Append release event
      INSERT INTO public.messaging_allowance_events (
        allowance_id, business_id, event_type, amount_minor, attempt_id,
        charge_type, balance_after_minor
      ) VALUES (
        v_allowance_event.allowance_id, v_attempt.business_id, 'release',
        -v_allowance_event.amount_minor,  -- positive: restoring
        p_attempt_id,
        CASE WHEN v_allowance.type IN ('trial_grant', 'subscription_included', 'promotional') THEN 'included' ELSE 'overage' END,
        v_allowance.remaining_minor + (-v_allowance_event.amount_minor)
      );
    ELSE
      -- Charge: no second allowance decrement
      INSERT INTO public.messaging_allowance_events (
        allowance_id, business_id, event_type, amount_minor, attempt_id,
        charge_type, balance_after_minor
      ) VALUES (
        v_allowance_event.allowance_id, v_attempt.business_id, 'charge',
        0,  -- no second decrement
        p_attempt_id,
        CASE WHEN v_allowance.type IN ('trial_grant', 'subscription_included', 'promotional') THEN 'included' ELSE 'overage' END,
        v_allowance.remaining_minor  -- unchanged
      );
    END IF;
  END LOOP;

  -- ── Step 7: Update spend period ──
  IF p_outcome = 'charged' THEN
    UPDATE public.messaging_spend_periods
      SET reserved_minor = reserved_minor - v_cost,
          spent_minor = spent_minor + v_cost
      WHERE id = v_period.id;
  ELSE
    -- released
    UPDATE public.messaging_spend_periods
      SET reserved_minor = reserved_minor - v_cost
      WHERE id = v_period.id;
  END IF;

  -- ── Step 8: Append aggregate cost terminal event ──
  INSERT INTO public.message_cost_events (
    attempt_id, event_type, amount_minor, charge_type,
    balance_after_minor, config_version_id
  ) VALUES (
    p_attempt_id,
    CASE WHEN p_outcome = 'charged' THEN 'charge' ELSE 'release' END,
    CASE WHEN p_outcome = 'charged' THEN 0 ELSE v_cost END,  -- charge=0, release=+cost
    v_charge_type,
    NULL,
    v_attempt.config_version_id
  );

  -- ── Step 9: Transition attempt disposition ──
  UPDATE public.message_send_attempts
    SET financial_disposition = p_outcome
    WHERE id = p_attempt_id;

  RETURN jsonb_build_object(
    'settled', true,
    'outcome', p_outcome,
    'cost_minor', v_cost,
    'charge_type', v_charge_type,
    'idempotent', false
  );
END;
$$;

-- ══════════════════════════════════════════════════════════
-- 5. RPC ACL — service-role only, hardened least privilege
-- ══════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.authorize_message_send(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_message_send(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.authorize_message_send(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_message_send(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.settle_message_cost(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_message_cost(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.settle_message_cost(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settle_message_cost(UUID, TEXT) TO service_role;

-- ══════════════════════════════════════════════════════════
-- 6. Migration verification
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count INT;
BEGIN
  -- Verify messaging_spend_periods exists
  SELECT count(*) INTO v_count FROM pg_class WHERE relname = 'messaging_spend_periods';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 370 VERIFICATION FAILED: messaging_spend_periods not created';
  END IF;

  -- Verify RLS enabled on messaging_spend_periods
  SELECT count(*) INTO v_count FROM pg_class WHERE relname = 'messaging_spend_periods' AND relrowsecurity = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 370 VERIFICATION FAILED: messaging_spend_periods RLS not enabled';
  END IF;

  -- Verify charge_type CHECK includes 'mixed'
  SELECT count(*) INTO v_count FROM pg_constraint
    WHERE conrelid = 'public.message_cost_events'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%mixed%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 370 VERIFICATION FAILED: charge_type CHECK does not include mixed';
  END IF;

  -- Verify RPCs exist
  SELECT count(*) INTO v_count FROM pg_proc WHERE proname = 'authorize_message_send';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 370 VERIFICATION FAILED: authorize_message_send RPC not created';
  END IF;

  SELECT count(*) INTO v_count FROM pg_proc WHERE proname = 'settle_message_cost';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 370 VERIFICATION FAILED: settle_message_cost RPC not created';
  END IF;

  -- Verify both RPCs are SECURITY DEFINER
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'authorize_message_send' AND prosecdef = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 370 VERIFICATION FAILED: authorize_message_send not SECURITY DEFINER';
  END IF;

  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'settle_message_cost' AND prosecdef = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 370 VERIFICATION FAILED: settle_message_cost not SECURITY DEFINER';
  END IF;

  -- Verify RLS policies exist on messaging_spend_periods
  SELECT count(*) INTO v_count FROM pg_policy
    WHERE polrelid = 'messaging_spend_periods'::regclass AND polname = 'msp_owner_select';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 370 VERIFICATION FAILED: msp_owner_select policy missing';
  END IF;

  SELECT count(*) INTO v_count FROM pg_policy
    WHERE polrelid = 'messaging_spend_periods'::regclass AND polname = 'msp_admin_select';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 370 VERIFICATION FAILED: msp_admin_select policy missing';
  END IF;
END;
$$;
