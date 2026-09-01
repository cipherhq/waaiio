-- 360: Editable order tracking with durable notification intent
-- Issue #247 Phase 1
--
-- Adds: tracking_revision column, order_tracking_notifications table,
--        update_order_tracking RPC (atomic mutation + audit + notification intent),
--        claim/dispatch/outcome RPCs for notification lifecycle.

-- ─────────────────────────────────────────────────────────────
-- 1. Add tracking_revision to orders
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS tracking_revision INTEGER NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────
-- 2. order_tracking_notifications table
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_tracking_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id),
  business_id UUID NOT NULL REFERENCES public.businesses(id),
  revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claiming','dispatched','sent','failed','indeterminate')),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  provider_message_id TEXT,
  sent_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(order_id, revision)
);

ALTER TABLE public.order_tracking_notifications ENABLE ROW LEVEL SECURITY;

-- RLS: service_role only (notifications managed exclusively by backend)
CREATE POLICY "otn_service_all" ON public.order_tracking_notifications
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_otn_order_revision
  ON public.order_tracking_notifications(order_id, revision);
CREATE INDEX IF NOT EXISTS idx_otn_business_status
  ON public.order_tracking_notifications(business_id, status);

-- ─────────────────────────────────────────────────────────────
-- 3. RPC: update_order_tracking  (SECURITY DEFINER)
--    Atomically: lock order, verify tenant, reject invalid status,
--    detect no-op, increment revision, update tracking fields,
--    write audit log, create notification intent.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_order_tracking(
  p_order_id UUID,
  p_business_id UUID,
  p_user_id UUID,
  p_carrier TEXT,
  p_tracking_number TEXT,
  p_notify_customer BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order RECORD;
  v_old_carrier TEXT;
  v_old_tracking TEXT;
  v_new_revision INTEGER;
  v_notification_id UUID;
  v_pending_notification_id UUID;
BEGIN
  -- Lock order row for atomic mutation
  SELECT id, business_id, status, shipping_carrier, tracking_number,
         tracking_revision, shipped_at
    INTO v_order
    FROM public.orders
   WHERE id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
  END IF;

  -- Tenant isolation
  IF v_order.business_id != p_business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'access_denied');
  END IF;

  -- Reject invalid statuses
  IF v_order.status::text IN ('draft', 'cancelled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_order_status',
                              'detail', 'Cannot update tracking for ' || v_order.status::text || ' orders');
  END IF;

  v_old_carrier := v_order.shipping_carrier;
  v_old_tracking := v_order.tracking_number;

  -- Detect no-op (carrier + tracking unchanged)
  IF COALESCE(v_old_carrier, '') = COALESCE(p_carrier, '')
     AND COALESCE(v_old_tracking, '') = COALESCE(p_tracking_number, '') THEN

    -- No-op, but check if there's a pending notification for current revision
    -- that should be surfaced when p_notify_customer is true
    IF p_notify_customer THEN
      SELECT id INTO v_pending_notification_id
        FROM public.order_tracking_notifications
       WHERE order_id = p_order_id
         AND revision = v_order.tracking_revision
         AND status = 'pending'
       LIMIT 1;

      IF v_pending_notification_id IS NOT NULL THEN
        RETURN jsonb_build_object(
          'success', true,
          'no_op', true,
          'pending_notification', true,
          'notification_id', v_pending_notification_id,
          'revision', v_order.tracking_revision
        );
      END IF;
    END IF;

    RETURN jsonb_build_object('success', true, 'no_op', true, 'revision', v_order.tracking_revision);
  END IF;

  -- Material change: increment revision
  v_new_revision := v_order.tracking_revision + 1;

  -- Update order: tracking fields + revision + status → 'shipped' if not already
  UPDATE public.orders
     SET shipping_carrier   = p_carrier,
         tracking_number    = p_tracking_number,
         tracking_revision  = v_new_revision,
         status             = CASE WHEN status::text NOT IN ('shipped', 'delivered')
                              THEN 'shipped'::public.order_status
                              ELSE status END,
         shipped_at         = CASE WHEN shipped_at IS NULL THEN now()
                              ELSE shipped_at END,
         updated_at         = now()
   WHERE id = p_order_id;

  -- Audit log entry
  INSERT INTO public.audit_log (business_id, user_id, action, entity_type, entity_id, changes)
  VALUES (
    p_business_id,
    p_user_id,
    'tracking_updated',
    'order',
    p_order_id::text,
    jsonb_build_object(
      'old', jsonb_build_object('carrier', v_old_carrier, 'tracking_number', v_old_tracking),
      'new', jsonb_build_object('carrier', p_carrier, 'tracking_number', p_tracking_number),
      'revision', v_new_revision
    )
  );

  -- If notify_customer requested, create notification intent
  IF p_notify_customer THEN
    INSERT INTO public.order_tracking_notifications (order_id, business_id, revision, status)
    VALUES (p_order_id, p_business_id, v_new_revision, 'pending')
    RETURNING id INTO v_notification_id;

    RETURN jsonb_build_object(
      'success', true,
      'no_op', false,
      'revision', v_new_revision,
      'notification_id', v_notification_id,
      'shipped_at', COALESCE(v_order.shipped_at, now())
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'no_op', false,
    'revision', v_new_revision,
    'shipped_at', COALESCE(v_order.shipped_at, now())
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- 4. RPC: claim_tracking_notification  (SECURITY DEFINER)
--    Acquires a 2-minute lease on a pending notification.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_tracking_notification(
  p_notification_id UUID,
  p_business_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_notif RECORD;
  v_claim_token UUID;
BEGIN
  SELECT id, business_id, status, lease_expires_at
    INTO v_notif
    FROM public.order_tracking_notifications
   WHERE id = p_notification_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'notification_not_found');
  END IF;

  -- Tenant isolation
  IF v_notif.business_id != p_business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'access_denied');
  END IF;

  -- Must be pending, or claiming with expired lease
  IF v_notif.status = 'pending'
     OR (v_notif.status = 'claiming' AND v_notif.lease_expires_at < now()) THEN
    v_claim_token := gen_random_uuid();

    UPDATE public.order_tracking_notifications
       SET status = 'claiming',
           claim_token = v_claim_token,
           claimed_at = now(),
           lease_expires_at = now() + interval '2 minutes',
           updated_at = now()
     WHERE id = p_notification_id;

    RETURN jsonb_build_object(
      'success', true,
      'claim_token', v_claim_token
    );
  END IF;

  -- Already claimed or terminal state
  RETURN jsonb_build_object(
    'success', false,
    'error', 'not_claimable',
    'current_status', v_notif.status
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- 5. RPC: mark_tracking_notification_dispatched  (SECURITY DEFINER)
--    Sets the dispatch barrier: after this, no blind resend.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_tracking_notification_dispatched(
  p_notification_id UUID,
  p_claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_notif RECORD;
BEGIN
  SELECT id, claim_token, status
    INTO v_notif
    FROM public.order_tracking_notifications
   WHERE id = p_notification_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'notification_not_found');
  END IF;

  IF v_notif.claim_token != p_claim_token THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_claim_token');
  END IF;

  IF v_notif.status != 'claiming' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status',
                              'current_status', v_notif.status);
  END IF;

  UPDATE public.order_tracking_notifications
     SET status = 'dispatched',
         dispatched_at = now(),
         updated_at = now()
   WHERE id = p_notification_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- 6. RPC: record_tracking_notification_outcome  (SECURITY DEFINER)
--    Records the final state: sent, failed, or indeterminate.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_tracking_notification_outcome(
  p_notification_id UUID,
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
  v_notif RECORD;
BEGIN
  -- Validate outcome
  IF p_outcome NOT IN ('sent', 'failed', 'indeterminate') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_outcome');
  END IF;

  SELECT id, claim_token, status
    INTO v_notif
    FROM public.order_tracking_notifications
   WHERE id = p_notification_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'notification_not_found');
  END IF;

  IF v_notif.claim_token != p_claim_token THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_claim_token');
  END IF;

  IF v_notif.status != 'dispatched' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status',
                              'current_status', v_notif.status);
  END IF;

  UPDATE public.order_tracking_notifications
     SET status = p_outcome,
         provider_message_id = COALESCE(p_provider_message_id, provider_message_id),
         sent_at = CASE WHEN p_outcome = 'sent' THEN now() ELSE sent_at END,
         failed_at = CASE WHEN p_outcome = 'failed' THEN now() ELSE failed_at END,
         error_message = COALESCE(p_error_message, error_message),
         updated_at = now()
   WHERE id = p_notification_id;

  RETURN jsonb_build_object('success', true, 'outcome', p_outcome);
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- 7. Permissions: service_role only for all RPCs
-- ─────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.update_order_tracking(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_tracking(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN) TO service_role;

REVOKE ALL ON FUNCTION public.claim_tracking_notification(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tracking_notification(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.mark_tracking_notification_dispatched(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_tracking_notification_dispatched(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.record_tracking_notification_outcome(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_tracking_notification_outcome(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
