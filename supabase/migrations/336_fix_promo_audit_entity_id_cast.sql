-- Fix #186: Remove ::text cast on entity_id in promo lifecycle RPCs.
-- Production admin_audit_logs.entity_id is UUID (migration 010).
-- Both functions were passing p_campaign_id::text which PostgreSQL rejects
-- at runtime (text → uuid implicit coercion not allowed).
-- Change: p_campaign_id::text → p_campaign_id (2 lines total).

CREATE OR REPLACE FUNCTION activate_promo_campaign(
  p_campaign_id UUID, p_actor_id UUID DEFAULT NULL, p_actor_role TEXT DEFAULT 'business'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_validation JSONB; v_campaign RECORD; v_from_status TEXT;
BEGIN
  SELECT * INTO v_campaign FROM promo_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign not found'); END IF;
  v_from_status := v_campaign.status;
  v_validation := validate_promo_campaign_activation(p_campaign_id);
  IF NOT (v_validation->>'valid')::boolean THEN
    RETURN jsonb_build_object('success', false, 'error', 'Activation validation failed', 'validation_errors', v_validation->'errors');
  END IF;
  UPDATE promo_campaigns SET status = 'active' WHERE id = p_campaign_id;
  IF p_actor_id IS NOT NULL THEN
    INSERT INTO admin_audit_logs (actor_id, action, entity_type, entity_id, details)
    VALUES (p_actor_id, 'promotions.activate', 'promo_campaign', p_campaign_id,
      jsonb_build_object('from_status', v_from_status, 'actor_role', p_actor_role));
  END IF;
  RETURN jsonb_build_object('success', true, 'from_status', v_from_status, 'to_status', 'active');
END;
$$;

CREATE OR REPLACE FUNCTION admin_promo_governance(
  p_campaign_id UUID, p_target_status TEXT, p_actor_id UUID, p_actor_role TEXT, p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_campaign RECORD; v_from_status TEXT;
BEGIN
  SELECT id, business_id, name, status INTO v_campaign FROM promo_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign not found'); END IF;
  v_from_status := v_campaign.status;
  UPDATE promo_campaigns SET status = p_target_status::promo_campaign_status WHERE id = p_campaign_id;
  INSERT INTO admin_audit_logs (actor_id, action, entity_type, entity_id, details)
  VALUES (p_actor_id, 'promotions.' || p_target_status, 'promo_campaign', p_campaign_id,
    jsonb_build_object('business_id', v_campaign.business_id, 'campaign_name', v_campaign.name,
      'from_status', v_from_status, 'to_status', p_target_status, 'actor_role', p_actor_role, 'reason', coalesce(p_reason, '')));
  RETURN jsonb_build_object('success', true, 'from_status', v_from_status, 'to_status', p_target_status);
END;
$$;
