-- Session resilience hardening: atomic deactivation + idempotent session creation
--
-- 1. deactivate_session_atomic: bumps version so pending CAS workers fail
-- 2. create_or_reuse_session: ON CONFLICT returns existing active session

-- ═══════════════════════════════════════════════════════
-- 1. Atomic session deactivation with version bump
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION deactivate_session_atomic(
  p_session_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result bot_sessions;
BEGIN
  UPDATE bot_sessions
  SET
    is_active = false,
    version = version + 1,
    updated_at = NOW()
  WHERE id = p_session_id
    AND is_active = true
  RETURNING * INTO v_result;

  IF NOT FOUND THEN
    -- Already inactive or not found — idempotent success
    RETURN jsonb_build_object('success', true, 'already_inactive', true);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_inactive', false,
    'version', v_result.version
  );
END;
$$;

-- Only service role should call this
REVOKE ALL ON FUNCTION deactivate_session_atomic(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION deactivate_session_atomic(UUID) FROM anon;
REVOKE ALL ON FUNCTION deactivate_session_atomic(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION deactivate_session_atomic(UUID) TO service_role;
