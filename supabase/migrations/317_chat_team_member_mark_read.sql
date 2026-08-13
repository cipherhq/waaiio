-- P1-CHAT-1: Narrow mark-read authority for team members
--
-- Problem: Team members (business_members) have chat SELECT/INSERT but no
-- UPDATE authority. Dashboard markAsRead silently failed for team members.
--
-- Solution: SECURITY DEFINER RPC that ONLY sets is_read=true on inbound
-- messages. No general team-member UPDATE policy — team members cannot
-- mutate message_text, business_id, direction, or other fields.
--
-- Authorization: caller must be business owner OR active business_member.

CREATE OR REPLACE FUNCTION mark_chat_messages_read(
  p_business_id UUID,
  p_message_ids UUID[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID;
  v_is_authorized BOOLEAN;
  v_updated_count INT;
BEGIN
  -- 1. Require authenticated caller
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  -- 2. Authorize: business owner OR active business_member
  SELECT EXISTS (
    SELECT 1 FROM businesses WHERE id = p_business_id AND owner_id = v_caller
    UNION ALL
    SELECT 1 FROM business_members WHERE business_id = p_business_id AND user_id = v_caller AND status = 'active'
  ) INTO v_is_authorized;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'authorization_denied';
  END IF;

  -- 3. Monotonic mark-read: only false→true on inbound messages for this business
  UPDATE chat_messages
  SET is_read = true
  WHERE id = ANY(p_message_ids)
    AND business_id = p_business_id
    AND direction = 'inbound'
    AND is_read = false;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  RETURN jsonb_build_object('updated', v_updated_count);
END;
$$;

-- Permissions
REVOKE EXECUTE ON FUNCTION mark_chat_messages_read(UUID, UUID[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_chat_messages_read(UUID, UUID[]) FROM anon;
GRANT EXECUTE ON FUNCTION mark_chat_messages_read(UUID, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION mark_chat_messages_read(UUID, UUID[]) TO service_role;
