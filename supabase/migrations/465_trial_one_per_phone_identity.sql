-- Migration 465: Trial one-per-verified-phone-identity
--
-- Owner-approved policy: one introductory promotional messaging-credit grant
-- per verified phone identity, across all businesses owned by that identity.
--
-- CHANGE: Adds step 2c to activate_trial_if_eligible — cross-business owner
-- dedup check with advisory lock serialization. The function signature is
-- unchanged (UUID → JSONB). All existing checks preserved.
--
-- ENFORCEMENT CHAIN:
--   auth.users.phone → UNIQUE (one phone per user)
--   businesses.owner_id → auth.users.id (one user per phone)
--   Step 2c: EXISTS check on messaging_allowances for same owner_id
--   pg_advisory_xact_lock: serializes concurrent attempts for same owner
--
-- PRESERVES:
--   - Per-business idempotency (step 2b replay checks)
--   - Historical grants (check is b2.id <> p_business_id)
--   - Paid credits (check scoped to type='trial_grant', source_ref='trial_v2')
--   - Subscription-included and purchased allowances (untouched)
--
-- SECURITY: SECURITY DEFINER, service_role only, search_path = ''.
-- ROLLBACK: CREATE OR REPLACE with the M372 body (no step 2c).

CREATE OR REPLACE FUNCTION public.activate_trial_if_eligible(p_business_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz RECORD;
  v_owner_id UUID;
  v_phone_confirmed_at TIMESTAMPTZ;
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
  v_replay_config RECORD;
  v_replay_credit JSONB;
  v_replay_pricing JSONB;
  v_replay_currency TEXT;
  v_replay_match INTEGER;
  v_replay_amount_raw NUMERIC;
  v_replay_amount INTEGER;
BEGIN
  -- 1. Lock business FOR UPDATE
  SELECT id, owner_id, subscription_tier, trial_ends_at, country_code,
         whatsapp_channel_id, wa_method, status
  INTO v_biz
  FROM public.businesses
  WHERE id = p_business_id
  FOR UPDATE;

  IF v_biz.id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'business_not_found');
  END IF;

  v_owner_id := v_biz.owner_id;

  -- 1b. [M465] Verify owner has a confirmed phone identity.
  -- Supabase Auth sets phone_confirmed_at when phone OTP is verified
  -- (see app/api/auth/otp/verify/route.ts: phone_confirm: true).
  -- Users authenticated only via email or Facebook do not have this set.
  SELECT phone_confirmed_at INTO v_phone_confirmed_at
  FROM auth.users WHERE id = v_owner_id;

  IF v_phone_confirmed_at IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'phone_not_verified');
  END IF;

  -- 2. Verify: subscription_tier = 'free'
  IF v_biz.subscription_tier <> 'free' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'not_free_tier');
  END IF;

  -- 2b. [Blocker 2] Replay consistency: if clock OR grant exists, verify BOTH agree
  SELECT id, amount_minor, currency_code, expires_at, config_version_id
  INTO v_existing_grant
  FROM public.messaging_allowances
  WHERE business_id = p_business_id AND type = 'trial_grant' AND source_ref = 'trial_v2';

  IF v_biz.trial_ends_at IS NOT NULL AND v_existing_grant.id IS NOT NULL THEN
    -- Both exist: validate canonical consistency before replay success.

    -- 2b-i. Clock must match grant's expires_at
    IF v_existing_grant.expires_at IS NULL
       OR v_biz.trial_ends_at <> v_existing_grant.expires_at THEN
      RETURN jsonb_build_object('activated', false, 'reason', 'replay_state_mismatch',
        'detail', 'clock_expiry_mismatch');
    END IF;

    -- 2b-ii. Grant must reference a valid config version
    IF v_existing_grant.config_version_id IS NULL THEN
      RETURN jsonb_build_object('activated', false, 'reason', 'replay_state_mismatch',
        'detail', 'missing_config_provenance');
    END IF;

    SELECT id, config_snapshot INTO v_replay_config
      FROM public.platform_config_versions
      WHERE id = v_existing_grant.config_version_id;

    IF v_replay_config.id IS NULL THEN
      RETURN jsonb_build_object('activated', false, 'reason', 'replay_state_mismatch',
        'detail', 'invalid_config_provenance');
    END IF;

    -- 2b-iii. Resolve canonical amount/currency from the grant's config version
    v_replay_credit := v_replay_config.config_snapshot -> 'trial_credit_minor_by_currency';
    v_replay_pricing := v_replay_config.config_snapshot -> 'messaging_pricing';

    IF v_replay_credit IS NULL OR v_replay_pricing IS NULL THEN
      RETURN jsonb_build_object('activated', false, 'reason', 'replay_state_mismatch',
        'detail', 'config_missing_credit_or_pricing');
    END IF;

    -- Resolve country → currency from the grant's config version
    v_replay_match := 0;
    v_replay_currency := NULL;
    FOR v_replay_currency IN SELECT key FROM jsonb_each(v_replay_pricing)
    LOOP
      IF v_replay_pricing -> v_replay_currency -> 'rates' -> v_biz.country_code IS NOT NULL THEN
        v_replay_match := v_replay_match + 1;
      END IF;
    END LOOP;

    IF v_replay_match <> 1 THEN
      RETURN jsonb_build_object('activated', false, 'reason', 'replay_state_mismatch',
        'detail', 'config_currency_resolution_failed');
    END IF;

    v_replay_currency := NULL;
    FOR v_replay_currency IN SELECT key FROM jsonb_each(v_replay_pricing)
    LOOP
      IF v_replay_pricing -> v_replay_currency -> 'rates' -> v_biz.country_code IS NOT NULL THEN
        EXIT;
      END IF;
    END LOOP;

    -- Resolve canonical amount from the grant's config version
    BEGIN
      v_replay_amount_raw := (v_replay_credit ->> v_replay_currency)::NUMERIC;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('activated', false, 'reason', 'replay_state_mismatch',
        'detail', 'config_amount_parse_failed');
    END;
    IF v_replay_amount_raw IS NULL OR v_replay_amount_raw <= 0 THEN
      RETURN jsonb_build_object('activated', false, 'reason', 'replay_state_mismatch',
        'detail', 'config_amount_invalid');
    END IF;
    v_replay_amount := v_replay_amount_raw::INTEGER;

    -- 2b-iv. Compare grant's persisted amount/currency against canonical values
    IF v_existing_grant.amount_minor <> v_replay_amount THEN
      RETURN jsonb_build_object('activated', false, 'reason', 'replay_state_mismatch',
        'detail', 'amount_mismatch',
        'grant_amount', v_existing_grant.amount_minor,
        'canonical_amount', v_replay_amount);
    END IF;

    IF v_existing_grant.currency_code <> v_replay_currency THEN
      RETURN jsonb_build_object('activated', false, 'reason', 'replay_state_mismatch',
        'detail', 'currency_mismatch',
        'grant_currency', v_existing_grant.currency_code,
        'canonical_currency', v_replay_currency);
    END IF;

    -- All canonical checks passed: consistent replay
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

  -- ══════════════════════════════════════════════════════════
  -- 2c. [M465] One-promotional-grant-per-verified-phone-identity.
  --
  -- Serialize by owner_id to prevent concurrent activations for
  -- two businesses by the same user from both succeeding.
  -- Then check if ANY other business by this owner already has
  -- a trial_v2 grant. Phone uniqueness is enforced by auth.users
  -- (UNIQUE INDEX users_phone_key); owner_id FK → auth.users.id.
  -- ══════════════════════════════════════════════════════════
  PERFORM pg_advisory_xact_lock(hashtext('trial_owner_' || v_owner_id::text));

  IF EXISTS (
    SELECT 1 FROM public.messaging_allowances ma
    JOIN public.businesses b2 ON b2.id = ma.business_id
    WHERE b2.owner_id = v_owner_id
      AND ma.type = 'trial_grant'
      AND ma.source_ref = 'trial_v2'
      AND b2.id <> p_business_id
  ) THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'owner_already_has_trial');
  END IF;

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

-- ACL unchanged: service-role only
REVOKE ALL ON FUNCTION public.activate_trial_if_eligible(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_trial_if_eligible(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.activate_trial_if_eligible(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.activate_trial_if_eligible(UUID) TO service_role;

-- ══════════════════════════════════════════════════════════
-- mark_trial_ineligible: atomic JSONB key update for cron
-- ══════════════════════════════════════════════════════════
-- Sets metadata.trial_ineligible and metadata.trial_ineligible_reason
-- without replacing the entire JSONB object. Preserves all other keys.
-- Used by the trial-activation cron to exclude permanently denied
-- businesses from future batches.

CREATE OR REPLACE FUNCTION public.mark_trial_ineligible(
  p_business_id UUID,
  p_reason TEXT DEFAULT 'owner_already_has_trial'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Restrict to the only genuinely permanent denial reason.
  -- Prevents stale or incorrect callers from permanently suppressing
  -- a business entitled to its first trial grant.
  IF p_reason <> 'owner_already_has_trial' THEN
    RAISE EXCEPTION 'mark_trial_ineligible: only owner_already_has_trial is a valid permanent reason, got %', p_reason;
  END IF;

  -- Verify the business actually has an owner who already received a trial
  -- elsewhere. This is a DB-authoritative precondition, not just trusting
  -- the caller's assertion.
  IF NOT EXISTS (
    SELECT 1 FROM public.messaging_allowances ma
    JOIN public.businesses b2 ON b2.id = ma.business_id
    JOIN public.businesses b_target ON b_target.id = p_business_id
    WHERE b2.owner_id = b_target.owner_id
      AND ma.type = 'trial_grant'
      AND ma.source_ref = 'trial_v2'
      AND b2.id <> p_business_id
  ) THEN
    -- Owner does NOT actually have a trial elsewhere — do not mark.
    -- This prevents incorrect permanent exclusion.
    RETURN;
  END IF;

  -- Atomic JSONB key update — uses JSON boolean true (not string "true")
  UPDATE public.businesses
  SET metadata = jsonb_set(
    jsonb_set(COALESCE(metadata, '{}'), '{trial_ineligible}', 'true'),
    '{trial_ineligible_reason}', to_jsonb(p_reason)
  )
  WHERE id = p_business_id;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_trial_ineligible(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_trial_ineligible(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.mark_trial_ineligible(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_trial_ineligible(UUID, TEXT) TO service_role;

-- ── Verification ──
DO $$
BEGIN
  -- Function exists and is SECURITY DEFINER
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'activate_trial_if_eligible'
      AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'M465: activate_trial_if_eligible not found or not SECURITY DEFINER';
  END IF;

  -- Function body contains the phone verification check
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'activate_trial_if_eligible'
      AND prosrc LIKE '%phone_not_verified%'
  ) THEN
    RAISE EXCEPTION 'M465: phone verification check not found in function body';
  END IF;

  -- Function body contains the owner dedup check
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'activate_trial_if_eligible'
      AND prosrc LIKE '%owner_already_has_trial%'
  ) THEN
    RAISE EXCEPTION 'M465: owner dedup check not found in function body';
  END IF;

  -- Function body contains advisory lock
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'activate_trial_if_eligible'
      AND prosrc LIKE '%trial_owner_%'
  ) THEN
    RAISE EXCEPTION 'M465: advisory lock not found in function body';
  END IF;

  -- ACL: service_role only
  IF has_function_privilege('anon', 'public.activate_trial_if_eligible(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M465: anon must NOT execute activate_trial_if_eligible';
  END IF;
  IF has_function_privilege('authenticated', 'public.activate_trial_if_eligible(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M465: authenticated must NOT execute activate_trial_if_eligible';
  END IF;

  -- mark_trial_ineligible helper exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'mark_trial_ineligible'
      AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'M465: mark_trial_ineligible not found or not SECURITY DEFINER';
  END IF;

  RAISE NOTICE 'M465: Trial one-per-phone-identity enforcement verified';
END $$;
