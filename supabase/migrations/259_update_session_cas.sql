-- Create an RPC that performs compare-and-set session updates
CREATE OR REPLACE FUNCTION update_session_cas(
  p_session_id UUID,
  p_expected_version BIGINT,
  p_current_step TEXT,
  p_session_data JSONB,
  p_conversation_log JSONB DEFAULT NULL,
  p_step_history TEXT[] DEFAULT NULL
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
    version = version + 1,
    updated_at = NOW()
  WHERE id = p_session_id
    AND version = p_expected_version
  RETURNING * INTO v_result;

  IF NOT FOUND THEN
    -- Version mismatch — return the current state so caller can retry
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

-- Only service role should call this
