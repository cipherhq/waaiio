-- ============================================================================
-- Migration 355: Refund Domain Production Convergence (#232)
--
-- Restores the canonical refund execution ledger and payment refund columns
-- that production lacks despite migration 034 being recorded in history.
-- Uses hardened RLS (is_admin, service_role writes) per AUTH-001.
--
-- This migration MUST apply before 356 (Customer360/financial projection)
-- which depends on public.refunds for net-settlement revenue calculation.
--
-- State model: pending -> dispatching -> provider_ambiguous
--                                     -> provider_success_unfinalized -> success
--                                     -> failed
-- ============================================================================

-- 1. Payment refund columns (idempotent — IF NOT EXISTS / safe for re-run)

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12,2) DEFAULT 0;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refund_reason TEXT;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refunded_by UUID;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;


-- 2. Refund execution ledger

CREATE TABLE IF NOT EXISTS public.refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'provider_ambiguous', 'provider_success_unfinalized', 'success', 'failed')),
  gateway TEXT,
  gateway_refund_reference TEXT,
  gateway_response JSONB,
  refund_type TEXT NOT NULL DEFAULT 'full'
    CHECK (refund_type IN ('full', 'partial')),
  is_direct_split BOOLEAN NOT NULL DEFAULT FALSE,
  initiated_by UUID,
  initiated_by_role TEXT NOT NULL DEFAULT 'business'
    CHECK (initiated_by_role IN ('business', 'admin')),
  dispatched_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON public.refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_business_id ON public.refunds(business_id);

-- Non-terminal execution serialization: at most one active refund per payment
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_active_execution
  ON public.refunds(payment_id)
  WHERE status IN ('pending', 'provider_ambiguous', 'provider_success_unfinalized');


-- 3. RLS — hardened per AUTH-001 (is_admin, not profiles.role)

ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;

-- Business owners: SELECT only their own refund records
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'refunds' AND policyname = 'refunds_owner_select') THEN
    CREATE POLICY "refunds_owner_select" ON public.refunds FOR SELECT USING (
      business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
    );
  END IF;
END $$;

-- Admin: full read access via is_admin()
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'refunds' AND policyname = 'refunds_admin_select') THEN
    CREATE POLICY "refunds_admin_select" ON public.refunds FOR SELECT USING (
      public.is_admin()
    );
  END IF;
END $$;

-- Service role: full access (trusted execution path)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'refunds' AND policyname = 'refunds_service_all') THEN
    CREATE POLICY "refunds_service_all" ON public.refunds FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Grants: authenticated can only SELECT; service_role can do everything
REVOKE ALL ON TABLE public.refunds FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.refunds TO authenticated;
GRANT ALL ON TABLE public.refunds TO service_role;


-- 4. Atomic dispatch claim RPC
-- Atomically claims a pending+undispatched refund for provider dispatch.
-- Returns the refund row if claimed, NULL if already claimed/dispatched.

CREATE OR REPLACE FUNCTION public.claim_refund_dispatch(p_refund_id UUID)
RETURNS TABLE (
  claimed BOOLEAN,
  refund_id UUID,
  payment_id UUID,
  amount NUMERIC,
  gateway TEXT,
  gateway_reference TEXT,
  refund_type TEXT,
  is_direct_split BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_refund RECORD;
BEGIN
  -- Atomic conditional update: claim only if pending + undispatched
  UPDATE public.refunds r
  SET dispatched_at = now()
  WHERE r.id = p_refund_id
    AND r.status = 'pending'
    AND r.dispatched_at IS NULL
  RETURNING r.id, r.payment_id, r.amount, r.gateway, r.refund_type, r.is_direct_split
  INTO v_refund;

  IF NOT FOUND THEN
    claimed := false;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Load the gateway reference from the payment
  claimed := true;
  refund_id := v_refund.id;
  payment_id := v_refund.payment_id;
  amount := v_refund.amount;
  gateway := v_refund.gateway;
  refund_type := v_refund.refund_type;
  is_direct_split := v_refund.is_direct_split;

  SELECT p.gateway_reference INTO gateway_reference
  FROM public.payments p WHERE p.id = v_refund.payment_id;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_refund_dispatch(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_refund_dispatch(UUID) TO service_role;


-- 5. Exactly-once finalization RPC
-- Atomically finalizes a provider-successful refund: updates payment aggregate,
-- booking/reservation deposit, platform fee, and transitions refund to 'success'.
-- Replay after success = no-op. Concurrent callers serialize on row lock.

CREATE OR REPLACE FUNCTION public.finalize_refund_execution(p_refund_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_refund RECORD;
  v_payment RECORD;
  v_new_refund_amount NUMERIC;
  v_is_fully_refunded BOOLEAN;
  v_fee_entity_col TEXT;
  v_fee_entity_val UUID;
  v_fee RECORD;
  v_refund_ratio NUMERIC;
  v_fee_reduction NUMERIC;
BEGIN
  -- Lock and load the refund row
  SELECT r.* INTO v_refund
  FROM public.refunds r
  WHERE r.id = p_refund_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'refund_not_found');
  END IF;

  -- Already finalized = no-op
  IF v_refund.status = 'success' THEN
    RETURN jsonb_build_object('finalized', true, 'reason', 'already_finalized');
  END IF;

  -- Only provider_success_unfinalized can be finalized
  IF v_refund.status != 'provider_success_unfinalized' THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'invalid_state', 'current_status', v_refund.status);
  END IF;

  -- Load the payment
  SELECT p.* INTO v_payment
  FROM public.payments p
  WHERE p.id = v_refund.payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'payment_not_found');
  END IF;

  -- Calculate new refund aggregate
  v_new_refund_amount := COALESCE(v_payment.refund_amount, 0) + v_refund.amount;
  v_is_fully_refunded := v_new_refund_amount >= v_payment.amount;

  -- Update payment aggregate
  UPDATE public.payments
  SET refund_amount = v_new_refund_amount,
      refund_reason = v_refund.reason,
      refunded_at = now(),
      refunded_by = v_refund.initiated_by,
      status = CASE WHEN v_is_fully_refunded THEN 'refunded'::public.payment_status ELSE status END
  WHERE id = v_refund.payment_id;

  -- Update booking deposit status if fully refunded
  IF v_is_fully_refunded AND v_payment.booking_id IS NOT NULL THEN
    UPDATE public.bookings SET deposit_status = 'refunded' WHERE id = v_payment.booking_id;
  END IF;

  -- Update reservation deposit status if fully refunded
  IF v_is_fully_refunded AND v_payment.reservation_id IS NOT NULL THEN
    UPDATE public.reservations SET deposit_status = 'refunded' WHERE id = v_payment.reservation_id;
  END IF;

  -- Reverse platform fee
  IF v_payment.booking_id IS NOT NULL THEN
    v_fee_entity_col := 'booking_id'; v_fee_entity_val := v_payment.booking_id;
  ELSIF v_payment.invoice_id IS NOT NULL THEN
    v_fee_entity_col := 'invoice_id'; v_fee_entity_val := v_payment.invoice_id;
  ELSIF v_payment.order_id IS NOT NULL THEN
    v_fee_entity_col := 'order_id'; v_fee_entity_val := v_payment.order_id;
  END IF;

  IF v_fee_entity_col IS NOT NULL AND v_fee_entity_val IS NOT NULL THEN
    IF v_is_fully_refunded THEN
      -- Full refund: mark fee as refunded
      EXECUTE format(
        'UPDATE public.platform_fees SET refunded_at = now() WHERE %I = $1 AND refunded_at IS NULL',
        v_fee_entity_col
      ) USING v_fee_entity_val;
    ELSE
      -- Partial refund: reduce fee proportionally
      EXECUTE format(
        'SELECT id, fee_total, transaction_amount FROM public.platform_fees WHERE %I = $1 AND refunded_at IS NULL LIMIT 1',
        v_fee_entity_col
      ) INTO v_fee USING v_fee_entity_val;

      IF v_fee IS NOT NULL AND v_fee.transaction_amount > 0 THEN
        v_refund_ratio := v_refund.amount / v_fee.transaction_amount;
        v_fee_reduction := ROUND(v_fee.fee_total * v_refund_ratio * 100) / 100;
        UPDATE public.platform_fees
        SET fee_total = GREATEST(0, fee_total - v_fee_reduction)
        WHERE id = v_fee.id;
      END IF;
    END IF;
  END IF;

  -- Create payout adjustment if payout already sent
  BEGIN
    DECLARE v_paid_payout RECORD;
    BEGIN
      SELECT bp.id INTO v_paid_payout
      FROM public.business_payouts bp
      WHERE bp.business_id = v_refund.business_id
        AND bp.status = 'paid'
        AND bp.period_end >= v_payment.created_at
      LIMIT 1;

      IF FOUND THEN
        INSERT INTO public.payout_adjustments (business_id, payout_id, amount, reason, payment_id)
        VALUES (v_refund.business_id, v_paid_payout.id, -v_refund.amount,
                'Refund for payment ' || v_payment.gateway_reference, v_refund.payment_id);
      END IF;
    END;
  EXCEPTION WHEN OTHERS THEN
    -- Non-blocking: payout adjustment is best-effort
    NULL;
  END;

  -- Terminal transition
  UPDATE public.refunds
  SET status = 'success', finalized_at = now()
  WHERE id = p_refund_id;

  RETURN jsonb_build_object('finalized', true, 'fully_refunded', v_is_fully_refunded);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_refund_execution(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_refund_execution(UUID) TO service_role;


-- 6. Harden refund_requests admin policy to use is_admin()

DO $$ BEGIN
  DROP POLICY IF EXISTS "admin_all_refund_requests" ON public.refund_requests;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'refund_requests' AND policyname = 'refund_requests_admin_all') THEN
    CREATE POLICY "refund_requests_admin_all" ON public.refund_requests FOR ALL USING (
      public.is_admin()
    );
  END IF;
END $$;
