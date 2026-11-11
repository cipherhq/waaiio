-- Customer prompts have their own durable lifecycle, separate from payment authority.
CREATE TABLE public.transaction_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  completion_key text NOT NULL CHECK (length(completion_key) BETWEEN 1 AND 180),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  channel_id uuid NOT NULL REFERENCES public.whatsapp_channels(id),
  payment_id uuid UNIQUE REFERENCES public.payments(id),
  kind text NOT NULL,
  lang text NOT NULL DEFAULT 'en',
  state text NOT NULL CHECK (state IN ('awaiting_confirmation', 'waiting_card', 'card_active', 'card_resolved', 'ready', 'optin_sending', 'awaiting_optin',
    'consent_pending', 'consent_recording', 'menu_ready', 'menu_sending', 'done')),
  response text CHECK (response IN ('yes', 'no')),
  responded_at timestamptz,
  acknowledgment text,
  includes_waaiio boolean,
  claim_token uuid,
  claim_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, completion_key),
  CHECK ((response IS NULL) = (responded_at IS NULL))
);

-- One interactive follow-up at a time on a customer/channel conversation.
-- Ready rows can queue; ambiguous emission remains fenced, never automatically resent.
CREATE UNIQUE INDEX transaction_followups_conversation_prompt
  ON public.transaction_followups (phone, channel_id)
  WHERE state IN ('card_active', 'card_resolved', 'optin_sending', 'awaiting_optin', 'consent_pending',
                  'consent_recording', 'menu_ready', 'menu_sending');
CREATE INDEX transaction_followups_recovery
  ON public.transaction_followups (state, updated_at)
  WHERE state IN ('waiting_card', 'card_active', 'card_resolved', 'ready', 'consent_pending', 'consent_recording', 'menu_ready');

ALTER TABLE public.transaction_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.transaction_followups FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.transaction_followups TO service_role;

COMMENT ON TABLE public.transaction_followups IS
  'Service-only post-fulfillment card/consent/menu sequencing. Never authorizes payment or fulfillment.';

-- Cancel the PIN conversation and its still-uncommitted offer together. This
-- does not revoke/remove a credential or modify the source payment.
CREATE OR REPLACE FUNCTION public.cancel_transaction_card_setup(
  p_session_id uuid,
  p_expected_version integer,
  p_payment_id uuid,
  p_customer_phone text,
  p_business_id uuid,
  p_session_data jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_session public.bot_sessions%ROWTYPE;
  v_offer public.payment_saved_card_offers%ROWTYPE;
  v_payment_text text;
BEGIN
  IF p_customer_phone IS NULL OR p_customer_phone !~ '^\+[1-9][0-9]{7,14}$'
     OR p_business_id IS NULL OR p_payment_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_identity');
  END IF;
  SELECT * INTO v_session FROM public.bot_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'reason', 'session_missing'); END IF;
  IF v_session.version IS DISTINCT FROM p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'reason', 'version_conflict');
  END IF;
  IF v_session.business_id IS DISTINCT FROM p_business_id
     OR v_session.whatsapp_number NOT IN (p_customer_phone, substring(p_customer_phone from 2))
     OR v_session.is_active IS DISTINCT FROM true
     OR v_session.current_step NOT IN ('save_card_pin', 'verify_card_pin', 'replace_card_pin') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'session_mismatch');
  END IF;
  v_payment_text := CASE WHEN v_session.current_step = 'replace_card_pin'
    THEN v_session.session_data->>'_replace_payment_id'
    ELSE v_session.session_data->>'_save_card_payment_id' END;
  IF v_payment_text IS DISTINCT FROM p_payment_id::text THEN
    RETURN jsonb_build_object('success', false, 'reason', 'payment_mismatch');
  END IF;
  SELECT * INTO v_offer FROM public.payment_saved_card_offers WHERE payment_id = p_payment_id FOR UPDATE;
  IF FOUND THEN
    IF v_offer.business_id IS DISTINCT FROM p_business_id OR v_offer.customer_phone IS DISTINCT FROM p_customer_phone THEN
      RETURN jsonb_build_object('success', false, 'reason', 'offer_mismatch');
    END IF;
    IF v_offer.consent_source = 'provider_checkout' AND v_offer.activation_prompt_sent_at IS NULL
       AND v_offer.claim_token IS NOT NULL AND v_offer.claim_expires_at > now() THEN
      RETURN jsonb_build_object('success', false, 'reason', 'activation_processing');
    END IF;
    IF v_offer.state NOT IN ('accepted', 'declined') OR v_offer.credential_committed_at IS NOT NULL
       OR v_offer.confirmation_send_started_at IS NOT NULL
       OR (v_offer.confirmation_claim_token IS NOT NULL AND v_offer.confirmation_claim_expires_at > now()) THEN
      RETURN jsonb_build_object('success', false, 'reason', 'credential_already_committed');
    END IF;
    UPDATE public.payment_saved_card_offers SET state = 'declined', resolved_at = now()
      WHERE id = v_offer.id;
  END IF;
  UPDATE public.bot_sessions SET current_step = 'select_capability',
    session_data = coalesce(p_session_data, '{}'::jsonb)
      - ARRAY['_save_card_pending', '_save_card_auth', '_save_card_business_id', '_save_card_gateway',
              '_save_card_offer_id', '_replace_method_id', '_replace_payment_id', '_replace_expected_state_hash', '_replace_offer_id'],
    version = version + 1, updated_at = now()
    WHERE id = p_session_id;
  RETURN jsonb_build_object('success', true, 'version', v_session.version + 1);
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_transaction_card_setup(uuid, integer, uuid, text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_transaction_card_setup(uuid, integer, uuid, text, uuid, jsonb) TO service_role;
