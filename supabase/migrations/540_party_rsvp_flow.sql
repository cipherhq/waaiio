-- M540 (#1005 PR 3b): one reusable WhatsApp RSVP form per WhatsApp account, and its replay receipts.
--
-- Owner decisions 2026-11-13: after Yes, a guest answers every party question in one WhatsApp
-- form, filled in at send time. The form is published once per WhatsApp Business Account, not per
-- party. A submission saves only through the M489 RSVP authority, so the same required-answer,
-- plus-ones, capacity and revision rules apply as on the web page and in the bot.
--
-- ACLs are explicit for every role (including service_role), because production's default
-- privileges grant more than staging's. Nothing here is readable by guests or hosts.
BEGIN;

CREATE TABLE public.party_rsvp_flow_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waba_id text NOT NULL CHECK (waba_id ~ '^[0-9]{1,64}$'),
  revision text NOT NULL CHECK (revision ~ '^[a-f0-9]{64}$'),
  flow_json jsonb NOT NULL CHECK (jsonb_typeof(flow_json) = 'object'),
  meta_flow_id text CHECK (meta_flow_id ~ '^[0-9]{1,64}$'),
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','draft','published','needs_review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (waba_id, revision),
  CHECK (status <> 'published' OR (meta_flow_id IS NOT NULL AND published_at IS NOT NULL))
);
ALTER TABLE public.party_rsvp_flow_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.party_rsvp_flow_publications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.party_rsvp_flow_publications TO service_role;
CREATE POLICY party_rsvp_flow_publications_service ON public.party_rsvp_flow_publications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- One row per accepted form submission. The hashed token nonce is the replay authority.
CREATE TABLE public.party_rsvp_flow_receipts (
  nonce_hash text PRIMARY KEY CHECK (nonce_hash ~ '^[a-f0-9]{64}$'),
  invite_id uuid NOT NULL REFERENCES public.event_invites(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL REFERENCES public.party_rsvp_flow_publications(id),
  channel_id uuid NOT NULL REFERENCES public.whatsapp_channels(id) ON DELETE CASCADE,
  phone text NOT NULL CHECK (phone ~ '^[1-9][0-9]{6,14}$'),
  message_id text NOT NULL CHECK (length(message_id) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX party_rsvp_flow_receipts_invite_540 ON public.party_rsvp_flow_receipts(invite_id);
CREATE INDEX party_rsvp_flow_receipts_business_540 ON public.party_rsvp_flow_receipts(business_id);
ALTER TABLE public.party_rsvp_flow_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.party_rsvp_flow_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.party_rsvp_flow_receipts TO service_role;
CREATE POLICY party_rsvp_flow_receipts_service ON public.party_rsvp_flow_receipts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Saves a verified form submission as an accepted RSVP. The caller has already checked the
-- signed token; this re-checks every binding against the database and saves through M489.
-- Nothing partial is saved: a rejected RSVP records no receipt.
CREATE OR REPLACE FUNCTION public.save_party_rsvp_flow_response_540(
  p_publication_id uuid, p_invite_id uuid, p_business_id uuid, p_channel_id uuid, p_phone_number_id text,
  p_asset_id text, p_question_revision integer, p_phone text, p_nonce_hash text,
  p_message_id text, p_provider_timestamp timestamptz, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE pub public.party_rsvp_flow_publications; rec public.party_rsvp_flow_receipts;
  inv public.event_invites; v_revision integer; v_saved jsonb;
BEGIN
  IF p_publication_id IS NULL OR p_invite_id IS NULL OR p_business_id IS NULL OR p_channel_id IS NULL
    OR p_phone_number_id IS NULL OR p_asset_id IS NULL OR p_question_revision IS NULL
    OR p_phone IS NULL OR p_phone !~ '^[1-9][0-9]{6,14}$' OR p_nonce_hash IS NULL OR p_nonce_hash !~ '^[a-f0-9]{64}$'
    OR p_message_id IS NULL OR p_provider_timestamp IS NULL
    OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text) > 16384 THEN
    RETURN jsonb_build_object('error', 'invalid_submission');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_nonce_hash, 540));
  SELECT * INTO rec FROM public.party_rsvp_flow_receipts WHERE nonce_hash = p_nonce_hash;
  IF FOUND THEN
    IF rec.invite_id = p_invite_id AND rec.business_id = p_business_id AND rec.phone = p_phone
      AND rec.publication_id = p_publication_id AND rec.channel_id = p_channel_id THEN
      RETURN jsonb_build_object('invite_id', rec.invite_id, 'duplicate', true);
    END IF;
    RETURN jsonb_build_object('error', 'replay_scope_mismatch');
  END IF;
  SELECT * INTO pub FROM public.party_rsvp_flow_publications WHERE id = p_publication_id FOR SHARE;
  IF NOT FOUND OR pub.status <> 'published' OR pub.meta_flow_id IS DISTINCT FROM p_asset_id
    OR NOT EXISTS (SELECT 1 FROM public.whatsapp_channels c WHERE c.id = p_channel_id AND c.is_active
      AND c.phone_number_id = p_phone_number_id AND c.waba_id = pub.waba_id
      AND (c.channel_type = 'shared' OR c.business_id = p_business_id)) THEN
    RETURN jsonb_build_object('error', 'publication_mismatch');
  END IF;
  SELECT * INTO inv FROM public.event_invites WHERE id = p_invite_id;
  IF NOT FOUND OR inv.party_id IS NULL OR inv.business_id <> p_business_id
    OR regexp_replace(coalesce(inv.guest_phone, ''), '[^0-9]', '', 'g') <> p_phone THEN
    RETURN jsonb_build_object('error', 'invitation_unavailable');
  END IF;
  SELECT question_revision INTO v_revision FROM public.parties WHERE id = inv.party_id AND business_id = p_business_id;
  IF v_revision IS DISTINCT FROM p_question_revision THEN
    -- Owner decision: the host edited the questions after sending, so the guest reopens the invitation.
    RETURN jsonb_build_object('error', 'questions_changed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_inbound_receipts WHERE channel_id = p_channel_id
    AND message_id = p_message_id AND sender_phone = p_phone AND provider_timestamp = p_provider_timestamp) THEN
    RETURN jsonb_build_object('error', 'receipt_unavailable');
  END IF;
  BEGIN
    v_saved := private.complete_party_rsvp_489(inv.invite_token,
      p_payload || jsonb_build_object('status', 'accepted', 'revision', p_question_revision), p_phone, p_business_id);
  -- Only the guest-facing outcomes M489/M457 raise are mapped. Anything else (including a
  -- permission error, which the checks above make unreachable) propagates as an error.
  EXCEPTION WHEN SQLSTATE '40001' THEN RETURN jsonb_build_object('error', 'questions_changed');
    WHEN SQLSTATE '23514' THEN RETURN jsonb_build_object('error', 'capacity');
    WHEN SQLSTATE '22023' OR SQLSTATE '22P02' OR SQLSTATE '22003' THEN RETURN jsonb_build_object('error', 'invalid_answers');
  END;
  INSERT INTO public.party_rsvp_flow_receipts(nonce_hash, invite_id, business_id, publication_id, channel_id, phone, message_id)
    VALUES (p_nonce_hash, inv.id, p_business_id, pub.id, p_channel_id, p_phone, p_message_id);
  RETURN jsonb_build_object('invite_id', inv.id, 'duplicate', false, 'saved', v_saved);
END $$;
REVOKE ALL ON FUNCTION public.save_party_rsvp_flow_response_540(uuid,uuid,uuid,uuid,text,text,integer,text,text,text,timestamptz,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_party_rsvp_flow_response_540(uuid,uuid,uuid,uuid,text,text,integer,text,text,text,timestamptz,jsonb)
  TO service_role;

-- Final-state checks.
DO $$
DECLARE t text; f text := 'public.save_party_rsvp_flow_response_540(uuid,uuid,uuid,uuid,text,text,integer,text,text,text,timestamptz,jsonb)';
BEGIN
  FOREACH t IN ARRAY ARRAY['party_rsvp_flow_publications','party_rsvp_flow_receipts'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)
      OR has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_table_privilege('authenticated', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_table_privilege('service_role', 'public.' || t, 'DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR NOT has_table_privilege('service_role', 'public.' || t, 'SELECT')
      OR NOT has_table_privilege('service_role', 'public.' || t, 'INSERT')
    THEN RAISE EXCEPTION 'M540 table authority check failed: %', t; END IF;
  END LOOP;
  IF has_table_privilege('service_role', 'public.party_rsvp_flow_receipts', 'UPDATE')
    OR NOT has_table_privilege('service_role', 'public.party_rsvp_flow_publications', 'UPDATE') THEN
    RAISE EXCEPTION 'M540 update authority check failed';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
    OR NOT has_function_privilege('service_role', f, 'EXECUTE')
    OR (SELECT prosecdef OR NOT coalesce(proconfig @> ARRAY['search_path=public, pg_temp'], false)
      FROM pg_proc WHERE oid = f::regprocedure) THEN
    RAISE EXCEPTION 'M540 RPC authority check failed';
  END IF;
END $$;
COMMIT;
