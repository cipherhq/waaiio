-- ══════════════════════════════════════════════════════════════
-- Migration 340: Promo Routing Consistency
-- ══════════════════════════════════════════════════════════════
-- Issue: #198 — Safe routing/keyword edits and deterministic
--   activation-conflict handling for promo campaigns.
--
-- Changes (in order):
--   A. Keyword normalization trigger
--   B. Legacy data repair (deterministic, fail-closed)
--   C. Collision guard (abort if repair created conflicts)
--   D. Replace CHECK constraint with stricter version
--   E. Update validate_promo_campaign_activation (keyword + bare-code + scheduled)
--   F. Update activate_promo_campaign (constraint-specific exception handling)
--   G. New update_promo_campaign_routing RPC
--   H. Privilege reassertion for all functions
-- ══════════════════════════════════════════════════════════════

-- ── A. Keyword normalization trigger ──

CREATE OR REPLACE FUNCTION normalize_promo_keyword()
RETURNS TRIGGER AS $$
BEGIN
  NEW.keyword := NULLIF(upper(btrim(NEW.keyword)), '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_normalize_promo_keyword
  BEFORE INSERT OR UPDATE OF keyword ON promo_campaigns
  FOR EACH ROW EXECUTE FUNCTION normalize_promo_keyword();

-- ── B. Legacy data repair (deterministic, fail-closed) ──

-- Normalize existing keywords
UPDATE promo_campaigns SET keyword = NULLIF(upper(btrim(keyword)), '') WHERE keyword IS NOT NULL;

-- keyword mode: force bare=false
UPDATE promo_campaigns SET accept_bare_codes = false WHERE code_entry_mode = 'keyword' AND accept_bare_codes = true;

-- bare_code mode: force bare=true, clear keyword
UPDATE promo_campaigns SET accept_bare_codes = true, keyword = NULL WHERE code_entry_mode = 'bare_code' AND (accept_bare_codes = false OR keyword IS NOT NULL);

-- both mode: force bare=true (before the abort check so we only abort on genuinely unfixable rows)
UPDATE promo_campaigns SET accept_bare_codes = true WHERE code_entry_mode = 'both' AND accept_bare_codes = false;

-- both or keyword mode with no keyword after normalization: ABORT
DO $$
DECLARE v_missing_keyword_count INTEGER;
BEGIN
  SELECT count(*) INTO v_missing_keyword_count FROM promo_campaigns
    WHERE code_entry_mode IN ('keyword', 'both') AND keyword IS NULL;
  IF v_missing_keyword_count > 0 THEN
    RAISE EXCEPTION 'Migration blocked: % campaign(s) with keyword/both mode have no keyword after normalization. Manual repair required.', v_missing_keyword_count;
  END IF;
END $$;

-- ── C. Collision guard (abort if repair created conflicts) ──

DO $$
DECLARE v_collision_count INTEGER;
BEGIN
  SELECT count(*) INTO v_collision_count FROM (
    SELECT business_id, lower(keyword) FROM promo_campaigns
      WHERE keyword IS NOT NULL AND status IN ('active', 'scheduled')
      GROUP BY business_id, lower(keyword) HAVING count(*) > 1
  ) t;
  IF v_collision_count > 0 THEN
    RAISE EXCEPTION 'Migration blocked: % active/scheduled keyword collision(s). Manual resolution required.', v_collision_count;
  END IF;

  SELECT count(*) INTO v_collision_count FROM (
    SELECT business_id FROM promo_campaigns
      WHERE accept_bare_codes = true AND status IN ('active', 'scheduled')
      GROUP BY business_id HAVING count(*) > 1
  ) t;
  IF v_collision_count > 0 THEN
    RAISE EXCEPTION 'Migration blocked: % active/scheduled bare-code collision(s). Manual resolution required.', v_collision_count;
  END IF;
END $$;

-- ── D. Replace CHECK constraint ──

ALTER TABLE promo_campaigns DROP CONSTRAINT IF EXISTS chk_keyword_or_bare;
ALTER TABLE promo_campaigns ADD CONSTRAINT chk_routing_consistency CHECK (
  (code_entry_mode = 'keyword'   AND keyword IS NOT NULL AND accept_bare_codes = false) OR
  (code_entry_mode = 'bare_code' AND keyword IS NULL     AND accept_bare_codes = true)  OR
  (code_entry_mode = 'both'      AND keyword IS NOT NULL AND accept_bare_codes = true)
);

-- ── E. Update validate_promo_campaign_activation ──
-- Adds: keyword conflict check (including scheduled), bare-code conflict check (including scheduled),
-- conflict campaign name in error message.

CREATE OR REPLACE FUNCTION validate_promo_campaign_activation(p_campaign_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_campaign RECORD;
  v_errors TEXT[] := '{}';
  v_total_codes INT;
  v_winner_codes INT;
  v_total_prize_qty INT;
  v_incomplete_batches INT;
  v_prize RECORD;
  v_prize_code_count INT;
  v_keyword_conflict_name TEXT;
  v_bare_code_conflict_name TEXT;
BEGIN
  SELECT * INTO v_campaign FROM promo_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('valid', false, 'errors', ARRAY['Campaign not found']); END IF;
  IF v_campaign.end_at IS NOT NULL AND v_campaign.end_at <= now() THEN v_errors := array_append(v_errors, 'Campaign end date is in the past'); END IF;
  SELECT count(*) INTO v_total_codes FROM promo_campaign_codes WHERE campaign_id = p_campaign_id;
  IF v_total_codes = 0 THEN v_errors := array_append(v_errors, 'No codes have been generated or imported'); END IF;
  SELECT count(*) INTO v_incomplete_batches FROM promo_code_batches WHERE campaign_id = p_campaign_id AND status NOT IN ('completed');
  IF v_incomplete_batches > 0 THEN v_errors := array_append(v_errors, v_incomplete_batches || ' batch(es) not completed (pending/processing/failed)'); END IF;
  DECLARE v_failed_batches INT;
  BEGIN
    SELECT count(*) INTO v_failed_batches FROM promo_code_batches WHERE campaign_id = p_campaign_id AND status = 'completed' AND failed_count > 0;
    IF v_failed_batches > 0 THEN v_errors := array_append(v_errors, v_failed_batches || ' completed batch(es) have unresolved failed rows'); END IF;
  END;
  SELECT coalesce(sum(quantity), 0) INTO v_total_prize_qty FROM promo_prizes WHERE campaign_id = p_campaign_id;
  SELECT count(*) INTO v_winner_codes FROM promo_campaign_codes WHERE campaign_id = p_campaign_id AND outcome = 'winner';
  IF v_winner_codes != v_total_prize_qty THEN v_errors := array_append(v_errors, 'Winner code count (' || v_winner_codes || ') does not match prize inventory (' || v_total_prize_qty || ')'); END IF;
  IF v_total_prize_qty > v_total_codes THEN v_errors := array_append(v_errors, 'Prize allocation (' || v_total_prize_qty || ') exceeds total codes (' || v_total_codes || ')'); END IF;
  FOR v_prize IN SELECT id, name, quantity FROM promo_prizes WHERE campaign_id = p_campaign_id
  LOOP
    SELECT count(*) INTO v_prize_code_count FROM promo_campaign_codes WHERE campaign_id = p_campaign_id AND prize_id = v_prize.id;
    IF v_prize_code_count != v_prize.quantity THEN v_errors := array_append(v_errors, 'Prize "' || v_prize.name || '": expected ' || v_prize.quantity || ' codes but found ' || v_prize_code_count); END IF;
  END LOOP;
  IF v_campaign.code_entry_mode IN ('keyword', 'both') AND (v_campaign.keyword IS NULL OR v_campaign.keyword = '') THEN v_errors := array_append(v_errors, 'Keyword mode requires a keyword'); END IF;

  -- Keyword conflict check (including scheduled campaigns)
  IF v_campaign.keyword IS NOT NULL THEN
    SELECT name INTO v_keyword_conflict_name FROM promo_campaigns
      WHERE business_id = v_campaign.business_id AND lower(keyword) = lower(v_campaign.keyword)
        AND status IN ('active', 'scheduled') AND id != p_campaign_id LIMIT 1;
    IF v_keyword_conflict_name IS NOT NULL THEN
      v_errors := array_append(v_errors, 'Keyword "' || v_campaign.keyword || '" conflicts with campaign "' || v_keyword_conflict_name || '"');
    END IF;
  END IF;

  -- Bare-code conflict check (including scheduled campaigns)
  IF v_campaign.accept_bare_codes THEN
    SELECT name INTO v_bare_code_conflict_name FROM promo_campaigns
      WHERE business_id = v_campaign.business_id AND accept_bare_codes = true
        AND status IN ('active', 'scheduled') AND id != p_campaign_id LIMIT 1;
    IF v_bare_code_conflict_name IS NOT NULL THEN
      v_errors := array_append(v_errors, 'Bare-code mode conflicts with campaign "' || v_bare_code_conflict_name || '"');
    END IF;
  END IF;

  IF v_campaign.winner_message IS NULL OR v_campaign.winner_message = '' THEN v_errors := array_append(v_errors, 'Winner message is required'); END IF;
  IF v_campaign.try_again_message IS NULL OR v_campaign.try_again_message = '' THEN v_errors := array_append(v_errors, 'Try-again message is required'); END IF;
  IF v_campaign.invalid_message IS NULL OR v_campaign.invalid_message = '' THEN v_errors := array_append(v_errors, 'Invalid-code message is required'); END IF;
  IF v_campaign.eligibility_mode IN ('age_confirmation', 'custom') AND (v_campaign.eligibility_prompt IS NULL OR v_campaign.eligibility_prompt = '') THEN
    v_errors := array_append(v_errors, 'Eligibility prompt is required for ' || v_campaign.eligibility_mode || ' mode');
  END IF;
  RETURN jsonb_build_object('valid', array_length(v_errors, 1) IS NULL, 'errors', v_errors);
END;
$$;

REVOKE EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) TO service_role;

-- ── F. Update activate_promo_campaign (constraint-specific unique_violation) ──

CREATE OR REPLACE FUNCTION activate_promo_campaign(
  p_campaign_id UUID, p_actor_id UUID DEFAULT NULL, p_actor_role TEXT DEFAULT 'business'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_validation JSONB; v_campaign RECORD; v_from_status TEXT;
  v_constraint_name TEXT; v_conflict_name TEXT;
BEGIN
  SELECT * INTO v_campaign FROM promo_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign not found'); END IF;
  v_from_status := v_campaign.status;
  v_validation := validate_promo_campaign_activation(p_campaign_id);
  IF NOT (v_validation->>'valid')::boolean THEN
    RETURN jsonb_build_object('success', false, 'error', 'Activation validation failed', 'validation_errors', v_validation->'errors');
  END IF;

  BEGIN
    UPDATE promo_campaigns SET status = 'active' WHERE id = p_campaign_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'idx_promo_campaigns_keyword_unique' THEN
      SELECT name INTO v_conflict_name FROM promo_campaigns
        WHERE business_id = v_campaign.business_id AND lower(keyword) = lower(v_campaign.keyword)
          AND status IN ('active', 'scheduled') AND id != p_campaign_id LIMIT 1;
      RETURN jsonb_build_object('success', false, 'error', 'keyword_conflict',
        'conflicting_campaign', coalesce(v_conflict_name, 'another campaign'));
    ELSIF v_constraint_name = 'idx_promo_campaigns_bare_code_active' THEN
      SELECT name INTO v_conflict_name FROM promo_campaigns
        WHERE business_id = v_campaign.business_id AND accept_bare_codes = true
          AND status IN ('active', 'scheduled') AND id != p_campaign_id LIMIT 1;
      RETURN jsonb_build_object('success', false, 'error', 'bare_code_conflict',
        'conflicting_campaign', coalesce(v_conflict_name, 'another campaign'));
    ELSE
      RAISE;
    END IF;
  END;

  IF p_actor_id IS NOT NULL THEN
    INSERT INTO admin_audit_logs (actor_id, action, entity_type, entity_id, details)
    VALUES (p_actor_id, 'promotions.activate', 'promo_campaign', p_campaign_id,
      jsonb_build_object('from_status', v_from_status, 'actor_role', p_actor_role));
  END IF;
  RETURN jsonb_build_object('success', true, 'from_status', v_from_status, 'to_status', 'active');
END;
$$;

REVOKE EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) TO service_role;

-- ── G. New update_promo_campaign_routing RPC ──
-- SECURITY DEFINER, service_role only.
-- Atomically updates routing fields (code_entry_mode, keyword, accept_bare_codes)
-- with conflict preflight, audit logging, and constraint-specific error handling.

CREATE OR REPLACE FUNCTION update_promo_campaign_routing(
  p_campaign_id UUID,
  p_business_id UUID,
  p_actor_id UUID,
  p_code_entry_mode TEXT,
  p_keyword TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_campaign RECORD;
  v_before_state JSONB;
  v_new_keyword TEXT;
  v_new_accept_bare_codes BOOLEAN;
  v_conflict_name TEXT;
  v_constraint_name TEXT;
BEGIN
  -- 1. Lock + business-scope the campaign
  SELECT * INTO v_campaign FROM promo_campaigns
    WHERE id = p_campaign_id AND business_id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaign not found');
  END IF;

  -- 2. Enforce integrity_locked
  IF v_campaign.integrity_locked THEN
    RETURN jsonb_build_object('success', false, 'error', 'integrity_locked');
  END IF;

  -- 3. Validate mode
  IF p_code_entry_mode NOT IN ('keyword', 'bare_code', 'both') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_mode');
  END IF;

  -- 4. Capture before-state
  v_before_state := jsonb_build_object(
    'code_entry_mode', v_campaign.code_entry_mode,
    'keyword', v_campaign.keyword,
    'accept_bare_codes', v_campaign.accept_bare_codes
  );

  -- 5. Canonicalize mode + keyword + derive accept_bare_codes
  v_new_keyword := NULLIF(upper(btrim(COALESCE(p_keyword, ''))), '');

  IF p_code_entry_mode = 'keyword' THEN
    IF v_new_keyword IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'keyword_required');
    END IF;
    v_new_accept_bare_codes := false;
  ELSIF p_code_entry_mode = 'bare_code' THEN
    v_new_keyword := NULL;
    v_new_accept_bare_codes := true;
  ELSIF p_code_entry_mode = 'both' THEN
    IF v_new_keyword IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'keyword_required');
    END IF;
    v_new_accept_bare_codes := true;
  END IF;

  -- 6. Active+scheduled preflight for keyword conflicts
  IF v_new_keyword IS NOT NULL THEN
    SELECT name INTO v_conflict_name FROM promo_campaigns
      WHERE business_id = p_business_id AND lower(keyword) = lower(v_new_keyword)
        AND status IN ('active', 'scheduled') AND id != p_campaign_id LIMIT 1;
    IF v_conflict_name IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'keyword_conflict',
        'conflicting_campaign', v_conflict_name);
    END IF;
  END IF;

  -- 7. Active+scheduled preflight for bare-code conflicts
  IF v_new_accept_bare_codes THEN
    SELECT name INTO v_conflict_name FROM promo_campaigns
      WHERE business_id = p_business_id AND accept_bare_codes = true
        AND status IN ('active', 'scheduled') AND id != p_campaign_id LIMIT 1;
    IF v_conflict_name IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'bare_code_conflict',
        'conflicting_campaign', v_conflict_name);
    END IF;
  END IF;

  -- 8. Perform the routing UPDATE
  BEGIN
    UPDATE promo_campaigns SET
      code_entry_mode = p_code_entry_mode::promo_code_entry_mode,
      keyword = v_new_keyword,
      accept_bare_codes = v_new_accept_bare_codes
    WHERE id = p_campaign_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'idx_promo_campaigns_keyword_unique' THEN
      SELECT name INTO v_conflict_name FROM promo_campaigns
        WHERE business_id = p_business_id AND lower(keyword) = lower(v_new_keyword)
          AND status IN ('active', 'scheduled') AND id != p_campaign_id LIMIT 1;
      RETURN jsonb_build_object('success', false, 'error', 'keyword_conflict',
        'conflicting_campaign', coalesce(v_conflict_name, 'another campaign'));
    ELSIF v_constraint_name = 'idx_promo_campaigns_bare_code_active' THEN
      SELECT name INTO v_conflict_name FROM promo_campaigns
        WHERE business_id = p_business_id AND accept_bare_codes = true
          AND status IN ('active', 'scheduled') AND id != p_campaign_id LIMIT 1;
      RETURN jsonb_build_object('success', false, 'error', 'bare_code_conflict',
        'conflicting_campaign', coalesce(v_conflict_name, 'another campaign'));
    ELSE
      RAISE;
    END IF;
  END;

  -- 9. Audit for active/paused campaigns (same transaction)
  IF v_campaign.status IN ('active', 'paused') THEN
    INSERT INTO admin_audit_logs (actor_id, action, entity_type, entity_id, details)
    VALUES (p_actor_id, 'promotions.routing_update', 'promo_campaign', p_campaign_id,
      jsonb_build_object(
        'business_id', p_business_id,
        'before', v_before_state,
        'after', jsonb_build_object(
          'code_entry_mode', p_code_entry_mode,
          'keyword', v_new_keyword,
          'accept_bare_codes', v_new_accept_bare_codes
        ),
        'reason', coalesce(p_reason, '')
      ));
  END IF;

  RETURN jsonb_build_object('success', true,
    'before', v_before_state,
    'after', jsonb_build_object(
      'code_entry_mode', p_code_entry_mode,
      'keyword', v_new_keyword,
      'accept_bare_codes', v_new_accept_bare_codes
    ));
END;
$$;

-- ── H. Privilege reassertion for all functions ──

-- update_promo_campaign_routing
REVOKE EXECUTE ON FUNCTION update_promo_campaign_routing(UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_promo_campaign_routing(UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION update_promo_campaign_routing(UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION update_promo_campaign_routing(UUID, UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

-- activate_promo_campaign (reassert)
REVOKE EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) TO service_role;

-- validate_promo_campaign_activation (reassert)
REVOKE EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) TO service_role;
