-- ══════════════════════════════════════════════════════════
-- M379: CAS enforcement at checkout claim boundary
--
-- Closes the TOCTOU gap between config read and claim:
-- 1. Serializes against commercial-config write authority
-- 2. Verifies p_config_version_id is still the latest effective version
-- 3. Fails closed with config_version_conflict when stale
-- 4. Preserves pinned-contract semantics after a valid claim commits
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.claim_checkout_initialization(
  p_business_id UUID, p_plan TEXT, p_gateway TEXT,
  p_currency TEXT, p_amount INTEGER, p_provider_plan_ref TEXT,
  p_config_version_id UUID, p_subscriber_email TEXT,
  p_session_duration INTEGER DEFAULT 30,
  p_actor_id UUID DEFAULT NULL
)
RETURNS TABLE(
  intent_id UUID, is_claimed BOOLEAN, provider_checkout_url TEXT,
  idempotency_key TEXT, needs_provider_verification BOOLEAN, intent_status TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_id UUID;
  v_existing RECORD; v_new_id UUID; v_new_key TEXT;
  v_latest_version_id UUID;
BEGIN
  v_actor_id := COALESCE(p_actor_id, auth.uid());
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'requires actor identity'; END IF;

  -- ═══ CAS enforcement: serialize against commercial-config write authority ═══
  -- Same advisory lock discipline used by save_commercial_config / save_messaging_config
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));

  -- Verify config version is still the latest effective version under the lock
  SELECT id INTO v_latest_version_id
    FROM platform_config_versions
    WHERE effective_from <= clock_timestamp()
    ORDER BY effective_from DESC LIMIT 1;

  IF v_latest_version_id IS DISTINCT FROM p_config_version_id THEN
    RAISE EXCEPTION 'config_version_conflict: expected % but latest is %',
      p_config_version_id, v_latest_version_id;
  END IF;
  -- ═══ End CAS enforcement — config version proven current ═══

  SELECT * INTO v_existing FROM subscription_checkout_intents sci
    WHERE sci.business_id = p_business_id AND sci.plan = p_plan
      AND sci.gateway = p_gateway AND sci.status = 'pending'
    FOR UPDATE;

  IF FOUND THEN
    IF v_existing.provider_checkout_url IS NOT NULL THEN
      IF v_existing.provider_timeout_not_before IS NOT NULL
         AND v_existing.provider_timeout_not_before <= clock_timestamp() THEN
        RETURN QUERY SELECT v_existing.id, false, v_existing.provider_checkout_url,
          v_existing.idempotency_key, true, 'pending'::TEXT;
        RETURN;
      END IF;
      RETURN QUERY SELECT v_existing.id, false, v_existing.provider_checkout_url,
        v_existing.idempotency_key, false, 'pending'::TEXT;
      RETURN;
    END IF;
    IF v_existing.claimed_at IS NOT NULL
       AND v_existing.claimed_at > clock_timestamp() - interval '90 seconds' THEN
      RETURN QUERY SELECT v_existing.id, false, NULL::TEXT,
        v_existing.idempotency_key, false, 'pending'::TEXT;
      RETURN;
    END IF;
    UPDATE subscription_checkout_intents SET claimed_at = clock_timestamp() WHERE id = v_existing.id;
    RETURN QUERY SELECT v_existing.id, true, NULL::TEXT,
      v_existing.idempotency_key, false, 'pending'::TEXT;
    RETURN;
  END IF;

  v_new_id := gen_random_uuid();
  v_new_key := 'waaiiosub' || replace(v_new_id::text, '-', '');
  INSERT INTO subscription_checkout_intents (
    id, business_id, user_id, plan, gateway, country_code, currency, amount,
    provider_plan_ref, config_version_id, subscriber_email,
    idempotency_key, provider_session_duration_minutes, status, claimed_at, provider_tx_ref
  ) VALUES (
    v_new_id, p_business_id, v_actor_id, p_plan, p_gateway,
    (SELECT country_code FROM businesses WHERE id = p_business_id),
    p_currency, p_amount, p_provider_plan_ref, p_config_version_id,
    p_subscriber_email, v_new_key, p_session_duration, 'pending', clock_timestamp(), v_new_key
  );
  RETURN QUERY SELECT v_new_id, true, NULL::TEXT, v_new_key, false, 'pending'::TEXT;
END;
$$;

-- ACL unchanged
REVOKE ALL ON FUNCTION public.claim_checkout_initialization(uuid,text,text,text,integer,text,uuid,text,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_checkout_initialization(uuid,text,text,text,integer,text,uuid,text,integer,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_checkout_initialization(uuid,text,text,text,integer,text,uuid,text,integer,uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.claim_checkout_initialization(uuid,text,text,text,integer,text,uuid,text,integer,uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.claim_checkout_initialization(uuid,text,text,text,integer,text,uuid,text,integer,uuid) TO service_role;

-- ══════════════════════════════════════════════════════════
-- Self-test: verify CAS enforcement exists
-- ══════════════════════════════════════════════════════════
DO $$
DECLARE v_src TEXT;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
    WHERE proname = 'claim_checkout_initialization' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'M379: claim_checkout_initialization not found';
  END IF;
  IF v_src NOT LIKE '%config_version_conflict%' THEN
    RAISE EXCEPTION 'M379: claim_checkout_initialization missing CAS enforcement';
  END IF;
  IF v_src NOT LIKE '%commercial_config_write%' THEN
    RAISE EXCEPTION 'M379: claim_checkout_initialization missing advisory lock serialization';
  END IF;
END;
$$;
