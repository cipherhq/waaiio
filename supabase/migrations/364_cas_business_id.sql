-- Migration 364: Extend update_session_cas with optional p_business_id
--
-- Replaces the 6-arg overload (migration 236) with a single 7-arg authority
-- that includes p_business_id UUID DEFAULT NULL.
--
-- When p_business_id IS NULL (default): preserves existing business_id.
-- When non-null: atomically updates business_id with the session transition.
--
-- Existing callers that pass 6 args continue to work because the 7th
-- parameter has a DEFAULT value. There is exactly one function authority
-- after this migration.
--
-- Refs: #281, #271

-- 1. Drop the old 6-arg overload so we don't leave two competing authorities.
--    The new 7-arg version with DEFAULT NULL handles all existing call patterns.
DROP FUNCTION IF EXISTS public.update_session_cas(UUID, BIGINT, TEXT, JSONB, JSONB, TEXT[]);

-- 2. Create the single canonical update_session_cas with p_business_id
CREATE OR REPLACE FUNCTION public.update_session_cas(
  p_session_id UUID,
  p_expected_version BIGINT,
  p_current_step TEXT,
  p_session_data JSONB,
  p_conversation_log JSONB DEFAULT NULL,
  p_step_history TEXT[] DEFAULT NULL,
  p_business_id UUID DEFAULT NULL
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
    current_step = p_current_step,
    session_data = p_session_data,
    conversation_log = COALESCE(p_conversation_log, conversation_log),
    business_id = COALESCE(p_business_id, business_id),
    version = version + 1,
    updated_at = NOW()
  WHERE id = p_session_id
    AND version = p_expected_version
  RETURNING * INTO v_result;

  IF NOT FOUND THEN
    SELECT * INTO v_result FROM bot_sessions WHERE id = p_session_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'reason', 'session_not_found');
    END IF;
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'version_conflict',
      'current_version', v_result.version,
      'expected_version', p_expected_version,
      'current_step', v_result.current_step
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'version', v_result.version,
    'current_step', v_result.current_step
  );
END;
$$;

-- 3. Lock down the single canonical signature — service_role only
REVOKE ALL ON FUNCTION public.update_session_cas(UUID, BIGINT, TEXT, JSONB, JSONB, TEXT[], UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_session_cas(UUID, BIGINT, TEXT, JSONB, JSONB, TEXT[], UUID) FROM anon;
REVOKE ALL ON FUNCTION public.update_session_cas(UUID, BIGINT, TEXT, JSONB, JSONB, TEXT[], UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_session_cas(UUID, BIGINT, TEXT, JSONB, JSONB, TEXT[], UUID) TO service_role;
