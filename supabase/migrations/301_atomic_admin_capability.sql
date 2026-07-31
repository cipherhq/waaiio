-- 301: Atomic platform-admin capability grant/revoke RPCs
--
-- Ensures override mutation + capability state + audit log all
-- succeed or fail together in a single transaction.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS admin_grant_capability(UUID, TEXT, UUID, TEXT);
--   DROP FUNCTION IF EXISTS admin_revoke_capability(UUID, TEXT, UUID, TEXT);

-- ── Grant ──
CREATE OR REPLACE FUNCTION admin_grant_capability(
  p_business_id UUID,
  p_capability TEXT,
  p_granted_by UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Lock business row to serialize concurrent admin operations
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id FOR UPDATE) THEN
    RAISE EXCEPTION 'business_not_found';
  END IF;

  -- Upsert override
  INSERT INTO capability_overrides (business_id, capability, granted_by, reason)
  VALUES (p_business_id, p_capability::capability_type, p_granted_by, p_reason)
  ON CONFLICT (business_id, capability)
  DO UPDATE SET granted_by = EXCLUDED.granted_by, reason = EXCLUDED.reason;

  -- Enable the capability
  INSERT INTO business_capabilities (business_id, capability, is_enabled)
  VALUES (p_business_id, p_capability::capability_type, true)
  ON CONFLICT (business_id, capability)
  DO UPDATE SET is_enabled = true, updated_at = now();

  -- Audit log
  INSERT INTO admin_audit_logs (actor_id, action, entity_type, entity_id, details)
  VALUES (p_granted_by, 'grant_capability', 'business', p_business_id,
    jsonb_build_object('capability', p_capability, 'reason', p_reason));

  RETURN jsonb_build_object('success', true, 'action', 'grant', 'capability', p_capability);
END;
$$;

-- ── Revoke ──
CREATE OR REPLACE FUNCTION admin_revoke_capability(
  p_business_id UUID,
  p_capability TEXT,
  p_granted_by UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Lock business row to serialize concurrent admin operations
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id FOR UPDATE) THEN
    RAISE EXCEPTION 'business_not_found';
  END IF;

  -- Delete override
  DELETE FROM capability_overrides
  WHERE business_id = p_business_id AND capability = p_capability::capability_type;

  -- Disable the capability
  UPDATE business_capabilities
  SET is_enabled = false, updated_at = now()
  WHERE business_id = p_business_id AND capability = p_capability::capability_type;

  -- Audit log
  INSERT INTO admin_audit_logs (actor_id, action, entity_type, entity_id, details)
  VALUES (p_granted_by, 'revoke_capability', 'business', p_business_id,
    jsonb_build_object('capability', p_capability, 'reason', p_reason));

  RETURN jsonb_build_object('success', true, 'action', 'revoke', 'capability', p_capability);
END;
$$;

-- Permission grants
REVOKE ALL ON FUNCTION admin_grant_capability(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_grant_capability(UUID, TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION admin_grant_capability(UUID, TEXT, UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION admin_revoke_capability(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_revoke_capability(UUID, TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION admin_revoke_capability(UUID, TEXT, UUID, TEXT) TO service_role;
