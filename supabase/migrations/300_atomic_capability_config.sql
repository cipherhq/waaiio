-- 300: Atomic capability configuration RPC
--
-- Replaces the multi-step disable-all → upsert pattern with a single
-- transaction that rolls back entirely on failure.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS configure_business_capabilities(UUID, TEXT[], INT[]);

CREATE OR REPLACE FUNCTION configure_business_capabilities(
  p_business_id UUID,
  p_capabilities TEXT[],
  p_sort_orders INT[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap TEXT;
  v_idx INT;
  v_result JSONB;
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

  -- Lock the business row to serialize concurrent configuration changes
  PERFORM 1 FROM businesses WHERE id = p_business_id FOR UPDATE;

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
REVOKE ALL ON FUNCTION configure_business_capabilities(UUID, TEXT[], INT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION configure_business_capabilities(UUID, TEXT[], INT[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION configure_business_capabilities(UUID, TEXT[], INT[]) TO service_role;
