-- ═══════════════════════════════════════════════════════════════════════════════
-- 361: Booking Confirmation Intents — Durable notification intent table + RPCs
--
-- Phase 1 of manual booking fix (#244).
--
-- Problem: Manual booking creation was calling upsert_customer_profile with the
-- service price, inflating customer total_spent/LTV. Booking confirmation was
-- fire-and-forget with no crash-recovery or dispatch-barrier semantics.
--
-- Solution:
--   1. booking_confirmation_intents table with claim/lease/dispatch/recovery
--   2. Four SECURITY DEFINER RPCs (claim, mark-dispatched, record-outcome, expire)
--   3. All RPCs: SET search_path='', fully qualified objects, service_role only
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Create the durable intent table
CREATE TABLE public.booking_confirmation_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES public.bookings(id),
  business_id UUID NOT NULL REFERENCES public.businesses(id),
  purpose TEXT NOT NULL DEFAULT 'create'
    CHECK (purpose IN ('create', 'resend')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claiming','dispatched',
                      'sent','delivered','read','failed','indeterminate')),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  channel TEXT CHECK (channel IN ('whatsapp', 'email')),
  template_name TEXT,
  provider_message_id TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(booking_id, purpose)
);

ALTER TABLE public.booking_confirmation_intents ENABLE ROW LEVEL SECURITY;

-- Default deny: no RLS policies for anon/authenticated.
-- service_role bypasses RLS automatically.

-- Index for cron recovery query (expire_stale_booking_confirmations)
CREATE INDEX idx_bci_status_lease ON public.booking_confirmation_intents (status, lease_expires_at)
  WHERE status = 'claiming';

-- Index for claim lookups
CREATE INDEX idx_bci_booking_purpose ON public.booking_confirmation_intents (booking_id, purpose);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. claim_booking_confirmation RPC
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.claim_booking_confirmation(
  p_booking_id UUID,
  p_purpose TEXT,
  p_business_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booking RECORD;
  v_intent RECORD;
  v_token UUID;
  v_intent_id UUID;
  v_lease TIMESTAMPTZ;
BEGIN
  -- Serialize on the booking row (prevents concurrent claims)
  SELECT id, business_id, guest_phone, guest_email, guest_name
  INTO v_booking
  FROM public.bookings
  WHERE id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'booking_not_found');
  END IF;

  -- Tenant isolation: booking must belong to the requesting business
  IF v_booking.business_id != p_business_id THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'cross_business_denied');
  END IF;

  -- Check for existing intent
  SELECT *
  INTO v_intent
  FROM public.booking_confirmation_intents
  WHERE booking_id = p_booking_id AND purpose = p_purpose
  FOR UPDATE;

  v_token := gen_random_uuid();
  v_lease := now() + interval '2 minutes';

  IF NOT FOUND THEN
    -- No intent exists: create one
    INSERT INTO public.booking_confirmation_intents (
      booking_id, business_id, purpose, status,
      claim_token, claimed_at, lease_expires_at, attempt_count
    ) VALUES (
      p_booking_id, p_business_id, p_purpose, 'claiming',
      v_token, now(), v_lease, 1
    )
    RETURNING id INTO v_intent_id;

    RETURN jsonb_build_object(
      'claimed', true,
      'claim_token', v_token,
      'intent_id', v_intent_id,
      'guest_phone', v_booking.guest_phone,
      'guest_email', v_booking.guest_email,
      'guest_name', v_booking.guest_name
    );
  END IF;

  -- Intent exists: check if reclaimable
  -- Terminal states: sent, delivered, read — already done
  IF v_intent.status IN ('sent', 'delivered', 'read') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_sent', 'intent_id', v_intent.id);
  END IF;

  -- Dispatched but no outcome = indeterminate. Don't reclaim — unknown if message was sent.
  IF v_intent.status = 'dispatched' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'dispatched_unknown', 'intent_id', v_intent.id);
  END IF;

  -- Indeterminate: already crashed after dispatch. Don't blindly resend.
  IF v_intent.status = 'indeterminate' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'indeterminate', 'intent_id', v_intent.id);
  END IF;

  -- Max attempts check
  IF v_intent.attempt_count >= v_intent.max_attempts THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'max_attempts', 'intent_id', v_intent.id);
  END IF;

  -- Claiming with active lease: someone else is working on it
  IF v_intent.status = 'claiming' AND v_intent.lease_expires_at > now() THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'lease_active', 'intent_id', v_intent.id);
  END IF;

  -- Reclaimable: pending, failed, or claiming with expired lease
  UPDATE public.booking_confirmation_intents
  SET status = 'claiming',
      claim_token = v_token,
      claimed_at = now(),
      lease_expires_at = v_lease,
      attempt_count = attempt_count + 1,
      updated_at = now()
  WHERE id = v_intent.id;

  RETURN jsonb_build_object(
    'claimed', true,
    'claim_token', v_token,
    'intent_id', v_intent.id,
    'guest_phone', v_booking.guest_phone,
    'guest_email', v_booking.guest_email,
    'guest_name', v_booking.guest_name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_booking_confirmation(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_booking_confirmation(UUID, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.claim_booking_confirmation(UUID, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_booking_confirmation(UUID, TEXT, UUID) TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. mark_booking_confirmation_dispatched RPC
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mark_booking_confirmation_dispatched(
  p_intent_id UUID,
  p_claim_token UUID,
  p_channel TEXT,
  p_template_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent RECORD;
BEGIN
  SELECT * INTO v_intent
  FROM public.booking_confirmation_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('dispatched', false, 'reason', 'intent_not_found');
  END IF;

  IF v_intent.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('dispatched', false, 'reason', 'token_mismatch');
  END IF;

  IF v_intent.status != 'claiming' THEN
    RETURN jsonb_build_object('dispatched', false, 'reason', 'wrong_status', 'current_status', v_intent.status);
  END IF;

  UPDATE public.booking_confirmation_intents
  SET status = 'dispatched',
      dispatched_at = now(),
      channel = p_channel,
      template_name = p_template_name,
      updated_at = now()
  WHERE id = p_intent_id;

  RETURN jsonb_build_object('dispatched', true);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_booking_confirmation_dispatched(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_booking_confirmation_dispatched(UUID, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.mark_booking_confirmation_dispatched(UUID, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_booking_confirmation_dispatched(UUID, UUID, TEXT, TEXT) TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. record_booking_confirmation_outcome RPC
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.record_booking_confirmation_outcome(
  p_intent_id UUID,
  p_claim_token UUID,
  p_outcome TEXT,
  p_provider_message_id TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent RECORD;
BEGIN
  IF p_outcome NOT IN ('sent', 'failed', 'indeterminate') THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'invalid_outcome');
  END IF;

  SELECT * INTO v_intent
  FROM public.booking_confirmation_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'intent_not_found');
  END IF;

  IF v_intent.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'token_mismatch');
  END IF;

  IF p_outcome = 'sent' THEN
    -- Must be dispatched to record as sent
    IF v_intent.status NOT IN ('dispatched', 'claiming') THEN
      RETURN jsonb_build_object('recorded', false, 'reason', 'wrong_status', 'current_status', v_intent.status);
    END IF;
    UPDATE public.booking_confirmation_intents
    SET status = 'sent',
        sent_at = now(),
        provider_message_id = p_provider_message_id,
        updated_at = now()
    WHERE id = p_intent_id;
  ELSIF p_outcome = 'failed' THEN
    -- Pre-dispatch failure: reclaimable
    IF v_intent.dispatched_at IS NOT NULL THEN
      -- Post-dispatch failure is indeterminate, not failed
      RETURN jsonb_build_object('recorded', false, 'reason', 'post_dispatch_use_indeterminate');
    END IF;
    UPDATE public.booking_confirmation_intents
    SET status = 'failed',
        failed_at = now(),
        error_message = p_error_message,
        updated_at = now()
    WHERE id = p_intent_id;
  ELSIF p_outcome = 'indeterminate' THEN
    UPDATE public.booking_confirmation_intents
    SET status = 'indeterminate',
        error_message = COALESCE(p_error_message, 'crash after dispatch'),
        updated_at = now()
    WHERE id = p_intent_id;
  END IF;

  RETURN jsonb_build_object('recorded', true);
END;
$$;

REVOKE ALL ON FUNCTION public.record_booking_confirmation_outcome(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_booking_confirmation_outcome(UUID, UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.record_booking_confirmation_outcome(UUID, UUID, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_booking_confirmation_outcome(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. expire_stale_booking_confirmations RPC (for cron recovery)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.expire_stale_booking_confirmations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.booking_confirmation_intents
  SET status = 'pending',
      claim_token = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE status = 'claiming'
    AND lease_expires_at < now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_booking_confirmations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_booking_confirmations() FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_booking_confirmations() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_booking_confirmations() TO service_role;
