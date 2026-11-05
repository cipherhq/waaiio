-- ══════════════════════════════════════════════════════════
-- 507: First shared-number assignment without M430
--
-- Production never receives M430 (it reassigns existing businesses and adds a
-- CHECK constraint). This migration adds only:
--   1. get_bot_context ambiguity detection (#266 R3). Body is identical to the
--      staging final state: when no business is resolved and the phone has
--      active sessions with more than one business, return ambiguous=true and
--      the business list instead of silently picking the newest session.
--      The business-scoped path is unchanged.
--   2. assign_first_shared_channel(p_business_id): gives a business that has NO
--      WhatsApp channel at all an active shared number in its own country
--      (approved GH -> NG fallback only). It never moves or replaces an
--      existing assignment, never touches a business with a dedicated/history
--      channel, has no capacity limit (Owner decision 2026-11-03), and changes
--      no other business, setting or constraint. No backfill.
-- ══════════════════════════════════════════════════════════

-- ── 1. get_bot_context (staging final state, #266 R3) ─────────────────────
CREATE OR REPLACE FUNCTION public.get_bot_context(p_phone text, p_business_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session RECORD; v_session_count INTEGER; v_biz_id UUID;
  v_business JSONB; v_caps JSONB; v_overrides JSONB; v_businesses JSONB;
BEGIN
  IF p_phone IS NULL OR LENGTH(TRIM(p_phone)) = 0 THEN
    RETURN jsonb_build_object('has_session', false);
  END IF;
  IF p_business_id IS NOT NULL THEN
    SELECT id, whatsapp_number, business_id, current_step, session_data,
           is_active, created_at, updated_at, version, user_id, expires_at
    INTO v_session FROM bot_sessions
    WHERE whatsapp_number = p_phone AND business_id = p_business_id
      AND is_active = true AND expires_at >= NOW()
    ORDER BY created_at DESC LIMIT 1;
  ELSE
    SELECT count(DISTINCT business_id) INTO v_session_count
    FROM bot_sessions WHERE whatsapp_number = p_phone
      AND is_active = true AND expires_at >= NOW() AND business_id IS NOT NULL;
    IF v_session_count > 1 THEN
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'id', b.id, 'name', b.name, 'bot_code', b.bot_code
      )), '[]'::jsonb) INTO v_businesses
      FROM bot_sessions bs JOIN businesses b ON b.id = bs.business_id
      WHERE bs.whatsapp_number = p_phone AND bs.is_active = true
        AND bs.expires_at >= NOW() AND bs.business_id IS NOT NULL;
      RETURN jsonb_build_object('has_session', true, 'ambiguous', true, 'businesses', v_businesses);
    END IF;
    SELECT id, whatsapp_number, business_id, current_step, session_data,
           is_active, created_at, updated_at, version, user_id, expires_at
    INTO v_session FROM bot_sessions
    WHERE whatsapp_number = p_phone AND is_active = true AND expires_at >= NOW()
    ORDER BY created_at DESC LIMIT 1;
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
    ) INTO v_business FROM businesses b WHERE b.id = v_session.business_id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'capability', bc.capability, 'is_enabled', bc.is_enabled, 'sort_order', bc.sort_order
    ) ORDER BY bc.sort_order, bc.capability), '[]'::jsonb) INTO v_caps
    FROM business_capabilities bc WHERE bc.business_id = v_session.business_id;
    SELECT COALESCE(jsonb_agg(co.capability), '[]'::jsonb) INTO v_overrides
    FROM capability_overrides co WHERE co.business_id = v_session.business_id;
  END IF;
  RETURN jsonb_build_object(
    'has_session', true, 'ambiguous', false,
    'session', jsonb_build_object(
      'id', v_session.id, 'whatsapp_number', v_session.whatsapp_number,
      'business_id', v_session.business_id, 'current_step', v_session.current_step,
      'session_data', v_session.session_data, 'is_active', v_session.is_active,
      'created_at', v_session.created_at, 'updated_at', v_session.updated_at,
      'version', v_session.version, 'user_id', v_session.user_id,
      'expires_at', v_session.expires_at
    ),
    'business', v_business,
    'capabilities', COALESCE(v_caps, '[]'::jsonb),
    'capability_overrides', COALESCE(v_overrides, '[]'::jsonb)
  );
END; $function$;

REVOKE ALL ON FUNCTION public.get_bot_context(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_bot_context(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_bot_context(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_bot_context(text, uuid) TO service_role;

-- ── 2. assign_first_shared_channel ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assign_first_shared_channel(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_biz RECORD;
  v_countries text[];
  v_channel RECORD;
  v_updated integer;
BEGIN
  IF p_business_id IS NULL THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'missing_business');
  END IF;

  -- Serialize all first-assignment attempts for this business.
  SELECT id, country_code, wa_method, assigned_channel_id, whatsapp_channel_id
    INTO v_biz
    FROM businesses
   WHERE id = p_business_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'business_not_found');
  END IF;

  -- Already assigned: report it, never replace it.
  IF v_biz.assigned_channel_id IS NOT NULL THEN
    RETURN jsonb_build_object('allocated', true, 'idempotent', true, 'channel_id', v_biz.assigned_channel_id);
  END IF;

  -- Any other channel authority means this is not a first assignment.
  IF v_biz.whatsapp_channel_id IS NOT NULL THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'has_channel');
  END IF;
  IF v_biz.wa_method IS NOT NULL AND v_biz.wa_method <> 'shared' THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'not_shared_method');
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_channels WHERE business_id = p_business_id) THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'has_dedicated_channel');
  END IF;

  -- Country comes from the business row, never from the caller.
  IF v_biz.country_code IS NULL OR length(trim(v_biz.country_code)) = 0 THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'missing_business_country');
  END IF;
  v_countries := CASE WHEN v_biz.country_code = 'GH'
                      THEN ARRAY['GH', 'NG']
                      ELSE ARRAY[v_biz.country_code::text] END;

  -- Eligible platform shared number; lock it so it cannot be deactivated mid-assignment.
  SELECT w.id, w.country_code
    INTO v_channel
    FROM whatsapp_channels w
   WHERE w.channel_type = 'shared'
     AND w.is_active = true
     AND w.connection_status = 'active'
     AND w.business_id IS NULL
     AND w.country_code::text = ANY (v_countries)
   ORDER BY array_position(v_countries, w.country_code::text), w.id
   LIMIT 1
   FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'no_shared_channel_for_country');
  END IF;

  UPDATE businesses
     SET assigned_channel_id = v_channel.id
   WHERE id = p_business_id
     AND assigned_channel_id IS NULL
     AND whatsapp_channel_id IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'concurrent_change');
  END IF;

  RETURN jsonb_build_object(
    'allocated', true,
    'idempotent', false,
    'channel_id', v_channel.id,
    'channel_country', v_channel.country_code,
    'fallback_used', v_channel.country_code::text <> v_biz.country_code::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assign_first_shared_channel(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_first_shared_channel(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assign_first_shared_channel(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assign_first_shared_channel(uuid) TO service_role;
