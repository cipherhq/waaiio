-- 300: Atomic capability configuration RPC
--
-- Replaces the multi-step disable-all → upsert pattern with a single
-- transaction that rolls back entirely on failure.
--
-- Accepts a full state snapshot (tier, trial, status, selected capabilities,
-- overrides) from the API layer. After acquiring the business lock, verifies
-- the snapshot matches current DB state. If state changed between API
-- validation and RPC execution, raises configuration_conflict.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS configure_business_capabilities(UUID, TEXT[], INT[], TEXT, TIMESTAMPTZ, TEXT, TEXT[], TEXT[]);

CREATE OR REPLACE FUNCTION configure_business_capabilities(
  p_business_id UUID,
  p_capabilities TEXT[],
  p_sort_orders INT[],
  p_expected_tier TEXT DEFAULT NULL,
  p_expected_trial_ends_at TIMESTAMPTZ DEFAULT NULL,
  p_expected_status TEXT DEFAULT NULL,
  p_expected_selected TEXT[] DEFAULT NULL,
  p_expected_overrides TEXT[] DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap TEXT;
  v_idx INT;
  v_result JSONB;
  v_biz RECORD;
  v_current_selected TEXT[];
  v_current_overrides TEXT[];
BEGIN
  -- Validate input lengths match
  IF array_length(p_capabilities, 1) IS DISTINCT FROM array_length(p_sort_orders, 1) THEN
    RAISE EXCEPTION 'capabilities and sort_orders arrays must have equal length';
  END IF;

  -- Validate no duplicates in capabilities
  IF (SELECT COUNT(DISTINCT x) FROM unnest(p_capabilities) x) < array_length(p_capabilities, 1) THEN
    RAISE EXCEPTION 'duplicate capability IDs in request';
  END IF;

  -- Validate at least one capability
  IF array_length(p_capabilities, 1) IS NULL OR array_length(p_capabilities, 1) = 0 THEN
    RAISE EXCEPTION 'must select at least one capability';
  END IF;

  -- Validate no duplicate sort orders
  IF (SELECT COUNT(DISTINCT x) FROM unnest(p_sort_orders) x) < array_length(p_sort_orders, 1) THEN
    RAISE EXCEPTION 'duplicate sort orders in request';
  END IF;

  -- Validate sort orders are non-negative and bounded
  IF EXISTS (SELECT 1 FROM unnest(p_sort_orders) x WHERE x < 0 OR x > 9999) THEN
    RAISE EXCEPTION 'sort orders must be between 0 and 9999';
  END IF;

  -- Lock the business row to serialize concurrent configuration changes
  SELECT subscription_tier, trial_ends_at, status
  INTO v_biz
  FROM businesses
  WHERE id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'business_not_found';
  END IF;

  -- Verify business-level snapshot — detect stale reads
  IF p_expected_tier IS NOT NULL AND v_biz.subscription_tier::TEXT != p_expected_tier THEN
    RAISE EXCEPTION 'configuration_conflict: tier changed';
  END IF;
  IF p_expected_status IS NOT NULL AND v_biz.status::TEXT != p_expected_status THEN
    RAISE EXCEPTION 'configuration_conflict: status changed';
  END IF;
  IF p_expected_trial_ends_at IS NOT NULL AND v_biz.trial_ends_at IS DISTINCT FROM p_expected_trial_ends_at THEN
    RAISE EXCEPTION 'configuration_conflict: trial changed';
  END IF;

  -- Verify selected-capability set snapshot (canonical set comparison, order-independent)
  IF p_expected_selected IS NOT NULL THEN
    SELECT ARRAY(
      SELECT capability::TEXT FROM business_capabilities
      WHERE business_id = p_business_id AND is_enabled = true
      ORDER BY capability
    ) INTO v_current_selected;

    -- Compare as sorted sets
    IF v_current_selected IS DISTINCT FROM (SELECT ARRAY(SELECT unnest(p_expected_selected) ORDER BY 1)) THEN
      RAISE EXCEPTION 'configuration_conflict: selected capabilities changed';
    END IF;
  END IF;

  -- Verify override set snapshot (canonical set comparison, order-independent)
  IF p_expected_overrides IS NOT NULL THEN
    SELECT ARRAY(
      SELECT capability::TEXT FROM capability_overrides
      WHERE business_id = p_business_id
      ORDER BY capability
    ) INTO v_current_overrides;

    -- Compare as sorted sets
    IF v_current_overrides IS DISTINCT FROM (SELECT ARRAY(SELECT unnest(p_expected_overrides) ORDER BY 1)) THEN
      RAISE EXCEPTION 'configuration_conflict: overrides changed';
    END IF;
  END IF;

  -- Step 1: Disable all existing capabilities for this business
  UPDATE business_capabilities
  SET is_enabled = false, updated_at = now()
  WHERE business_id = p_business_id AND is_enabled = true;

  -- Step 2: Upsert each selected capability as enabled, preserving custom_label and config
  FOR v_idx IN 1..array_length(p_capabilities, 1) LOOP
    v_cap := p_capabilities[v_idx];

    INSERT INTO business_capabilities (business_id, capability, is_enabled, sort_order, updated_at)
    VALUES (p_business_id, v_cap::capability_type, true, p_sort_orders[v_idx], now())
    ON CONFLICT (business_id, capability)
    DO UPDATE SET
      is_enabled = true,
      sort_order = EXCLUDED.sort_order,
      updated_at = now();
      -- custom_label and config are NOT touched — preserved from existing row
  END LOOP;

  -- Return the final state
  SELECT jsonb_agg(jsonb_build_object(
    'capability', bc.capability,
    'is_enabled', bc.is_enabled,
    'sort_order', bc.sort_order
  ) ORDER BY bc.sort_order, bc.capability)
  INTO v_result
  FROM business_capabilities bc
  WHERE bc.business_id = p_business_id;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- Only service_role can execute this RPC
REVOKE ALL ON FUNCTION configure_business_capabilities(UUID, TEXT[], INT[], TEXT, TIMESTAMPTZ, TEXT, TEXT[], TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION configure_business_capabilities(UUID, TEXT[], INT[], TEXT, TIMESTAMPTZ, TEXT, TEXT[], TEXT[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION configure_business_capabilities(UUID, TEXT[], INT[], TEXT, TIMESTAMPTZ, TEXT, TEXT[], TEXT[]) TO service_role;
