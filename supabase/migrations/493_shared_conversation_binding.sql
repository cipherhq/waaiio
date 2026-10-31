-- Explicit customer selection on a shared channel; never infer authority from recency.
BEGIN;
CREATE TABLE public.bot_conversation_bindings (
  whatsapp_number text NOT NULL,
  channel_id uuid NOT NULL REFERENCES public.whatsapp_channels(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.bot_sessions(id) ON DELETE SET NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (whatsapp_number, channel_id)
);
ALTER TABLE public.bot_conversation_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bot_conversation_bindings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_conversation_bindings TO service_role;

CREATE FUNCTION public.get_shared_conversation(p_phone text, p_channel_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_binding public.bot_conversation_bindings%ROWTYPE;
  v_session public.bot_sessions%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_channels WHERE id = p_channel_id
    AND channel_type = 'shared' AND is_active AND connection_status = 'active') THEN
    RETURN jsonb_build_object('version', 0);
  END IF;
  SELECT * INTO v_binding FROM public.bot_conversation_bindings
    WHERE whatsapp_number = p_phone AND channel_id = p_channel_id;
  -- A pending explicit choice takes precedence over an earlier merchant conversation.
  SELECT * INTO v_session FROM public.bot_sessions
    WHERE whatsapp_number = p_phone AND business_id IS NULL AND is_active
      AND expires_at > now() AND current_step IN ('select_business_suggestion', 'greeting', 'directory_search', 'directory_results')
      AND session_data->>'_inbound_channel_id' = p_channel_id::text
      AND session_data->>'_conversation_version' = coalesce(v_binding.version, 0)::text
      AND NOT (session_data ? '_pending_stop' OR session_data ? '_pending_stop_choice')
    LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('version', coalesce(v_binding.version, 0), 'business_id', v_binding.business_id, 'session', to_jsonb(v_session));
  END IF;
  SELECT s.* INTO v_session FROM public.bot_sessions s
    JOIN public.businesses b ON b.id = s.business_id
    WHERE s.id = v_binding.session_id AND s.business_id = v_binding.business_id AND s.whatsapp_number = p_phone
      AND s.is_active AND s.expires_at > now()
      AND s.session_data->>'_inbound_channel_id' = p_channel_id::text
      AND b.status = 'active' AND b.wa_method = 'shared' AND b.assigned_channel_id = p_channel_id;
  RETURN jsonb_build_object('version', coalesce(v_binding.version, 0), 'business_id', v_binding.business_id,
    'session', CASE WHEN FOUND THEN to_jsonb(v_session) ELSE NULL END);
END $$;

CREATE FUNCTION public.select_shared_conversation(
  p_phone text, p_channel_id uuid, p_session_id uuid, p_expected_version bigint,
  p_picker_id uuid DEFAULT NULL, p_picker_version integer DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_business_id uuid;
  v_picker public.bot_sessions%ROWTYPE;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0 OR p_phone IS NULL OR p_channel_id IS NULL THEN RETURN false; END IF;
  -- Serialize first-selection INSERTs as well as updates; collisions only serialize extra work.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_phone || ':' || p_channel_id::text, 0));
  IF coalesce((SELECT version FROM public.bot_conversation_bindings
    WHERE whatsapp_number = p_phone AND channel_id = p_channel_id), 0) <> p_expected_version THEN
    RETURN false;
  END IF;
  SELECT s.business_id INTO v_business_id FROM public.bot_sessions s
    JOIN public.businesses b ON b.id = s.business_id
    JOIN public.whatsapp_channels c ON c.id = p_channel_id
    WHERE s.id = p_session_id AND s.whatsapp_number = p_phone
      AND s.is_active AND s.expires_at > now()
      AND s.session_data->>'_inbound_channel_id' = p_channel_id::text
      AND b.status = 'active' AND b.wa_method = 'shared' AND b.assigned_channel_id = c.id
      AND c.channel_type = 'shared' AND c.is_active AND c.connection_status = 'active'
    FOR SHARE OF s, b, c;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_picker_id IS NOT NULL THEN
    SELECT * INTO v_picker FROM public.bot_sessions WHERE id = p_picker_id FOR UPDATE;
    IF NOT FOUND OR v_picker.business_id IS NOT NULL OR v_picker.whatsapp_number <> p_phone
      OR NOT v_picker.is_active OR v_picker.expires_at <= now()
      OR v_picker.current_step NOT IN ('select_business_suggestion', 'directory_search', 'directory_results')
      OR v_picker.version IS DISTINCT FROM p_picker_version
      OR v_picker.session_data->>'_inbound_channel_id' IS DISTINCT FROM p_channel_id::text
      OR v_picker.session_data->>'_conversation_version' IS DISTINCT FROM p_expected_version::text
      OR v_picker.session_data ? '_pending_stop' OR v_picker.session_data ? '_pending_stop_choice'
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_picker.session_data->'suggestions','[]'::jsonb)
          || coalesce(v_picker.session_data->'_directory_results','[]'::jsonb)
          || coalesce(v_picker.session_data->'_directory_suggestions','[]'::jsonb)) choice
        WHERE coalesce(choice->>'id',choice->>'businessId') = v_business_id::text) THEN RETURN false; END IF;
  END IF;
  INSERT INTO public.bot_conversation_bindings (whatsapp_number, channel_id, business_id, session_id, version)
    VALUES (p_phone, p_channel_id, v_business_id, p_session_id, 1)
    ON CONFLICT (whatsapp_number, channel_id) DO UPDATE
      SET session_id = excluded.session_id, business_id = excluded.business_id, version = bot_conversation_bindings.version + 1;
  IF p_picker_id IS NOT NULL THEN
    UPDATE public.bot_sessions SET is_active = false, version = version + 1 WHERE id = p_picker_id;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.get_shared_conversation(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.select_shared_conversation(text, uuid, uuid, bigint, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_shared_conversation(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.select_shared_conversation(text, uuid, uuid, bigint, uuid, integer) TO service_role;
DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bot_conversation_bindings'::regclass)
    OR has_table_privilege('authenticated', 'public.bot_conversation_bindings', 'SELECT')
    OR has_table_privilege('anon', 'public.bot_conversation_bindings', 'SELECT')
    OR has_function_privilege('authenticated', 'public.select_shared_conversation(text,uuid,uuid,bigint,uuid,integer)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.get_shared_conversation(text,uuid)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.select_shared_conversation(text,uuid,uuid,bigint,uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Shared conversation final-state privilege verification failed';
  END IF;
END $$;
COMMIT;
