-- ══════════════════════════════════════════════════════════
-- 430: Shared-Number Tenant Isolation Hardening (#266)
--
-- R1–R11 accepted architecture:
-- 1. get_bot_context NULL-business ambiguity detection (R3)
-- 2. allocate_shared_channel — atomic channel allocation (R6/R7)
-- 3. transition_to_shared — atomic dedicated→shared (R11)
-- 4. reassign_shared_channel — atomic admin reassignment (R11)
-- 5. shared_number_capacity platform setting (R6)
-- 6. Backfill existing shared businesses (R9/R8)
-- 7. CHECK constraint: active shared must have assignment (R7/R8)
-- ══════════════════════════════════════════════════════════

-- ── Step 1: Platform setting ──────────────────────────────
INSERT INTO public.platform_settings (key, value)
VALUES ('shared_number_capacity', '50'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── Step 2: get_bot_context — cumulative final-state replacement ──
-- Adds ambiguity detection for NULL business_id (R3).
-- When p_business_id IS NULL and multiple active sessions exist,
-- returns {has_session:true, ambiguous:true, businesses:[...]} instead of
-- silently picking the latest.

CREATE OR REPLACE FUNCTION public.get_bot_context(
  p_phone TEXT,
  p_business_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session RECORD;
  v_session_count INTEGER;
  v_biz_id UUID;
  v_business JSONB;
  v_caps JSONB;
  v_overrides JSONB;
  v_businesses JSONB;
BEGIN
  IF p_phone IS NULL OR LENGTH(TRIM(p_phone)) = 0 THEN
    RETURN jsonb_build_object('has_session', false);
  END IF;

  IF p_business_id IS NOT NULL THEN
    -- Business-scoped: authoritative inbound path (unchanged)
    SELECT id, whatsapp_number, business_id, current_step, session_data,
           is_active, created_at, updated_at, version, user_id, expires_at
    INTO v_session
    FROM bot_sessions
    WHERE whatsapp_number = p_phone
      AND business_id = p_business_id
      AND is_active = true
      AND expires_at >= NOW()
    ORDER BY created_at DESC
    LIMIT 1;
  ELSE
    -- #266 R3: Ambiguity detection for NULL business_id.
    -- Count distinct business_id values across active sessions.
    SELECT count(DISTINCT business_id)
    INTO v_session_count
    FROM bot_sessions
    WHERE whatsapp_number = p_phone
      AND is_active = true
      AND expires_at >= NOW()
      AND business_id IS NOT NULL;

    IF v_session_count > 1 THEN
      -- Multiple businesses have active sessions — ambiguous.
      -- Return business list for disambiguation; do NOT pick one.
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'id', b.id, 'name', b.name, 'bot_code', b.bot_code
      )), '[]'::jsonb)
      INTO v_businesses
      FROM bot_sessions bs
      JOIN businesses b ON b.id = bs.business_id
      WHERE bs.whatsapp_number = p_phone
        AND bs.is_active = true
        AND bs.expires_at >= NOW()
        AND bs.business_id IS NOT NULL;

      RETURN jsonb_build_object(
        'has_session', true,
        'ambiguous', true,
        'businesses', v_businesses
      );
    END IF;

    -- 0 or 1 distinct business: pick the latest session (may have NULL business_id)
    SELECT id, whatsapp_number, business_id, current_step, session_data,
           is_active, created_at, updated_at, version, user_id, expires_at
    INTO v_session
    FROM bot_sessions
    WHERE whatsapp_number = p_phone
      AND is_active = true
      AND expires_at >= NOW()
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF v_session IS NULL THEN
    RETURN jsonb_build_object('has_session', false, 'ambiguous', false);
  END IF;

  IF v_session.business_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'id', b.id, 'name', b.name, 'slug', b.slug, 'category', b.category,
      'flow_type', b.flow_type, 'subscription_tier', b.subscription_tier,
      'trial_ends_at', b.trial_ends_at, 'metadata', b.metadata,
      'operating_hours', b.operating_hours, 'country_code', b.country_code,
      'payment_gateway', b.payment_gateway, 'status', b.status,
      'is_whitelabel', b.is_whitelabel
    )
    INTO v_business
    FROM businesses b
    WHERE b.id = v_session.business_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'capability', bc.capability,
      'is_enabled', bc.is_enabled,
      'sort_order', bc.sort_order
    ) ORDER BY bc.sort_order, bc.capability), '[]'::jsonb)
    INTO v_caps
    FROM business_capabilities bc
    WHERE bc.business_id = v_session.business_id;

    SELECT COALESCE(jsonb_agg(co.capability), '[]'::jsonb)
    INTO v_overrides
    FROM capability_overrides co
    WHERE co.business_id = v_session.business_id;
  END IF;

  RETURN jsonb_build_object(
    'has_session', true,
    'ambiguous', false,
    'session', jsonb_build_object(
      'id', v_session.id,
      'whatsapp_number', v_session.whatsapp_number,
      'business_id', v_session.business_id,
      'current_step', v_session.current_step,
      'session_data', v_session.session_data,
      'is_active', v_session.is_active,
      'created_at', v_session.created_at,
      'updated_at', v_session.updated_at,
      'version', v_session.version,
      'user_id', v_session.user_id,
      'expires_at', v_session.expires_at
    ),
    'business', v_business,
    'capabilities', COALESCE(v_caps, '[]'::jsonb),
    'capability_overrides', COALESCE(v_overrides, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_bot_context(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_bot_context(TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.get_bot_context(TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_bot_context(TEXT, UUID) TO service_role;

-- ── Step 3: allocate_shared_channel — allocation primitive ──
-- Exact-country-only for normal runtime allocation.
-- Locks candidate channel rows FOR UPDATE to serialize concurrent allocations.

CREATE OR REPLACE FUNCTION public.allocate_shared_channel(
  p_business_id UUID,
  p_country_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidate RECORD;
  v_count INTEGER;
  v_capacity INTEGER;
  v_existing UUID;
BEGIN
  -- Idempotent: if already assigned, return early
  SELECT assigned_channel_id INTO v_existing
  FROM businesses WHERE id = p_business_id;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('allocated', true, 'channel_id', v_existing, 'idempotent', true);
  END IF;

  -- Read capacity setting
  SELECT (value::text)::integer INTO v_capacity
  FROM platform_settings WHERE key = 'shared_number_capacity';
  v_capacity := COALESCE(v_capacity, 50);

  -- Lock candidate channels in deterministic order
  FOR v_candidate IN
    SELECT id FROM whatsapp_channels
    WHERE channel_type = 'shared'
      AND country_code = p_country_code
      AND is_active = true
    ORDER BY id
    FOR UPDATE
  LOOP
    -- Count businesses assigned to this channel
    SELECT count(*) INTO v_count
    FROM businesses
    WHERE assigned_channel_id = v_candidate.id;

    IF v_count < v_capacity THEN
      -- Capacity available — assign
      UPDATE businesses SET assigned_channel_id = v_candidate.id
      WHERE id = p_business_id;

      RETURN jsonb_build_object(
        'allocated', true,
        'channel_id', v_candidate.id,
        'idempotent', false
      );
    END IF;
  END LOOP;

  -- No eligible channel with capacity
  RETURN jsonb_build_object(
    'allocated', false,
    'reason', CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM whatsapp_channels
        WHERE channel_type = 'shared' AND country_code = p_country_code AND is_active = true
      ) THEN 'no_shared_channel_for_country'
      ELSE 'all_channels_at_capacity'
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_shared_channel(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allocate_shared_channel(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.allocate_shared_channel(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_shared_channel(UUID, TEXT) TO service_role;

-- ── Step 4: transition_to_shared — atomic dedicated→shared ──
-- Atomically: lock business → lock channel candidates → check capacity →
-- assign shared channel + clear dedicated pointers + deactivate old channel.
-- Failure preserves original dedicated state completely.

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

REVOKE ALL ON FUNCTION public.transition_to_shared(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_to_shared(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.transition_to_shared(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_to_shared(UUID) TO service_role;

-- ── Step 5: reassign_shared_channel — atomic admin reassignment ──

CREATE OR REPLACE FUNCTION public.reassign_shared_channel(
  p_business_id UUID,
  p_new_channel_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz RECORD;
  v_new_channel RECORD;
  v_count INTEGER;
  v_capacity INTEGER;
BEGIN
  -- Lock business
  SELECT id, assigned_channel_id, wa_method, country_code
  INTO v_biz
  FROM businesses WHERE id = p_business_id FOR UPDATE;

  IF v_biz IS NULL THEN
    RETURN jsonb_build_object('reassigned', false, 'reason', 'business_not_found');
  END IF;

  -- Lock both old and new channel rows in deterministic order to prevent deadlocks
  PERFORM id FROM whatsapp_channels
  WHERE id IN (v_biz.assigned_channel_id, p_new_channel_id)
  ORDER BY id
  FOR UPDATE;

  -- Verify new channel is shared + active
  SELECT id, country_code INTO v_new_channel
  FROM whatsapp_channels
  WHERE id = p_new_channel_id
    AND channel_type = 'shared'
    AND is_active = true;

  IF v_new_channel IS NULL THEN
    RETURN jsonb_build_object('reassigned', false, 'reason', 'invalid_target_channel');
  END IF;

  -- Check capacity on new channel
  SELECT (value::text)::integer INTO v_capacity
  FROM platform_settings WHERE key = 'shared_number_capacity';
  v_capacity := COALESCE(v_capacity, 50);

  SELECT count(*) INTO v_count
  FROM businesses WHERE assigned_channel_id = p_new_channel_id;

  IF v_count >= v_capacity THEN
    RETURN jsonb_build_object('reassigned', false, 'reason', 'target_at_capacity');
  END IF;

  -- Atomic reassignment
  UPDATE businesses SET assigned_channel_id = p_new_channel_id
  WHERE id = p_business_id;

  RETURN jsonb_build_object('reassigned', true,
    'old_channel_id', v_biz.assigned_channel_id,
    'new_channel_id', p_new_channel_id);
END;
$$;

REVOKE ALL ON FUNCTION public.reassign_shared_channel(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reassign_shared_channel(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.reassign_shared_channel(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reassign_shared_channel(UUID, UUID) TO service_role;

-- ── Step 6: Backfill existing shared businesses (capacity-aware) ──
-- Procedural: assigns each business one at a time, checking capacity per channel.
-- 1. Prefer same-country shared channel
-- 2. For migration-only: grandfather to any active shared channel if no same-country
-- 3. allocate_shared_channel() remains exact-country-only for NEW allocations
-- 4. Respects shared_number_capacity — never exceeds configured limit

DO $$
DECLARE
  v_biz RECORD;
  v_candidate RECORD;
  v_count INTEGER;
  v_capacity INTEGER;
  v_assigned BOOLEAN;
BEGIN
  SELECT (value::text)::integer INTO v_capacity
  FROM platform_settings WHERE key = 'shared_number_capacity';
  v_capacity := COALESCE(v_capacity, 50);

  FOR v_biz IN
    SELECT id, country_code FROM businesses
    WHERE wa_method = 'shared' AND assigned_channel_id IS NULL
    ORDER BY
      CASE WHEN status = 'active' THEN 0 ELSE 1 END, -- active first
      created_at
  LOOP
    v_assigned := false;

    -- Try each eligible channel in deterministic order (same-country first, then cross-country)
    FOR v_candidate IN
      SELECT wc.id FROM whatsapp_channels wc
      WHERE wc.channel_type = 'shared' AND wc.is_active = true
      ORDER BY
        CASE WHEN wc.country_code = v_biz.country_code THEN 0 ELSE 1 END,
        wc.id
    LOOP
      SELECT count(*) INTO v_count
      FROM businesses WHERE assigned_channel_id = v_candidate.id;

      IF v_count < v_capacity THEN
        UPDATE businesses SET assigned_channel_id = v_candidate.id
        WHERE id = v_biz.id;
        v_assigned := true;
        EXIT; -- assigned, move to next business
      END IF;
    END LOOP;

    IF NOT v_assigned THEN
      RAISE WARNING 'M430: business % (country %) could not be assigned — all channels at capacity', v_biz.id, v_biz.country_code;
    END IF;
  END LOOP;
END $$;

-- ── Step 7: Abort if any active shared business remains unassigned ──
DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count
  FROM businesses
  WHERE status = 'active'
    AND wa_method = 'shared'
    AND assigned_channel_id IS NULL;

  IF v_count > 0 THEN
    RAISE EXCEPTION 'M430: % active shared business(es) remain unassigned after backfill — migration cannot proceed. Provision a shared channel for the missing country or resolve manually.', v_count;
  END IF;
END $$;

-- ── Step 7b: Change column default from 'shared' to 'transfer' ──
-- A business should NOT default to shared transport without explicit allocation.
-- Production onboarding code explicitly sets wa_method='shared' and calls the allocator.
-- This prevents test fixtures and raw INSERTs from accidentally creating shared businesses.
ALTER TABLE businesses ALTER COLUMN wa_method SET DEFAULT 'transfer';

-- ── Step 8: CHECK constraint ─────────────────────────────
-- Only after all active shared businesses are reconciled.
-- 'active' is the only routable status on current main.
-- 'pending' is intentionally allowed without assignment (durable pending-allocation state).

ALTER TABLE businesses ADD CONSTRAINT chk_shared_requires_channel
  CHECK (NOT (status = 'active' AND wa_method = 'shared' AND assigned_channel_id IS NULL));

-- ── Step 9: Final verification ───────────────────────────
DO $$
BEGIN
  -- Zero active shared unassigned
  IF EXISTS (
    SELECT 1 FROM businesses
    WHERE status = 'active' AND wa_method = 'shared' AND assigned_channel_id IS NULL
  ) THEN
    RAISE EXCEPTION 'M430: active shared business without assignment after constraint';
  END IF;

  -- Constraint exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_shared_requires_channel'
  ) THEN
    RAISE EXCEPTION 'M430: CHECK constraint chk_shared_requires_channel missing';
  END IF;

  -- RPC ACLs
  IF NOT has_function_privilege('service_role', 'allocate_shared_channel(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M430: allocate_shared_channel missing service_role EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'allocate_shared_channel(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M430: anon must NOT execute allocate_shared_channel';
  END IF;
  IF has_function_privilege('authenticated', 'allocate_shared_channel(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M430: authenticated must NOT execute allocate_shared_channel';
  END IF;

  IF NOT has_function_privilege('service_role', 'transition_to_shared(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M430: transition_to_shared missing service_role EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'transition_to_shared(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M430: anon must NOT execute transition_to_shared';
  END IF;

  IF NOT has_function_privilege('service_role', 'reassign_shared_channel(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M430: reassign_shared_channel missing service_role EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'reassign_shared_channel(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M430: anon must NOT execute reassign_shared_channel';
  END IF;

  IF NOT has_function_privilege('service_role', 'get_bot_context(text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M430: get_bot_context missing service_role EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'get_bot_context(text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M430: anon must NOT execute get_bot_context';
  END IF;

  -- shared_number_capacity setting exists
  IF NOT EXISTS (
    SELECT 1 FROM platform_settings WHERE key = 'shared_number_capacity'
  ) THEN
    RAISE EXCEPTION 'M430: shared_number_capacity setting missing';
  END IF;

  RAISE NOTICE 'M430: All verifications passed — shared-number tenant isolation hardening complete';
END $$;
