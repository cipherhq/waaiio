-- ═══════════════════════════════════════════════════════
-- 372: Trial Lifecycle (#262)
--
-- Config-driven trial activation with atomic grant + clock.
-- Replaces hardcoded 30-day trial with versioned-config authority.
--
-- Surfaces:
--   ALTERED: businesses.trial_ends_at — now nullable (NULL = not activated)
--   ALTERED: save_commercial_config — extended allowlist with trial_credit_minor_by_currency
--   ALTERED: guard_commercial_settings — extended allowlist
--   NEW RPC: activate_trial_if_eligible(UUID)
--   NEW INDEX: uq_trial_pending_alert on alerts
--   LEGACY: grandfather block for active legacy trials
-- ═══════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════
-- A. Make trial_ends_at nullable
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.businesses ALTER COLUMN trial_ends_at DROP NOT NULL;
ALTER TABLE public.businesses ALTER COLUMN trial_ends_at SET DEFAULT NULL;

-- ══════════════════════════════════════════════════════════
-- B. Add trial_credit_minor_by_currency to commercial config allowlist
-- ══════════════════════════════════════════════════════════

-- Redefine save_commercial_config with extended allowlist + write-time validation
CREATE OR REPLACE FUNCTION public.save_commercial_config(
  p_key TEXT,
  p_value JSONB,
  p_description TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer',
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
    'trial_credit_minor_by_currency'
  ];
  v_caller_id UUID;
  v_snapshot JSONB;
  v_version_id UUID;
  v_now TIMESTAMPTZ;
  v_key TEXT;
  v_val JSONB;
BEGIN
  -- 1. Verify admin authorization
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'save_commercial_config requires authenticated caller';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'save_commercial_config requires admin role';
  END IF;

  -- 2. Validate key is in the commercial allowlist
  IF NOT (p_key = ANY(v_commercial_keys)) THEN
    RAISE EXCEPTION 'Key "%" is not a commercial config key', p_key;
  END IF;

  -- 2b. Write-time type validation for financial keys
  IF p_key = 'messaging_financial_gate' THEN
    IF jsonb_typeof(p_value) <> 'boolean' THEN
      RAISE EXCEPTION 'messaging_financial_gate must be a boolean, got %', jsonb_typeof(p_value);
    END IF;
  END IF;

  IF p_key = 'messaging_reservation_ttl_seconds' THEN
    IF jsonb_typeof(p_value) <> 'number' THEN
      RAISE EXCEPTION 'messaging_reservation_ttl_seconds must be a positive integer, got %', jsonb_typeof(p_value);
    END IF;
    IF (p_value::TEXT)::NUMERIC <= 0 OR (p_value::TEXT)::NUMERIC <> FLOOR((p_value::TEXT)::NUMERIC) THEN
      RAISE EXCEPTION 'messaging_reservation_ttl_seconds must be a positive integer, got %', p_value::TEXT;
    END IF;
  END IF;

  -- 2c. Write-time validation for trial_days
  IF p_key = 'trial_days' THEN
    IF jsonb_typeof(p_value) <> 'number' THEN
      RAISE EXCEPTION 'trial_days must be a positive integer, got %', jsonb_typeof(p_value);
    END IF;
    IF (p_value::TEXT)::NUMERIC <= 0 OR (p_value::TEXT)::NUMERIC <> FLOOR((p_value::TEXT)::NUMERIC) THEN
      RAISE EXCEPTION 'trial_days must be a positive integer, got %', p_value::TEXT;
    END IF;
  END IF;

  -- 2d. Write-time validation for trial_credit_minor_by_currency
  IF p_key = 'trial_credit_minor_by_currency' THEN
    IF jsonb_typeof(p_value) <> 'object' THEN
      RAISE EXCEPTION 'trial_credit_minor_by_currency must be a JSONB object, got %', jsonb_typeof(p_value);
    END IF;
    -- Validate every value is a positive integer
    FOR v_key, v_val IN SELECT * FROM jsonb_each(p_value)
    LOOP
      IF jsonb_typeof(v_val) <> 'number' THEN
        RAISE EXCEPTION 'trial_credit_minor_by_currency[%] must be a positive integer, got %', v_key, jsonb_typeof(v_val);
      END IF;
      IF (v_val::TEXT)::NUMERIC <= 0 OR (v_val::TEXT)::NUMERIC <> FLOOR((v_val::TEXT)::NUMERIC) THEN
        RAISE EXCEPTION 'trial_credit_minor_by_currency[%] must be a positive integer, got %', v_key, v_val::TEXT;
      END IF;
    END LOOP;
  END IF;

  -- 3. Serialize concurrent commercial saves
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));

  -- 4. Upsert the target platform_settings row (create-or-update)
  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES (p_key, p_value, COALESCE(p_description, ''), v_caller_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        description = COALESCE(NULLIF(p_description, ''), platform_settings.description),
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

  -- 5. Build snapshot from complete post-mutation allowlisted state
  SELECT jsonb_object_agg(key, value)
  INTO v_snapshot
  FROM platform_settings
  WHERE key = ANY(v_commercial_keys);

  IF v_snapshot IS NULL OR v_snapshot = '{}'::jsonb THEN
    RAISE EXCEPTION 'Cannot create config version: no commercial keys found in platform_settings';
  END IF;

  -- 6. Assign effective_from from DB clock inside serialized transaction
  v_now := clock_timestamp();

  -- 7. Create immutable version
  v_version_id := gen_random_uuid();
  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by, created_at)
  VALUES (v_version_id, v_snapshot, v_now, v_caller_id, v_now);

  RETURN v_version_id;
END;
$$;

-- Re-apply ACL (CREATE OR REPLACE resets grants)
REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) TO authenticated;

-- Update guard_commercial_settings with extended allowlist
CREATE OR REPLACE FUNCTION public.guard_commercial_settings()
RETURNS TRIGGER AS $$
DECLARE
  v_touches_commercial BOOLEAN;
  v_trusted_owner TEXT;
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer',
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
    'trial_credit_minor_by_currency'
  ];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_touches_commercial := NEW.key = ANY(v_commercial_keys);
  ELSIF TG_OP = 'DELETE' THEN
    v_touches_commercial := OLD.key = ANY(v_commercial_keys);
  ELSE -- UPDATE
    v_touches_commercial :=
      OLD.key = ANY(v_commercial_keys)
      OR NEW.key = ANY(v_commercial_keys);
  END IF;

  IF v_touches_commercial THEN
    SELECT r.rolname INTO v_trusted_owner
      FROM pg_proc p
      JOIN pg_roles r ON p.proowner = r.oid
     WHERE p.oid = to_regprocedure('public.save_commercial_config(text,jsonb,text)');

    IF v_trusted_owner IS NULL OR current_user != v_trusted_owner THEN
      RAISE EXCEPTION 'Commercial platform settings must be modified via save_commercial_config()';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════════════════════════════════════════
-- C. activate_trial_if_eligible(UUID) — config-driven trial activation
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.activate_trial_if_eligible(p_business_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz RECORD;
  v_decision_time TIMESTAMPTZ;
  v_config RECORD;
  v_gate_value JSONB;
  v_trial_days_raw JSONB;
  v_trial_days_numeric NUMERIC;
  v_trial_days INTEGER;
  v_trial_credit JSONB;
  v_pricing JSONB;
  v_currency TEXT;
  v_match_count INTEGER;
  v_amount_raw NUMERIC;
  v_amount INTEGER;
  v_trial_ends_at TIMESTAMPTZ;
  v_grant_result JSONB;
  v_has_channel BOOLEAN;
  v_existing_grant RECORD;
BEGIN
  -- 1. Lock business FOR UPDATE
  SELECT id, subscription_tier, trial_ends_at, country_code,
         whatsapp_channel_id, wa_method, status
  INTO v_biz
  FROM public.businesses
  WHERE id = p_business_id
  FOR UPDATE;

  IF v_biz.id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'business_not_found');
  END IF;

  -- 2. Verify: subscription_tier = 'free'
  IF v_biz.subscription_tier <> 'free' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'not_free_tier');
  END IF;

  -- 2b. [Blocker 2] Replay consistency: if clock OR grant exists, verify BOTH agree
  SELECT id, amount_minor, currency_code, expires_at
  INTO v_existing_grant
  FROM public.messaging_allowances
  WHERE business_id = p_business_id AND type = 'trial_grant' AND source_ref = 'trial_v2';

  IF v_biz.trial_ends_at IS NOT NULL AND v_existing_grant.id IS NOT NULL THEN
    -- Both exist: consistent replay — return idempotent success
    RETURN jsonb_build_object('activated', true, 'idempotent', true);
  END IF;

  IF v_biz.trial_ends_at IS NOT NULL AND v_existing_grant.id IS NULL THEN
    -- Clock set but no grant: split state — fail closed
    RETURN jsonb_build_object('activated', false, 'reason', 'split_state_clock_without_grant');
  END IF;

  IF v_biz.trial_ends_at IS NULL AND v_existing_grant.id IS NOT NULL THEN
    -- Grant exists but no clock: converge by setting clock to match grant's expires_at
    IF v_existing_grant.expires_at IS NOT NULL THEN
      UPDATE public.businesses
      SET trial_ends_at = v_existing_grant.expires_at
      WHERE id = p_business_id AND trial_ends_at IS NULL;

      RETURN jsonb_build_object('activated', true, 'idempotent', true, 'converged_clock', true);
    END IF;
    -- Grant exists but has no expires_at: unrecoverable split state
    RETURN jsonb_build_object('activated', false, 'reason', 'split_state_grant_without_clock');
  END IF;

  -- Both NULL: proceed with fresh activation

  -- 3. [Blocker 3] Verify: business has a durably usable channel
  --    Shared: business must be active (finalized onboarding)
  --    Dedicated: whatsapp_channel_id must reference an active channel
  v_has_channel := false;

  IF v_biz.wa_method IN ('transfer', 'dedicated') THEN
    -- Dedicated: must have an active assigned channel
    IF v_biz.whatsapp_channel_id IS NOT NULL THEN
      PERFORM 1 FROM public.whatsapp_channels
        WHERE id = v_biz.whatsapp_channel_id AND is_active = true;
      IF FOUND THEN
        v_has_channel := true;
      END IF;
    END IF;
  ELSIF v_biz.wa_method = 'shared' THEN
    -- Shared: business must be finalized (status = 'active')
    IF v_biz.status = 'active' THEN
      v_has_channel := true;
    END IF;
  END IF;

  IF NOT v_has_channel THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'no_usable_channel');
  END IF;

  -- 4. Resolve effective config version
  v_decision_time := clock_timestamp();
  SELECT id, config_snapshot INTO v_config
    FROM public.platform_config_versions
    WHERE effective_from <= v_decision_time
    ORDER BY effective_from DESC LIMIT 1;

  IF v_config.id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'no_config_version');
  END IF;

  -- 5. Check messaging_financial_gate is strictly boolean true
  v_gate_value := v_config.config_snapshot -> 'messaging_financial_gate';
  IF v_gate_value IS NULL OR jsonb_typeof(v_gate_value) <> 'boolean' OR v_gate_value <> 'true'::JSONB THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'financial_gate_off');
  END IF;

  -- 6. [Blocker 5] Read and defensively validate trial_days from config
  v_trial_days_raw := v_config.config_snapshot -> 'trial_days';
  IF v_trial_days_raw IS NULL OR jsonb_typeof(v_trial_days_raw) <> 'number' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'invalid_trial_days');
  END IF;

  -- Defensive cast: catch malformed numeric values
  BEGIN
    v_trial_days_numeric := (v_trial_days_raw::TEXT)::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'invalid_trial_days');
  END;

  IF v_trial_days_numeric <= 0 OR v_trial_days_numeric <> FLOOR(v_trial_days_numeric) THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'invalid_trial_days');
  END IF;
  v_trial_days := v_trial_days_numeric::INTEGER;

  -- 7. Read trial_credit_minor_by_currency from config
  v_trial_credit := v_config.config_snapshot -> 'trial_credit_minor_by_currency';
  IF v_trial_credit IS NULL OR jsonb_typeof(v_trial_credit) <> 'object' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'missing_trial_credit_config');
  END IF;

  -- 8. Resolve business country -> currency via messaging_pricing rates
  v_pricing := v_config.config_snapshot -> 'messaging_pricing';
  IF v_pricing IS NULL OR jsonb_typeof(v_pricing) <> 'object' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'currency_resolution_failed');
  END IF;

  v_match_count := 0;
  v_currency := NULL;
  FOR v_currency IN SELECT key FROM jsonb_each(v_pricing)
  LOOP
    IF v_pricing -> v_currency -> 'rates' -> v_biz.country_code IS NOT NULL THEN
      v_match_count := v_match_count + 1;
    END IF;
  END LOOP;

  IF v_match_count = 0 OR v_match_count > 1 THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'currency_resolution_failed');
  END IF;

  -- Re-resolve the single matching currency (loop variable lost after loop)
  v_currency := NULL;
  FOR v_currency IN SELECT key FROM jsonb_each(v_pricing)
  LOOP
    IF v_pricing -> v_currency -> 'rates' -> v_biz.country_code IS NOT NULL THEN
      EXIT; -- Found the one match
    END IF;
  END LOOP;

  -- 9. [Blocker 5] Look up trial credit amount with defensive cast
  BEGIN
    v_amount_raw := (v_trial_credit ->> v_currency)::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'invalid_trial_credit_amount');
  END;

  IF v_amount_raw IS NULL OR v_amount_raw <= 0 OR v_amount_raw <> FLOOR(v_amount_raw) THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'no_trial_credit_for_currency');
  END IF;
  v_amount := v_amount_raw::INTEGER;

  -- 10. Compute trial end date
  v_trial_ends_at := v_decision_time + (v_trial_days * INTERVAL '1 day');

  -- 11. Call grant_messaging_allowance
  v_grant_result := public.grant_messaging_allowance(
    p_business_id, 'trial_grant', v_amount, v_currency,
    'trial_v2', v_config.id, v_trial_ends_at
  );

  IF (v_grant_result ->> 'granted')::BOOLEAN = true THEN
    -- Grant succeeded: set trial_ends_at atomically in same transaction
    UPDATE public.businesses
    SET trial_ends_at = v_trial_ends_at
    WHERE id = p_business_id;

    RETURN jsonb_build_object('activated', true, 'trial_ends_at', v_trial_ends_at::TEXT,
      'amount_minor', v_amount, 'currency_code', v_currency);
  END IF;

  IF (v_grant_result ->> 'idempotent')::BOOLEAN = true THEN
    -- [Blocker 2] Grant exists but clock was NULL (verified above).
    -- Converge: set the clock to match the grant's expires_at.
    UPDATE public.businesses
    SET trial_ends_at = v_trial_ends_at
    WHERE id = p_business_id AND trial_ends_at IS NULL;

    RETURN jsonb_build_object('activated', true, 'idempotent', true, 'converged_clock', true);
  END IF;

  IF v_grant_result ->> 'reason' = 'idempotency_key_mismatch' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'grant_mismatch');
  END IF;

  -- Unexpected grant failure
  RETURN jsonb_build_object('activated', false, 'reason', 'grant_failed',
    'grant_result', v_grant_result);
END;
$$;

-- ACL: service-role only
REVOKE ALL ON FUNCTION public.activate_trial_if_eligible(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_trial_if_eligible(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.activate_trial_if_eligible(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.activate_trial_if_eligible(UUID) TO service_role;

-- ══════════════════════════════════════════════════════════
-- D. Legacy transition block (grandfather active legacy trials)
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE
  v_config RECORD;
  v_trial_credit JSONB;
  v_pricing JSONB;
  v_biz RECORD;
  v_currency TEXT;
  v_amount INTEGER;
  v_match_count INTEGER;
  v_granted INTEGER := 0;
  v_skipped INTEGER := 0;
  v_iter_currency TEXT;
BEGIN
  -- Get effective config
  SELECT id, config_snapshot INTO v_config
    FROM public.platform_config_versions
    WHERE effective_from <= NOW()
    ORDER BY effective_from DESC LIMIT 1;

  IF v_config.id IS NULL THEN
    RAISE NOTICE 'M372 grandfather: no config version found, skipping legacy transition';
    RETURN;
  END IF;

  v_trial_credit := v_config.config_snapshot -> 'trial_credit_minor_by_currency';
  v_pricing := v_config.config_snapshot -> 'messaging_pricing';

  IF v_trial_credit IS NULL OR jsonb_typeof(v_trial_credit) <> 'object' THEN
    RAISE NOTICE 'M372 grandfather: trial_credit_minor_by_currency not configured, skipping';
    RETURN;
  END IF;

  IF v_pricing IS NULL OR jsonb_typeof(v_pricing) <> 'object' THEN
    RAISE NOTICE 'M372 grandfather: messaging_pricing not configured, skipping';
    RETURN;
  END IF;

  FOR v_biz IN
    SELECT id, country_code, trial_ends_at
    FROM public.businesses
    WHERE subscription_tier = 'free'
      AND trial_ends_at IS NOT NULL
      AND trial_ends_at > NOW()
      AND NOT EXISTS (
        SELECT 1 FROM public.messaging_allowances
        WHERE business_id = businesses.id AND type = 'trial_grant' AND source_ref = 'trial_v2'
      )
  LOOP
    -- Resolve country -> currency
    v_match_count := 0;
    v_currency := NULL;
    FOR v_iter_currency IN SELECT key FROM jsonb_each(v_pricing)
    LOOP
      IF v_pricing -> v_iter_currency -> 'rates' -> v_biz.country_code IS NOT NULL THEN
        v_match_count := v_match_count + 1;
        v_currency := v_iter_currency;
      END IF;
    END LOOP;

    IF v_match_count <> 1 THEN
      -- [Blocker 4] Create durable pending alert for unresolved legacy trial
      INSERT INTO public.alerts (business_id, type, severity, title, message)
      VALUES (v_biz.id, 'trial_config_missing', 'warning',
        'Legacy trial v2 grant pending',
        'Currency resolution failed during M372 grandfather (match_count=' || v_match_count || '). Trial clock preserved; grant pending retry.')
      ON CONFLICT (business_id, type) WHERE type = 'trial_config_missing' DO NOTHING;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Get amount for resolved currency
    BEGIN
      v_amount := (v_trial_credit ->> v_currency)::INTEGER;
    EXCEPTION WHEN OTHERS THEN
      v_amount := NULL;
    END;
    IF v_amount IS NULL OR v_amount <= 0 THEN
      -- [Blocker 4] Create durable pending alert for unresolved legacy trial
      INSERT INTO public.alerts (business_id, type, severity, title, message)
      VALUES (v_biz.id, 'trial_config_missing', 'warning',
        'Legacy trial v2 grant pending',
        'Credit amount invalid for currency ' || COALESCE(v_currency, 'NULL') || ' during M372 grandfather. Trial clock preserved; grant pending retry.')
      ON CONFLICT (business_id, type) WHERE type = 'trial_config_missing' DO NOTHING;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Create matching trial_v2 grant with original trial_ends_at as expires_at
    INSERT INTO public.messaging_allowances (
      business_id, type, amount_minor, currency_code, remaining_minor, source_ref, config_version_id, expires_at
    ) VALUES (
      v_biz.id, 'trial_grant', v_amount, v_currency, v_amount, 'trial_v2', v_config.id, v_biz.trial_ends_at
    ) ON CONFLICT (business_id, type, source_ref) DO NOTHING;

    -- Also create the grant event
    INSERT INTO public.messaging_allowance_events (
      allowance_id, business_id, event_type, amount_minor, balance_after_minor
    ) SELECT
      ma.id, v_biz.id, 'grant', v_amount, v_amount
    FROM public.messaging_allowances ma
    WHERE ma.business_id = v_biz.id AND ma.type = 'trial_grant' AND ma.source_ref = 'trial_v2'
    ON CONFLICT DO NOTHING;

    v_granted := v_granted + 1;
  END LOOP;

  RAISE NOTICE 'M372 grandfather: granted=%, skipped=%', v_granted, v_skipped;
END;
$$;

-- ══════════════════════════════════════════════════════════
-- E. Structural alert dedupe for pending trials
-- ══════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS uq_trial_pending_alert
  ON public.alerts(business_id, type)
  WHERE type = 'trial_config_missing';

-- ══════════════════════════════════════════════════════════
-- F. Verification block
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Verify trial_ends_at is now nullable
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'businesses'
    AND column_name = 'trial_ends_at'
    AND is_nullable = 'YES';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 372 VERIFICATION FAILED: businesses.trial_ends_at is not nullable';
  END IF;

  -- Verify activate_trial_if_eligible exists and is SECURITY DEFINER
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'activate_trial_if_eligible'
      AND prosecdef = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 372 VERIFICATION FAILED: activate_trial_if_eligible not found or not SECURITY DEFINER';
  END IF;

  -- Verify save_commercial_config includes trial_credit_minor_by_currency
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'save_commercial_config'
      AND prosrc LIKE '%trial_credit_minor_by_currency%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 372 VERIFICATION FAILED: save_commercial_config does not include trial_credit_minor_by_currency';
  END IF;

  -- Verify guard_commercial_settings includes trial_credit_minor_by_currency
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'guard_commercial_settings'
      AND prosrc LIKE '%trial_credit_minor_by_currency%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 372 VERIFICATION FAILED: guard_commercial_settings does not include trial_credit_minor_by_currency';
  END IF;

  -- Verify trial_pending_alert unique index
  SELECT count(*) INTO v_count FROM pg_indexes
    WHERE indexname = 'uq_trial_pending_alert';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 372 VERIFICATION FAILED: uq_trial_pending_alert index not found';
  END IF;

  -- Verify activate_trial_if_eligible is service-role only
  -- (authenticated should NOT have EXECUTE)
  SELECT count(*) INTO v_count FROM information_schema.role_routine_grants
    WHERE routine_name = 'activate_trial_if_eligible'
      AND grantee = 'authenticated';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 372 VERIFICATION FAILED: activate_trial_if_eligible should not be callable by authenticated';
  END IF;

  RAISE NOTICE 'MIGRATION 372 VERIFICATION: All checks passed';
END;
$$;
