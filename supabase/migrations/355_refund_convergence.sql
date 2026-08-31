-- ============================================================================
-- Migration 355: Refund Domain Production Convergence (#232)
--
-- 6-state model: pending → provider_pending | provider_ambiguous
--                         → provider_success_unfinalized → success
--                         → failed
--
-- Non-terminal states: pending, provider_pending, provider_ambiguous,
--                      provider_success_unfinalized
-- Terminal states: success, failed
-- ============================================================================

-- 1. Payment refund columns (idempotent)

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS refund_reason TEXT;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS refunded_by UUID;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

-- 2. Refund execution ledger

CREATE TABLE IF NOT EXISTS public.refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  gateway TEXT,
  gateway_refund_reference TEXT,
  gateway_response JSONB,
  refund_type TEXT NOT NULL DEFAULT 'full',
  is_direct_split BOOLEAN NOT NULL DEFAULT FALSE,
  initiated_by UUID,
  initiated_by_role TEXT NOT NULL DEFAULT 'business',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Convergence columns (new in 355, safe for existing tables from 034)
ALTER TABLE public.refunds ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE public.refunds ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;
ALTER TABLE public.refunds ADD COLUMN IF NOT EXISTS provider_refund_id TEXT;
ALTER TABLE public.refunds ADD COLUMN IF NOT EXISTS provider_status TEXT;
ALTER TABLE public.refunds ADD COLUMN IF NOT EXISTS recovery_token UUID;
ALTER TABLE public.refunds ADD COLUMN IF NOT EXISTS recovery_claimed_at TIMESTAMPTZ;
ALTER TABLE public.refunds ADD COLUMN IF NOT EXISTS connect_account_id TEXT;
ALTER TABLE public.refunds ADD COLUMN IF NOT EXISTS provider_connection_id TEXT;

-- Update status CHECK for 6-state model
DO $$ BEGIN ALTER TABLE public.refunds DROP CONSTRAINT IF EXISTS refunds_status_check; EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE public.refunds ADD CONSTRAINT refunds_status_check
  CHECK (status IN ('pending', 'provider_pending', 'provider_ambiguous', 'provider_success_unfinalized', 'success', 'failed'));

DO $$ BEGIN ALTER TABLE public.refunds DROP CONSTRAINT IF EXISTS refunds_refund_type_check; EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE public.refunds ADD CONSTRAINT refunds_refund_type_check CHECK (refund_type IN ('full', 'partial'));

DO $$ BEGIN ALTER TABLE public.refunds DROP CONSTRAINT IF EXISTS refunds_initiated_by_role_check; EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE public.refunds ADD CONSTRAINT refunds_initiated_by_role_check CHECK (initiated_by_role IN ('business', 'admin'));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON public.refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_business_id ON public.refunds(business_id);

-- Non-terminal serialization: one active refund per payment
DROP INDEX IF EXISTS idx_refunds_active_execution;
CREATE UNIQUE INDEX idx_refunds_active_execution
  ON public.refunds(payment_id)
  WHERE status IN ('pending', 'provider_pending', 'provider_ambiguous', 'provider_success_unfinalized');

-- 3. RLS — hardened per AUTH-001

ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;

-- Drop legacy 034 policies
DO $$ BEGIN DROP POLICY IF EXISTS "Business owners see own refunds" ON public.refunds; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "Business owners insert own refunds" ON public.refunds; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "Business owners update own refunds" ON public.refunds; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "Admins see all refunds" ON public.refunds; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "Admins insert any refund" ON public.refunds; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "Admins update any refund" ON public.refunds; EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'refunds' AND policyname = 'refunds_owner_select') THEN
    CREATE POLICY "refunds_owner_select" ON public.refunds FOR SELECT USING (
      business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'refunds' AND policyname = 'refunds_admin_select') THEN
    CREATE POLICY "refunds_admin_select" ON public.refunds FOR SELECT USING (public.is_admin());
  END IF;
END $$;

REVOKE ALL ON TABLE public.refunds FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.refunds TO authenticated;
GRANT ALL ON TABLE public.refunds TO service_role;

-- 4. Atomic dispatch claim RPC

CREATE OR REPLACE FUNCTION public.claim_refund_dispatch(p_refund_id UUID, p_recovery_token UUID DEFAULT NULL)
RETURNS TABLE (claimed BOOLEAN, refund_id UUID, payment_id UUID, amount NUMERIC, gateway TEXT, gateway_reference TEXT, refund_type TEXT, is_direct_split BOOLEAN, connect_account_id TEXT, provider_connection_id TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_refund RECORD;
BEGIN
  IF p_recovery_token IS NOT NULL THEN
    -- Token-bound claim: only the holder of the active recovery token can dispatch
    UPDATE public.refunds r
    SET dispatched_at = now(), recovery_token = NULL, recovery_claimed_at = NULL
    WHERE r.id = p_refund_id AND r.status = 'pending' AND r.recovery_token = p_recovery_token
    RETURNING r.id, r.payment_id, r.amount, r.gateway, r.refund_type, r.is_direct_split, r.connect_account_id, r.provider_connection_id
    INTO v_refund;
  ELSE
    -- Normal claim: pending + never dispatched
    UPDATE public.refunds r
    SET dispatched_at = now()
    WHERE r.id = p_refund_id AND r.status = 'pending' AND r.dispatched_at IS NULL AND r.recovery_token IS NULL
    RETURNING r.id, r.payment_id, r.amount, r.gateway, r.refund_type, r.is_direct_split, r.connect_account_id, r.provider_connection_id
    INTO v_refund;
  END IF;

  IF NOT FOUND THEN
    claimed := false; RETURN NEXT; RETURN;
  END IF;

  claimed := true;
  refund_id := v_refund.id; payment_id := v_refund.payment_id; amount := v_refund.amount;
  gateway := v_refund.gateway; refund_type := v_refund.refund_type; is_direct_split := v_refund.is_direct_split;
  connect_account_id := v_refund.connect_account_id; provider_connection_id := v_refund.provider_connection_id;

  SELECT p.gateway_reference INTO gateway_reference FROM public.payments p WHERE p.id = v_refund.payment_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_refund_dispatch(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_refund_dispatch(UUID, UUID) TO service_role;

-- 5. Token-bound interrupted-dispatch recovery RPC

CREATE OR REPLACE FUNCTION public.recover_interrupted_dispatch(p_refund_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_refund RECORD; v_token UUID;
BEGIN
  SELECT r.* INTO v_refund FROM public.refunds r WHERE r.id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('recovered', false, 'reason', 'refund_not_found'); END IF;

  -- Only pending + dispatched (interrupted) can be recovered
  IF v_refund.status != 'pending' OR v_refund.dispatched_at IS NULL THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'not_interrupted', 'status', v_refund.status);
  END IF;

  -- Tier-1 only (proven idempotent replay)
  IF v_refund.gateway IS NULL OR v_refund.gateway NOT IN ('stripe', 'paypal') THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'gateway_not_replay_safe', 'gateway', v_refund.gateway);
  END IF;

  -- Provider-specific replay window
  IF v_refund.dispatched_at < now() - INTERVAL '23 hours' THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'replay_window_expired');
  END IF;

  -- Check for stale lease from prior recovery attempt
  IF v_refund.recovery_token IS NOT NULL THEN
    IF v_refund.recovery_claimed_at IS NOT NULL AND v_refund.recovery_claimed_at > now() - INTERVAL '5 minutes' THEN
      RETURN jsonb_build_object('recovered', false, 'reason', 'recovery_lease_active');
    END IF;
    -- Stale lease — clear it
  END IF;

  -- Acquire recovery lease (single-winner via FOR UPDATE + atomic token set)
  v_token := gen_random_uuid();
  UPDATE public.refunds SET recovery_token = v_token, recovery_claimed_at = now() WHERE id = p_refund_id;

  RETURN jsonb_build_object('recovered', true, 'recovery_token', v_token, 'refund_id', p_refund_id);
END;
$$;

REVOKE ALL ON FUNCTION public.recover_interrupted_dispatch(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_interrupted_dispatch(UUID) TO service_role;

-- 6. Ambiguous refund recovery (Tier-1 only, provider_ambiguous state)

CREATE OR REPLACE FUNCTION public.recover_ambiguous_refund(p_refund_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_refund RECORD; v_token UUID;
BEGIN
  SELECT r.* INTO v_refund FROM public.refunds r WHERE r.id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('recovered', false, 'reason', 'refund_not_found'); END IF;

  IF v_refund.status != 'provider_ambiguous' THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'not_ambiguous', 'current_status', v_refund.status);
  END IF;

  IF v_refund.gateway IS NULL OR v_refund.gateway NOT IN ('stripe', 'paypal') THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'gateway_not_replay_safe', 'gateway', v_refund.gateway);
  END IF;

  IF v_refund.dispatched_at IS NULL OR v_refund.dispatched_at < now() - INTERVAL '23 hours' THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'replay_window_expired');
  END IF;

  -- Reset to pending + acquire recovery lease for token-bound re-dispatch.
  -- PRESERVE dispatched_at so that if a crash occurs between this commit and
  -- the subsequent claim, the row enters the 'pending + dispatched_at IS NOT NULL'
  -- state which recover_interrupted_dispatch() can reclaim.
  v_token := gen_random_uuid();
  UPDATE public.refunds
  SET status = 'pending', recovery_token = v_token, recovery_claimed_at = now()
  WHERE id = p_refund_id;

  RETURN jsonb_build_object('recovered', true, 'recovery_token', v_token, 'refund_id', p_refund_id);
END;
$$;

REVOKE ALL ON FUNCTION public.recover_ambiguous_refund(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_ambiguous_refund(UUID) TO service_role;

-- 7. Exactly-once finalization RPC

CREATE OR REPLACE FUNCTION public.finalize_refund_execution(p_refund_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_refund RECORD; v_payment RECORD;
  v_new_refund_amount NUMERIC; v_is_fully_refunded BOOLEAN;
  v_fee_entity_col TEXT; v_fee_entity_val UUID;
  v_fee RECORD; v_fee_reduction NUMERIC;
  v_paid_payout RECORD;
BEGIN
  SELECT r.* INTO v_refund FROM public.refunds r WHERE r.id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('finalized', false, 'reason', 'refund_not_found'); END IF;
  IF v_refund.status = 'success' THEN RETURN jsonb_build_object('finalized', true, 'reason', 'already_finalized'); END IF;
  IF v_refund.status != 'provider_success_unfinalized' THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'invalid_state', 'current_status', v_refund.status);
  END IF;

  SELECT p.* INTO v_payment FROM public.payments p WHERE p.id = v_refund.payment_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('finalized', false, 'reason', 'payment_not_found'); END IF;

  v_new_refund_amount := COALESCE(v_payment.refund_amount, 0) + v_refund.amount;
  v_is_fully_refunded := v_new_refund_amount >= v_payment.amount;

  UPDATE public.payments
  SET refund_amount = v_new_refund_amount, refund_reason = v_refund.reason,
      refunded_at = now(), refunded_by = v_refund.initiated_by,
      status = CASE WHEN v_is_fully_refunded THEN 'refunded'::public.payment_status ELSE status END
  WHERE id = v_refund.payment_id;

  IF v_is_fully_refunded AND v_payment.booking_id IS NOT NULL THEN
    UPDATE public.bookings SET deposit_status = 'refunded' WHERE id = v_payment.booking_id;
  END IF;
  IF v_is_fully_refunded AND v_payment.reservation_id IS NOT NULL THEN
    UPDATE public.reservations SET deposit_status = 'refunded' WHERE id = v_payment.reservation_id;
  END IF;

  -- Platform fee reversal
  IF v_payment.booking_id IS NOT NULL THEN v_fee_entity_col := 'booking_id'; v_fee_entity_val := v_payment.booking_id;
  ELSIF v_payment.invoice_id IS NOT NULL THEN v_fee_entity_col := 'invoice_id'; v_fee_entity_val := v_payment.invoice_id;
  ELSIF v_payment.order_id IS NOT NULL THEN v_fee_entity_col := 'order_id'; v_fee_entity_val := v_payment.order_id;
  END IF;

  IF v_fee_entity_col IS NOT NULL AND v_fee_entity_val IS NOT NULL THEN
    IF v_is_fully_refunded THEN
      EXECUTE format('UPDATE public.platform_fees SET fee_total = 0, refunded_at = now() WHERE %I = $1 AND refunded_at IS NULL', v_fee_entity_col) USING v_fee_entity_val;
    ELSE
      EXECUTE format('SELECT id, fee_total, fee_percentage, fee_flat, transaction_amount FROM public.platform_fees WHERE %I = $1 AND refunded_at IS NULL LIMIT 1', v_fee_entity_col) INTO v_fee USING v_fee_entity_val;
      IF v_fee IS NOT NULL AND v_fee.transaction_amount > 0 THEN
        v_fee_reduction := ROUND((v_fee.fee_percentage / 100.0 * v_refund.amount) + (v_fee.fee_flat::NUMERIC * v_refund.amount / v_fee.transaction_amount));
        UPDATE public.platform_fees SET fee_total = GREATEST(0, fee_total - v_fee_reduction) WHERE id = v_fee.id;
      END IF;
    END IF;
  END IF;

  -- Payout adjustment (atomic — no swallowed exceptions)
  SELECT bp.id INTO v_paid_payout FROM public.business_payouts bp
  WHERE bp.business_id = v_refund.business_id AND bp.status = 'paid' AND bp.period_end >= v_payment.created_at LIMIT 1;
  IF FOUND THEN
    INSERT INTO public.payout_adjustments (business_id, payout_id, amount, reason, payment_id)
    VALUES (v_refund.business_id, v_paid_payout.id, -v_refund.amount, 'Refund for payment ' || v_payment.gateway_reference, v_refund.payment_id);
  END IF;

  UPDATE public.refunds SET status = 'success', finalized_at = now() WHERE id = p_refund_id;
  RETURN jsonb_build_object('finalized', true, 'fully_refunded', v_is_fully_refunded);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_refund_execution(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_refund_execution(UUID) TO service_role;

-- 8. Reconcile pending refund RPC

CREATE OR REPLACE FUNCTION public.reconcile_pending_refund(p_refund_id UUID, p_provider_status TEXT, p_terminal_outcome TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_refund RECORD;
BEGIN
  SELECT r.* INTO v_refund FROM public.refunds r WHERE r.id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('reconciled', false, 'reason', 'refund_not_found'); END IF;
  IF v_refund.status != 'provider_pending' THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'not_pending', 'current_status', v_refund.status);
  END IF;

  IF p_terminal_outcome NOT IN ('terminal_success', 'terminal_failure') THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'invalid_outcome');
  END IF;

  UPDATE public.refunds SET provider_status = p_provider_status WHERE id = p_refund_id;

  IF p_terminal_outcome = 'terminal_success' THEN
    UPDATE public.refunds SET status = 'provider_success_unfinalized' WHERE id = p_refund_id;
    RETURN jsonb_build_object('reconciled', true, 'next_action', 'finalize');
  ELSE
    UPDATE public.refunds SET status = 'failed' WHERE id = p_refund_id;
    RETURN jsonb_build_object('reconciled', true, 'next_action', 'none');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_pending_refund(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_pending_refund(UUID, TEXT, TEXT) TO service_role;

-- 9. Harden refund_requests admin policy

DO $$ BEGIN DROP POLICY IF EXISTS "admin_all_refund_requests" ON public.refund_requests; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'refund_requests' AND policyname = 'refund_requests_admin_all') THEN
    CREATE POLICY "refund_requests_admin_all" ON public.refund_requests FOR ALL USING (public.is_admin());
  END IF;
END $$;
