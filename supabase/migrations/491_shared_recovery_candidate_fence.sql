-- Shared fallback serializes with promotion; failed allocation leaves candidates untouched.
BEGIN;
ALTER TABLE public.whatsapp_channel_candidates ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
CREATE OR REPLACE FUNCTION public.promote_channel_candidate(
  p_candidate_id UUID,
  p_business_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz                    RECORD;
  v_cand                   RECORD;
  v_old_channel_id         UUID := NULL;
  v_old_channel_type       TEXT := NULL;
  v_old_channel_business   UUID := NULL;
  v_old_channel_active     BOOLEAN := NULL;
  v_old_channel_phone      TEXT := NULL;
  v_old_channel_source     TEXT := NULL;
  v_new_channel_id         UUID;
  v_same_phone             BOOLEAN := false;
  v_action                 TEXT;
  v_phone_conflict         JSONB;
BEGIN
  -- 1. Lock business FOR UPDATE
  SELECT id, assigned_channel_id, whatsapp_channel_id, wa_method
  INTO v_biz
  FROM public.businesses
  WHERE id = p_business_id
  FOR UPDATE;

  IF v_biz.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'business_not_found');
  END IF;

  -- 2. Lock candidate FOR UPDATE
  SELECT *
  INTO v_cand
  FROM public.whatsapp_channel_candidates
  WHERE id = p_candidate_id
    AND business_id = p_business_id
  FOR UPDATE;

  IF v_cand.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'candidate_not_found');
  END IF;

  IF v_cand.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'candidate_cancelled');
  END IF;

  IF v_cand.status <> 'ready' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'candidate_not_ready',
      'status', v_cand.status);
  END IF;

  -- 3. CAS check: NULL-safe comparison
  IF v_biz.assigned_channel_id IS DISTINCT FROM v_cand.expected_assigned_channel_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cas_conflict',
      'field', 'assigned_channel_id');
  END IF;
  IF v_biz.whatsapp_channel_id IS DISTINCT FROM v_cand.expected_whatsapp_channel_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cas_conflict',
      'field', 'whatsapp_channel_id');
  END IF;
  IF v_biz.wa_method IS DISTINCT FROM v_cand.expected_wa_method THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cas_conflict',
      'field', 'wa_method');
  END IF;

  -- 4. If replacing an existing dedicated channel, lock and validate
  IF v_cand.replacing_dedicated_channel_id IS NOT NULL THEN
    SELECT id, channel_type, business_id, is_active, phone_number, connection_method
    INTO v_old_channel_id, v_old_channel_type, v_old_channel_business,
         v_old_channel_active, v_old_channel_phone, v_old_channel_source
    FROM public.whatsapp_channels
    WHERE id = v_cand.replacing_dedicated_channel_id
    FOR UPDATE;

    IF v_old_channel_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'old_channel_not_found');
    END IF;
    IF v_old_channel_type <> 'dedicated' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'old_channel_not_dedicated');
    END IF;
    IF v_old_channel_business <> p_business_id THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'old_channel_wrong_business');
    END IF;
    IF NOT v_old_channel_active THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'old_channel_not_active');
    END IF;

    -- Same-phone check
    IF v_old_channel_phone IS NOT NULL
       AND v_cand.phone_number_normalized IS NOT NULL
       AND regexp_replace(v_old_channel_phone, '[^0-9]', '', 'g') = v_cand.phone_number_normalized THEN
      v_same_phone := true;
    END IF;
  END IF;

  -- 5. Verify candidate phone is not owned by another active channel/business
  IF v_cand.phone_number_normalized IS NOT NULL AND NOT v_same_phone THEN
    v_phone_conflict := public.check_phone_conflict(
      v_cand.phone_number_normalized, p_business_id, v_cand.connection_source
    );
    IF (v_phone_conflict ->> 'conflict')::boolean THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'phone_conflict',
        'detail', v_phone_conflict ->> 'reason');
    END IF;
  END IF;

  -- 6. Perform the swap
  IF v_same_phone AND v_old_channel_id IS NOT NULL THEN
    -- K1: final DB-authoritative source check for same-phone reconnect
    IF v_old_channel_source IS DISTINCT FROM v_cand.connection_source THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'source_conflict');
    END IF;
    -- Same phone + same source reconnect: update existing live row in-place
    UPDATE public.whatsapp_channels SET
      phone_number_id    = v_cand.phone_number_id,
      waba_id            = v_cand.waba_id,
      meta_access_token  = v_cand.meta_access_token,
      meta_token_expires_at = v_cand.meta_token_expires_at,
      display_name       = COALESCE(v_cand.display_name, display_name),
      connection_method  = v_cand.connection_source,
      connection_status  = 'active',
      is_active          = true,
      updated_at         = NOW()
    WHERE id = v_old_channel_id;

    v_new_channel_id := v_old_channel_id;
    v_action := 'same_phone_update';

  ELSIF v_old_channel_id IS NOT NULL THEN
    -- Different phone: deactivate old, insert new
    UPDATE public.whatsapp_channels SET
      is_active          = false,
      connection_status  = 'disconnected',
      metadata           = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'replaced_by_candidate', v_cand.id::text,
        'replaced_at', NOW()::text
      ),
      updated_at         = NOW()
    WHERE id = v_old_channel_id;

    INSERT INTO public.whatsapp_channels (
      business_id, provider, channel_type, phone_number, phone_number_id,
      waba_id, meta_access_token, meta_token_expires_at, display_name,
      country_code, connection_method, connection_status, is_active
    ) VALUES (
      p_business_id, v_cand.provider, 'dedicated', v_cand.phone_number,
      v_cand.phone_number_id, v_cand.waba_id, v_cand.meta_access_token,
      v_cand.meta_token_expires_at, v_cand.display_name,
      v_cand.country_code, v_cand.connection_source, 'active', true
    )
    RETURNING id INTO v_new_channel_id;

    v_action := 'replace';

  ELSE
    -- First connection from shared
    INSERT INTO public.whatsapp_channels (
      business_id, provider, channel_type, phone_number, phone_number_id,
      waba_id, meta_access_token, meta_token_expires_at, display_name,
      country_code, connection_method, connection_status, is_active
    ) VALUES (
      p_business_id, v_cand.provider, 'dedicated', v_cand.phone_number,
      v_cand.phone_number_id, v_cand.waba_id, v_cand.meta_access_token,
      v_cand.meta_token_expires_at, v_cand.display_name,
      v_cand.country_code, v_cand.connection_source, 'active', true
    )
    RETURNING id INTO v_new_channel_id;

    v_action := 'first_connect';
  END IF;

  -- 7. Update business pointers
  UPDATE public.businesses SET
    assigned_channel_id  = v_new_channel_id,
    whatsapp_channel_id  = v_new_channel_id,
    wa_method            = v_cand.business_wa_method,
    updated_at           = NOW()
  WHERE id = p_business_id;

  -- 8. Persist encrypted registration PIN
  IF v_cand.encrypted_registration_pin IS NOT NULL THEN
    INSERT INTO public.whatsapp_channel_secrets (
      channel_id, encrypted_registration_pin, updated_at
    ) VALUES (
      v_new_channel_id, v_cand.encrypted_registration_pin, NOW()
    )
    ON CONFLICT (channel_id) DO UPDATE SET
      encrypted_registration_pin = EXCLUDED.encrypted_registration_pin,
      updated_at = NOW();
  END IF;

  -- 9. Delete promoted candidate
  DELETE FROM public.whatsapp_channel_candidates WHERE id = p_candidate_id;

  RETURN jsonb_build_object(
    'ok', true,
    'channel_id', v_new_channel_id,
    'action', v_action,
    'replaced_channel_id', v_old_channel_id
  );
END;
$$;
CREATE OR REPLACE FUNCTION public.transition_to_shared(
  p_business_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz RECORD;
  v_old_channel_id UUID;
  v_candidate RECORD;
  v_count INTEGER;
  v_capacity INTEGER;
BEGIN
  -- Lock and read business
  SELECT id, country_code, wa_method, assigned_channel_id, whatsapp_channel_id
  INTO v_biz
  FROM businesses WHERE id = p_business_id FOR UPDATE;

  IF v_biz IS NULL THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'business_not_found');
  END IF;

  -- Idempotent: already shared with assignment
  IF v_biz.wa_method = 'shared' AND v_biz.assigned_channel_id IS NOT NULL THEN
      UPDATE public.whatsapp_channel_candidates
      SET cancelled_at = now(), status = 'failed', failure_reason = 'user_selected_shared'
      WHERE business_id = p_business_id AND cancelled_at IS NULL
        AND status IN ('pending', 'validating', 'ready');
    RETURN jsonb_build_object('transitioned', true, 'idempotent', true,
      'channel_id', v_biz.assigned_channel_id);
  END IF;

  -- Capture BOTH possible dedicated channel pointers
  v_old_channel_id := COALESCE(v_biz.whatsapp_channel_id, v_biz.assigned_channel_id);

  -- Read capacity
  SELECT (value::text)::integer INTO v_capacity
  FROM platform_settings WHERE key = 'shared_number_capacity';
  v_capacity := COALESCE(v_capacity, 50);

  -- Lock candidate shared channels for this country
  FOR v_candidate IN
    SELECT id FROM whatsapp_channels
    WHERE channel_type = 'shared'
      AND country_code = v_biz.country_code
      AND is_active = true
    ORDER BY id
    FOR UPDATE
  LOOP
    SELECT count(*) INTO v_count
    FROM businesses WHERE assigned_channel_id = v_candidate.id;

    IF v_count < v_capacity THEN
      -- Capacity available — perform atomic transition
      UPDATE businesses
      SET wa_method = 'shared',
          assigned_channel_id = v_candidate.id,
          whatsapp_channel_id = NULL
      WHERE id = p_business_id;

      -- Deactivate old dedicated channel(s) owned by this business
      -- Uses both pointers to catch any dedicated channel reference
      UPDATE whatsapp_channels
      SET is_active = false
      WHERE business_id = p_business_id
        AND channel_type = 'dedicated'
        AND is_active = true;

      UPDATE public.whatsapp_channel_candidates
      SET cancelled_at = now(), status = 'failed', failure_reason = 'user_selected_shared'
      WHERE business_id = p_business_id AND cancelled_at IS NULL
        AND status IN ('pending', 'validating', 'ready');
      RETURN jsonb_build_object(
        'transitioned', true,
        'old_channel_id', v_old_channel_id,
        'new_channel_id', v_candidate.id
      );
    END IF;
  END LOOP;

  -- No capacity — original state completely unchanged
  RETURN jsonb_build_object('transitioned', false, 'reason', 'all_channels_at_capacity');
END;
$$;
REVOKE ALL ON FUNCTION public.promote_channel_candidate(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_channel_candidate(UUID, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.transition_to_shared(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_to_shared(UUID) TO service_role;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_channel_candidates' AND column_name='cancelled_at') THEN
    RAISE EXCEPTION 'M491 cancellation fence missing';
  END IF;
  IF position('candidate_cancelled' in pg_get_functiondef('public.promote_channel_candidate(uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'M491 promotion fence missing';
  END IF;
  IF has_function_privilege('authenticated','public.transition_to_shared(uuid)','EXECUTE') OR has_function_privilege('anon','public.promote_channel_candidate(uuid,uuid)','EXECUTE')
    OR has_function_privilege('anon','public.transition_to_shared(uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.promote_channel_candidate(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'M491 RPC permissions unexpectedly public';
  END IF;
  IF NOT has_function_privilege('service_role','public.transition_to_shared(uuid)','EXECUTE') OR NOT has_function_privilege('service_role','public.promote_channel_candidate(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'M491 service access missing';
  END IF;
END $$;
COMMIT;
