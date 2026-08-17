-- ══════════════════════════════════════════════════════════
-- 323: get_bot_context — single round-trip bot request bootstrap
-- ══════════════════════════════════════════════════════════
-- Collapses session + business + capabilities + overrides into ONE query.
-- Used by BotService.handleMessage for deterministic active-session flow.
-- Does NOT cache/return transactional authority (capacity, availability, payment).
--
-- TENANT SCOPING:
--   p_business_id IS NOT NULL → session MUST match phone + business_id (inbound webhook path)
--   p_business_id IS NULL     → legacy latest-session behavior for marketplace / business-selection entry

-- Drop old single-arg signature if it exists (CREATE OR REPLACE won't replace different arg lists)
DROP FUNCTION IF EXISTS public.get_bot_context(TEXT);

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
  v_biz_id UUID;
  v_business JSONB;
  v_caps JSONB;
  v_overrides JSONB;
BEGIN
  -- Input validation: reject null/empty phone
  IF p_phone IS NULL OR LENGTH(TRIM(p_phone)) = 0 THEN
    RETURN jsonb_build_object('has_session', false);
  END IF;

  -- 1. Fetch active, non-expired session for this phone
  --    When p_business_id is supplied (inbound webhook): require exact business match.
  --    When p_business_id is NULL (marketplace/business-selection): pick latest session.
  IF p_business_id IS NOT NULL THEN
    -- Business-scoped: authoritative inbound path
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
    -- Legacy / marketplace fallback: no resolved business yet.
    -- Returns the most recent active session regardless of business.
    -- Used only for flows where Waaiio has no channel-resolved business context,
    -- such as marketplace entry or business-selection.
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
    RETURN jsonb_build_object('has_session', false);
  END IF;

  -- 2. If session has a business, fetch business + capabilities
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

    -- Capabilities
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'capability', bc.capability,
      'is_enabled', bc.is_enabled,
      'sort_order', bc.sort_order
    ) ORDER BY bc.sort_order, bc.capability), '[]'::jsonb)
    INTO v_caps
    FROM business_capabilities bc
    WHERE bc.business_id = v_session.business_id;

    -- Overrides
    SELECT COALESCE(jsonb_agg(co.capability), '[]'::jsonb)
    INTO v_overrides
    FROM capability_overrides co
    WHERE co.business_id = v_session.business_id;
  END IF;

  RETURN jsonb_build_object(
    'has_session', true,
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

-- Grant execute to service role only (bot runs through service client)
-- NOTE: Supabase default privileges auto-grant EXECUTE to anon/authenticated/service_role
-- on functions created in public schema. We must explicitly revoke from all three.
REVOKE ALL ON FUNCTION public.get_bot_context(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_bot_context(TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.get_bot_context(TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_bot_context(TEXT, UUID) TO service_role;
