-- #591: immutable native publications and atomic response persistence.
-- Reserved in docs/MIGRATION_REGISTRY.md. No remote application authorized.
BEGIN;

CREATE TABLE public.native_form_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES public.forms(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES public.whatsapp_channels(id),
  phone_number_id text NOT NULL CHECK (phone_number_id ~ '^[0-9]{1,64}$'),
  waba_id text NOT NULL CHECK (waba_id ~ '^[0-9]{1,64}$'),
  revision text NOT NULL CHECK (revision ~ '^[a-f0-9]{64}$'),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  flow_json jsonb NOT NULL CHECK (jsonb_typeof(flow_json) = 'object'),
  meta_flow_id text CHECK (meta_flow_id ~ '^[0-9]{1,64}$'),
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','draft','published','needs_review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (form_id, revision, channel_id, phone_number_id, waba_id),
  CHECK (status <> 'published' OR (meta_flow_id IS NOT NULL AND published_at IS NOT NULL))
);
CREATE INDEX native_form_publications_business_idx ON public.native_form_publications(business_id);
ALTER TABLE public.native_form_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.native_form_publications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.native_form_publications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.native_form_publications TO service_role;
CREATE POLICY native_form_publications_owner_read ON public.native_form_publications FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
CREATE POLICY native_form_publications_service ON public.native_form_publications FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.form_responses ADD COLUMN native_ack_claimed_at timestamptz;
ALTER TABLE public.whatsapp_inbound_receipts ADD COLUMN native_form_send_claimed_at timestamptz;
GRANT UPDATE (native_form_send_claimed_at) ON public.whatsapp_inbound_receipts TO service_role;
-- Existing authenticated permissions are SELECT/DELETE, never INSERT/UPDATE.

ALTER TABLE public.customer_consents ADD COLUMN email_address text
  CHECK (email_address IS NULL OR (channel = 'email' AND email_address = lower(btrim(email_address))
    AND length(email_address) <= 200 AND email_address ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'));
CREATE INDEX customer_consents_email_591 ON public.customer_consents(business_id, email_address, created_at DESC, id DESC)
  WHERE email_address IS NOT NULL;
-- Email addresses are independent of phone identities. Keep the existing phone
-- suppression index unchanged; it cannot represent two addresses on one phone.
CREATE TABLE public.native_form_email_unsubscribes (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  email_address text NOT NULL CHECK (email_address = lower(btrim(email_address))
    AND length(email_address) <= 200 AND email_address ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, email_address)
);
ALTER TABLE public.native_form_email_unsubscribes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.native_form_email_unsubscribes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.native_form_email_unsubscribes TO service_role;
CREATE POLICY native_form_email_unsubscribes_service ON public.native_form_email_unsubscribes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.native_form_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL UNIQUE REFERENCES public.form_responses(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES public.events(id),
  phone text NOT NULL CHECK (phone ~ '^[1-9][0-9]{6,14}$'),
  channel_id uuid NOT NULL REFERENCES public.whatsapp_channels(id),
  session_id uuid,
  booking_id uuid REFERENCES public.bookings(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX native_form_registrations_business_591 ON public.native_form_registrations(business_id);
ALTER TABLE public.native_form_registrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.native_form_registrations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.native_form_registrations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.native_form_registrations TO service_role;
CREATE POLICY native_form_registrations_owner_read ON public.native_form_registrations FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
CREATE POLICY native_form_registrations_service ON public.native_form_registrations FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.native_form_email_batches (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX native_form_email_batches_business_591 ON public.native_form_email_batches(business_id);
ALTER TABLE public.native_form_email_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.native_form_email_batches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.native_form_email_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.native_form_email_batches TO service_role;
CREATE POLICY native_form_email_batches_owner_read ON public.native_form_email_batches FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
CREATE POLICY native_form_email_batches_service ON public.native_form_email_batches FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.complete_native_form_publication_591(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE p public.native_form_publications; f public.forms;
BEGIN
  SELECT * INTO p FROM public.native_form_publications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR p.status <> 'draft' OR p.meta_flow_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO f FROM public.forms WHERE id = p.form_id AND business_id = p.business_id FOR UPDATE;
  IF NOT FOUND OR NOT f.is_active OR
    p.config IS DISTINCT FROM jsonb_build_object('title', f.title, 'description', f.description, 'fields', f.fields, 'settings', f.settings)
    OR NOT EXISTS (SELECT 1 FROM public.whatsapp_channels c WHERE c.id = p.channel_id AND c.is_active
      AND c.phone_number_id = p.phone_number_id AND c.waba_id = p.waba_id
      AND (c.channel_type = 'shared' OR c.business_id = p.business_id)) THEN RETURN false; END IF;
  UPDATE public.native_form_publications SET status = 'published', published_at = now() WHERE id = p.id;
  UPDATE public.forms SET meta_flow_id = p.meta_flow_id, meta_flow_status = 'published', native_flow_json = p.flow_json WHERE id = f.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.complete_native_form_publication_591(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_native_form_publication_591(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.save_native_form_response_591(
  p_publication_id uuid, p_business_id uuid, p_channel_id uuid, p_phone_number_id text,
  p_asset_id text, p_revision text, p_phone text, p_nonce_hash text,
  p_answers jsonb, p_name text DEFAULT NULL, p_email text DEFAULT NULL, p_consent boolean DEFAULT NULL,
  p_email_consent boolean DEFAULT false, p_message_id text DEFAULT NULL, p_provider_timestamp timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE p public.native_form_publications; f public.forms; r public.form_responses; v_registration_id uuid; v_event_id uuid; v_email text;
BEGIN
  IF p_publication_id IS NULL OR p_business_id IS NULL OR p_channel_id IS NULL OR p_phone_number_id IS NULL OR p_asset_id IS NULL OR p_revision IS NULL
    OR p_phone IS NULL OR p_nonce_hash IS NULL OR p_phone !~ '^[1-9][0-9]{6,14}$' OR p_nonce_hash !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_answers) IS DISTINCT FROM 'object' OR octet_length(p_answers::text) > 102400 THEN
    RETURN jsonb_build_object('error', 'invalid_submission');
  END IF;
  -- Global nonce index remains the replay authority, including simultaneous workers.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_nonce_hash, 591));
  SELECT * INTO r FROM public.form_responses WHERE flow_token_hash = p_nonce_hash;
  IF FOUND THEN
    IF r.business_id = p_business_id AND r.customer_phone = p_phone
      AND r.metadata->>'publication_id' = p_publication_id::text
      AND r.metadata->>'channel_id' = p_channel_id::text
      AND r.metadata->>'phone_number_id' = p_phone_number_id THEN
      SELECT id INTO v_registration_id FROM public.native_form_registrations WHERE response_id = r.id;
      RETURN jsonb_build_object('response_id', r.id, 'duplicate', true, 'registration_id', v_registration_id);
    END IF;
    RETURN jsonb_build_object('error', 'replay_scope_mismatch');
  END IF;
  SELECT * INTO p FROM public.native_form_publications WHERE id = p_publication_id FOR SHARE;
  IF NOT FOUND OR p.status <> 'published' OR p.business_id <> p_business_id
    OR p.channel_id <> p_channel_id OR p.phone_number_id <> p_phone_number_id
    OR p.meta_flow_id IS DISTINCT FROM p_asset_id OR p.revision <> p_revision THEN
    RETURN jsonb_build_object('error', 'publication_mismatch');
  END IF;
  SELECT * INTO f FROM public.forms WHERE id = p.form_id AND business_id = p_business_id FOR UPDATE;
  IF NOT FOUND OR NOT f.is_active OR
    p.config IS DISTINCT FROM jsonb_build_object('title', f.title, 'description', f.description, 'fields', f.fields, 'settings', f.settings)
    OR NOT EXISTS (SELECT 1 FROM public.whatsapp_channels c WHERE c.id = p_channel_id AND c.is_active
      AND c.phone_number_id = p_phone_number_id AND c.waba_id = p.waba_id
      AND (c.channel_type = 'shared' OR c.business_id = p_business_id)) THEN
    RETURN jsonb_build_object('error', 'form_changed');
  END IF;
  IF p_message_id IS NULL OR p_provider_timestamp IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.whatsapp_inbound_receipts WHERE channel_id = p_channel_id
      AND message_id = p_message_id AND sender_phone = p_phone AND provider_timestamp = p_provider_timestamp
  ) THEN RETURN jsonb_build_object('error', 'receipt_unavailable'); END IF;
  v_email := nullif(lower(btrim(p_email)), '');
  IF p_email_consent AND ((p.config->'settings'->>'email_marketing_opt_in') IS DISTINCT FROM 'true'
    OR v_email IS NULL OR length(v_email) > 200 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') THEN
    RETURN jsonb_build_object('error', 'invalid_email_consent');
  END IF;
  IF nullif(p.config->'settings'->>'registration_event_id', '') IS NOT NULL THEN
    v_event_id := (p.config->'settings'->>'registration_event_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.events WHERE id = v_event_id AND business_id = p_business_id AND status = 'published' AND date >= CURRENT_DATE) THEN
      RETURN jsonb_build_object('error', 'registration_unavailable');
    END IF;
  END IF;
  INSERT INTO public.form_responses(form_id, business_id, customer_phone, customer_name, customer_email,
    answers, submission_source, flow_token_hash, consent_given, metadata)
  VALUES (p.form_id, p_business_id, p_phone, p_name, v_email, p_answers, 'native', p_nonce_hash, p_consent,
    jsonb_build_object('source', 'whatsapp_nfm_reply', 'publication_id', p.id, 'channel_id', p.channel_id,
      'phone_number_id', p.phone_number_id, 'revision', p.revision, 'form_config', p.config,
      'email_consent', coalesce(p_email_consent, false), 'email_verified', false,
      'native_inbound_message_id', p_message_id, 'native_inbound_at', p_provider_timestamp))
  RETURNING * INTO r;
  IF v_event_id IS NOT NULL THEN
    INSERT INTO public.native_form_registrations(response_id, business_id, event_id, phone, channel_id)
      VALUES (r.id, p_business_id, v_event_id, p_phone, p_channel_id) RETURNING id INTO v_registration_id;
  END IF;
  IF p_email_consent THEN
    INSERT INTO public.customer_consents(business_id, phone, channel, purpose, status, source,
      email_address, evidence_reference, policy_version, granted_at)
    VALUES (p_business_id, p_phone, 'email', 'marketing', 'granted', 'whatsapp', v_email,
      'native_form:' || r.id::text, 'native-email-marketing-v1-unverified', now());
    -- Opt-out rows are deliberately NOT cleared by a checkbox. Suppression wins.
  END IF;
  UPDATE public.forms SET response_count = response_count + 1 WHERE id = p.form_id;
  RETURN jsonb_build_object('response_id', r.id, 'duplicate', false, 'registration_id', v_registration_id);
END $$;
REVOKE ALL ON FUNCTION public.save_native_form_response_591(uuid,uuid,uuid,text,text,text,text,text,jsonb,text,text,boolean,boolean,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_native_form_response_591(uuid,uuid,uuid,text,text,text,text,text,jsonb,text,text,boolean,boolean,text,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_native_registration_591(
  p_registration_id uuid, p_business_id uuid, p_phone text, p_channel_id uuid, p_capabilities jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE r public.native_form_registrations; s public.bot_sessions; b public.businesses; c public.whatsapp_channels;
  v_binding_version bigint; v_other public.bot_sessions; v_data jsonb; v_version bigint;
BEGIN
  IF p_phone IS NULL OR p_phone !~ '^[1-9][0-9]{6,14}$'
    OR jsonb_typeof(p_capabilities) IS DISTINCT FROM 'array' OR NOT p_capabilities ? 'ticketing' THEN
    RETURN jsonb_build_object('error', 'invalid_registration');
  END IF;
  -- Same transport lock as select_shared_conversation. No other tenant is deactivated.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_phone || ':' || p_channel_id::text, 0));
  SELECT * INTO r FROM public.native_form_registrations WHERE id = p_registration_id FOR UPDATE;
  IF NOT FOUND OR r.business_id <> p_business_id OR r.phone <> p_phone OR r.channel_id <> p_channel_id THEN
    RETURN jsonb_build_object('error', 'registration_mismatch');
  END IF;
  IF r.booking_id IS NOT NULL THEN RETURN jsonb_build_object('error', 'already_started'); END IF;
  SELECT * INTO b FROM public.businesses WHERE id = r.business_id AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'business_unavailable'); END IF;
  SELECT * INTO c FROM public.whatsapp_channels WHERE id = p_channel_id AND is_active FOR SHARE;
  IF NOT FOUND OR (c.channel_type <> 'shared' AND c.business_id IS DISTINCT FROM b.id)
    OR (c.channel_type = 'shared' AND (b.wa_method IS DISTINCT FROM 'shared' OR b.assigned_channel_id IS DISTINCT FROM c.id)) THEN
    RETURN jsonb_build_object('error', 'channel_mismatch');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.events WHERE id = r.event_id AND business_id = b.id AND status = 'published' AND date >= CURRENT_DATE) THEN
    RETURN jsonb_build_object('error', 'event_unavailable');
  END IF;
  SELECT s0.* INTO v_other FROM public.bot_conversation_bindings cb JOIN public.bot_sessions s0 ON s0.id = cb.session_id
    WHERE cb.whatsapp_number = p_phone AND cb.channel_id = p_channel_id FOR UPDATE OF s0;
  IF FOUND AND v_other.business_id IS DISTINCT FROM b.id AND v_other.is_active AND v_other.expires_at > now()
    AND v_other.current_step <> 'select_capability' THEN RETURN jsonb_build_object('error', 'active_checkout'); END IF;
  SELECT * INTO s FROM public.bot_sessions WHERE whatsapp_number = p_phone AND business_id = b.id FOR UPDATE;
  IF r.session_id IS NOT NULL THEN
    -- Never restart an old response after its session was completed/replaced.
    RETURN jsonb_build_object('error', 'already_started', 'session_id', r.session_id);
  END IF;
  IF FOUND AND s.is_active AND (s.expires_at IS NULL OR s.expires_at > now()) AND
    (s.current_step <> 'select_capability' OR s.session_data->>'_inbound_channel_id' IS DISTINCT FROM p_channel_id::text) THEN
    RETURN jsonb_build_object('error', 'active_checkout');
  END IF;
  v_data := jsonb_build_object('business_id', b.id, 'business_name', b.name, 'business_category', b.category,
    'capabilities', p_capabilities, 'active_capability', 'ticketing', '_inbound_channel_id', p_channel_id,
    'biz_resolution', 'native_registration', '_native_registration_id', r.id,
    '_step_history', jsonb_build_array('select_capability', 'select_event'));
  IF s.id IS NOT NULL AND s.session_data ? '_detected_language' THEN
    v_data := v_data || jsonb_build_object('_detected_language', s.session_data->'_detected_language');
  END IF;
  -- Booking creation is idempotent by bot_session_id. Rotate an idle/expired
  -- session identity rather than reusing an old booking's idempotency key.
  IF s.id IS NOT NULL THEN
    v_version := s.version;
    DELETE FROM public.bot_sessions WHERE id = s.id AND version = v_version;
    IF NOT FOUND THEN RAISE EXCEPTION 'native_registration_session_conflict'; END IF;
  END IF;
  INSERT INTO public.bot_sessions(whatsapp_number, business_id, current_step, session_data, is_active, expires_at)
    VALUES (p_phone, b.id, 'select_event', v_data, true, now() + interval '24 hours') RETURNING * INTO s;
  IF c.channel_type = 'shared' THEN
    SELECT coalesce((SELECT version FROM public.bot_conversation_bindings WHERE whatsapp_number = p_phone AND channel_id = p_channel_id), 0) INTO v_binding_version;
    IF NOT public.select_shared_conversation(p_phone, p_channel_id, s.id, v_binding_version, NULL, NULL) THEN
      RAISE EXCEPTION 'native_registration_binding_conflict';
    END IF;
  END IF;
  UPDATE public.native_form_registrations SET session_id = s.id WHERE id = r.id;
  RETURN jsonb_build_object('session', to_jsonb(s), 'event_id', r.event_id);
END $$;
REVOKE ALL ON FUNCTION public.claim_native_registration_591(uuid,uuid,text,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_native_registration_591(uuid,uuid,text,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.attach_native_registration_591(p_registration_id uuid, p_booking_id uuid, p_session_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE r public.native_form_registrations;
BEGIN
  SELECT * INTO r FROM public.native_form_registrations WHERE id = p_registration_id FOR UPDATE;
  IF NOT FOUND OR r.session_id IS DISTINCT FROM p_session_id
    OR (r.booking_id IS NOT NULL AND r.booking_id <> p_booking_id) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bookings b WHERE b.id = p_booking_id AND b.business_id = r.business_id
    AND b.event_id = r.event_id AND b.bot_session_id = r.session_id AND ltrim(b.guest_phone, '+') = r.phone) THEN RETURN false; END IF;
  UPDATE public.native_form_registrations SET booking_id = p_booking_id WHERE id = r.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.attach_native_registration_591(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_native_registration_591(uuid,uuid,uuid) TO service_role;

-- Final-state checks cover every new table/RPC and the narrow receipt claim.
DO $$
DECLARE t text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['native_form_publications','native_form_registrations','native_form_email_batches','native_form_email_unsubscribes'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)
      OR has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE')
      OR has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,DELETE')
      OR NOT has_table_privilege('service_role', 'public.' || t, 'SELECT')
      OR NOT has_table_privilege('service_role', 'public.' || t, 'INSERT')
    THEN RAISE EXCEPTION 'Native forms table authority check failed: %', t; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'complete_native_form_publication_591(uuid)',
    'save_native_form_response_591(uuid,uuid,uuid,text,text,text,text,text,jsonb,text,text,boolean,boolean,text,timestamptz)',
    'claim_native_registration_591(uuid,uuid,text,uuid,jsonb)',
    'attach_native_registration_591(uuid,uuid,uuid)'
  ] LOOP
    IF has_function_privilege('anon', 'public.' || f, 'EXECUTE')
      OR has_function_privilege('authenticated', 'public.' || f, 'EXECUTE')
      OR NOT has_function_privilege('service_role', 'public.' || f, 'EXECUTE')
      OR (SELECT prosecdef OR NOT coalesce(proconfig @> ARRAY['search_path=public, pg_temp'], false)
        FROM pg_proc WHERE oid = ('public.' || f)::regprocedure)
    THEN RAISE EXCEPTION 'Native forms RPC authority check failed: %', f; END IF;
  END LOOP;
  IF NOT has_column_privilege('service_role','public.whatsapp_inbound_receipts','native_form_send_claimed_at','UPDATE')
    OR has_table_privilege('service_role','public.whatsapp_inbound_receipts','UPDATE')
    OR has_column_privilege('service_role','public.whatsapp_inbound_receipts','provider_timestamp','UPDATE')
    OR has_column_privilege('authenticated','public.whatsapp_inbound_receipts','native_form_send_claimed_at','UPDATE')
  THEN RAISE EXCEPTION 'Native receipt claim authority check failed'; END IF;
END $$;
COMMIT;
