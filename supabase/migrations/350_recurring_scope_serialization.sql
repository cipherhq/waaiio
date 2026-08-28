-- Migration 350: Recurring scope serialization gate (#165 P1)
--
-- Fixes same-scope concurrency: two different source payments for the
-- same user+business+service scope could both reach provider_attempted
-- and each independently POST /subscription to Paystack.
--
-- Solution: begin_recurring_provider_attempt now takes an advisory lock
-- on the recurring scope (business_id, user_id, service_id) and checks
-- for competing provider_attempted/provider_ambiguous intents AND active
-- customer_subscriptions before authorizing provider mutation.
--
-- Also replaces create_recurring_offer with the active-subscription
-- guard added in the previous d888073d commit.
--
-- A fresh database applies 349 then 350.
-- Staging (already at 349) applies only 350.

-- ═══════════════════════════════════════════════════════
-- Replace create_recurring_offer with active-subscription guard
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION create_recurring_offer(
  p_source_payment_id UUID,
  p_business_id UUID,
  p_provider TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
  v_new_id UUID;
  v_amount INTEGER;
  v_currency VARCHAR(3);
  v_user_id UUID;
  v_service_id UUID;
BEGIN
  IF p_provider != 'paystack' THEN
    RETURN jsonb_build_object('created', false, 'reason', 'unsupported_provider');
  END IF;

  -- Load authoritative values from source payment + canonical booking
  SELECT p.amount, p.currency, p.user_id, b.service_id
  INTO v_amount, v_currency, v_user_id, v_service_id
  FROM public.payments p
  INNER JOIN public.bookings b ON b.id = p.booking_id
  WHERE p.id = p_source_payment_id
    AND p.business_id = p_business_id
    AND p.gateway = p_provider
    AND p.status = 'success'
    AND p.finalization_completed_at IS NOT NULL
    AND p.confirmation_sent_at IS NOT NULL
    AND b.flow_type = 'payment'
    AND b.business_id = p_business_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('created', false, 'reason', 'payment_not_eligible');
  END IF;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('created', false, 'reason', 'payment_missing_user');
  END IF;

  -- Check for existing active subscription in the same scope
  IF v_service_id IS NOT NULL THEN
    PERFORM id FROM public.customer_subscriptions
    WHERE business_id = p_business_id AND user_id = v_user_id
      AND service_id = v_service_id AND status = 'active';
  ELSE
    PERFORM id FROM public.customer_subscriptions
    WHERE business_id = p_business_id AND user_id = v_user_id
      AND service_id IS NULL AND status = 'active';
  END IF;

  IF FOUND THEN
    RETURN jsonb_build_object('created', false, 'reason', 'active_subscription_exists');
  END IF;

  -- Idempotent insert (UNIQUE on source_payment_id)
  INSERT INTO public.recurring_setup_intents (
    source_payment_id, business_id, user_id, service_id,
    amount, currency, provider
  ) VALUES (
    p_source_payment_id, p_business_id, v_user_id, v_service_id,
    v_amount, v_currency, p_provider
  )
  ON CONFLICT (source_payment_id) DO NOTHING
  RETURNING id INTO v_new_id;

  IF v_new_id IS NOT NULL THEN
    RETURN jsonb_build_object('created', true, 'intent_id', v_new_id);
  END IF;

  SELECT id, status, expires_at INTO v_intent
  FROM public.recurring_setup_intents
  WHERE source_payment_id = p_source_payment_id;

  RETURN jsonb_build_object(
    'created', false,
    'reason', 'already_exists',
    'intent_id', v_intent.id,
    'status', v_intent.status,
    'expired', v_intent.expires_at < NOW()
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Replace begin_recurring_provider_attempt with scope serialization gate
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION begin_recurring_provider_attempt(
  p_intent_id UUID,
  p_business_id UUID,
  p_customer_code TEXT,
  p_authorization_code TEXT,
  p_start_date TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
  v_token UUID;
  v_scope_lock BIGINT;
  v_competing RECORD;
BEGIN
  -- Load the intent with FOR UPDATE
  SELECT id, status, business_id, user_id, service_id,
         consent_at, consent_message_hash, expires_at
  INTO v_intent
  FROM public.recurring_setup_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'intent_not_found');
  END IF;
  IF v_intent.business_id != p_business_id THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'tenant_mismatch');
  END IF;
  IF v_intent.expires_at < NOW() THEN
    UPDATE public.recurring_setup_intents SET status = 'expired', updated_at = NOW()
    WHERE id = p_intent_id AND status IN ('offered', 'frequency_selected', 'consent_confirmed');
    RETURN jsonb_build_object('transitioned', false, 'reason', 'expired');
  END IF;
  IF v_intent.status != 'consent_confirmed' THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'invalid_state_' || v_intent.status);
  END IF;
  IF v_intent.consent_at IS NULL OR v_intent.consent_message_hash IS NULL THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'consent_incomplete');
  END IF;

  -- ═══ SCOPE SERIALIZATION GATE ═══
  -- Take an advisory lock on the recurring scope: (business_id, user_id, service_id)
  -- This serializes competing provider-attempt claims for the SAME scope.
  -- NULL service_id is treated as Generic Payment scope (hash 0).
  v_scope_lock := hashtext(
    v_intent.business_id::text || ':' ||
    v_intent.user_id::text || ':' ||
    COALESCE(v_intent.service_id::text, '__NULL__')
  );
  PERFORM pg_advisory_xact_lock(v_scope_lock);

  -- Under the lock, check for existing active subscription in the same scope
  IF v_intent.service_id IS NOT NULL THEN
    PERFORM id FROM public.customer_subscriptions
    WHERE business_id = v_intent.business_id AND user_id = v_intent.user_id
      AND service_id = v_intent.service_id AND status = 'active';
  ELSE
    PERFORM id FROM public.customer_subscriptions
    WHERE business_id = v_intent.business_id AND user_id = v_intent.user_id
      AND service_id IS NULL AND status = 'active';
  END IF;

  IF FOUND THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'active_subscription_exists');
  END IF;

  -- Under the lock, check for competing provider-attempted/ambiguous intents
  -- in the SAME scope (different intent, same user+business+service)
  IF v_intent.service_id IS NOT NULL THEN
    SELECT id, status INTO v_competing
    FROM public.recurring_setup_intents
    WHERE business_id = v_intent.business_id
      AND user_id = v_intent.user_id
      AND service_id = v_intent.service_id
      AND id != v_intent.id
      AND status IN ('provider_attempted', 'provider_ambiguous')
    LIMIT 1;
  ELSE
    SELECT id, status INTO v_competing
    FROM public.recurring_setup_intents
    WHERE business_id = v_intent.business_id
      AND user_id = v_intent.user_id
      AND service_id IS NULL
      AND id != v_intent.id
      AND status IN ('provider_attempted', 'provider_ambiguous')
    LIMIT 1;
  END IF;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'transitioned', false,
      'reason', 'competing_provider_attempt',
      'competing_intent_id', v_competing.id,
      'competing_status', v_competing.status
    );
  END IF;

  -- ═══ END SCOPE GATE — safe to proceed ═══

  v_token := gen_random_uuid();

  UPDATE public.recurring_setup_intents
  SET status = 'provider_attempted',
      provider_customer_code = p_customer_code,
      provider_authorization_code = p_authorization_code,
      provider_start_date = p_start_date,
      claim_token = v_token,
      claim_expires_at = NOW() + INTERVAL '5 minutes',
      updated_at = NOW()
  WHERE id = p_intent_id AND status = 'consent_confirmed';

  RETURN jsonb_build_object('transitioned', true, 'claim_token', v_token);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Privilege restrictions for any new/replaced functions
-- ═══════════════════════════════════════════════════════

DO $$ BEGIN
  REVOKE ALL ON FUNCTION create_recurring_offer(UUID, UUID, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION begin_recurring_provider_attempt(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
  EXECUTE 'REVOKE ALL ON FUNCTION create_recurring_offer(UUID, UUID, TEXT) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION begin_recurring_provider_attempt(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION create_recurring_offer(UUID, UUID, TEXT) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION begin_recurring_provider_attempt(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION create_recurring_offer(UUID, UUID, TEXT) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION begin_recurring_provider_attempt(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
