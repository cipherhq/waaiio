-- Migration 302: Atomic human handoff for CAS-008
--
-- Ensures bot_sessions handoff state and chat_conversations are created
-- together in a single transaction. Prevents partial state where
-- handed_off=true but no active conversation exists.
--
-- Returns JSONB with result:
--   success + already_active: session already handed off WITH valid conversation
--   success + created: new handoff created atomically
--   success + repaired: session claimed handoff but conversation was missing; repaired
--   failure + cross_business: session does not belong to supplied business
--   failure + session_not_found: no matching active session
--
-- Rollback:
--   DROP FUNCTION IF EXISTS atomic_escalate_to_human(UUID, UUID, TEXT, TEXT, JSONB, TEXT);

CREATE OR REPLACE FUNCTION atomic_escalate_to_human(
  p_session_id UUID,
  p_business_id UUID,
  p_customer_phone TEXT,
  p_customer_name TEXT,
  p_session_data JSONB,
  p_current_step TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session bot_sessions;
  v_conv_exists BOOLEAN;
  v_conv_id UUID;
BEGIN
  -- 1. Lock and fetch the session row
  SELECT * INTO v_session
  FROM bot_sessions
  WHERE id = p_session_id
    AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'session_not_found');
  END IF;

  -- 2. Cross-business guard
  IF v_session.business_id IS DISTINCT FROM p_business_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'cross_business');
  END IF;

  -- 3. Check for existing active conversation for this business+phone
  SELECT id INTO v_conv_id
  FROM chat_conversations
  WHERE business_id = p_business_id
    AND customer_phone = p_customer_phone
    AND status IN ('open', 'pending');

  v_conv_exists := v_conv_id IS NOT NULL;

  -- 4. Already-active check: session says handoff AND conversation exists
  IF v_session.current_step = 'chat_handoff'
     AND v_session.handed_off = true
     AND v_conv_exists THEN
    RETURN jsonb_build_object(
      'success', true,
      'outcome', 'already_active',
      'conversation_id', v_conv_id
    );
  END IF;

  -- 5. Atomically update session to handoff state
  UPDATE bot_sessions
  SET
    current_step = 'chat_handoff',
    handed_off = true,
    session_data = p_session_data || jsonb_build_object('_pre_handoff_step', p_current_step),
    updated_at = NOW()
  WHERE id = p_session_id;

  -- 6. Upsert chat_conversations
  INSERT INTO chat_conversations (
    business_id, customer_phone, customer_name,
    status, escalated_from_step, escalated_at,
    bot_session_id, session_context, last_message_at
  ) VALUES (
    p_business_id, p_customer_phone, p_customer_name,
    'open', p_current_step, NOW(),
    p_session_id, p_session_data, NOW()
  )
  ON CONFLICT (business_id, customer_phone)
  DO UPDATE SET
    status = 'open',
    escalated_from_step = EXCLUDED.escalated_from_step,
    escalated_at = EXCLUDED.escalated_at,
    bot_session_id = EXCLUDED.bot_session_id,
    session_context = EXCLUDED.session_context,
    last_message_at = EXCLUDED.last_message_at,
    updated_at = NOW()
  RETURNING id INTO v_conv_id;

  -- 7. Determine outcome: was this a repair of inconsistent state or fresh creation?
  IF v_session.current_step = 'chat_handoff' AND v_session.handed_off = true THEN
    -- Session claimed handoff but conversation was missing — now repaired
    RETURN jsonb_build_object(
      'success', true,
      'outcome', 'repaired',
      'conversation_id', v_conv_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'outcome', 'created',
    'conversation_id', v_conv_id
  );
END;
$$;

-- Security: service_role only
REVOKE ALL ON FUNCTION atomic_escalate_to_human(UUID, UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION atomic_escalate_to_human(UUID, UUID, TEXT, TEXT, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION atomic_escalate_to_human(UUID, UUID, TEXT, TEXT, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION atomic_escalate_to_human(UUID, UUID, TEXT, TEXT, JSONB, TEXT) TO service_role;
