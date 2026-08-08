-- Migration 310: Payment-level idempotency for financial operations
--
-- Fixes:
--   1. Invoice payment double-increment on retries/concurrent processing
--   2. Campaign donation double-counting when processSuccessfulPayment called twice
--   3. Platform fee entity-level UNIQUE blocking legitimate second payments
--   4. Platform fee missing payment_id for traceability
--
-- Core invariant: ONE successful payment → EXACTLY ONE financial effect.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Invoice payment applications ledger
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS invoice_payment_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  amount_applied numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(invoice_id, payment_id)
);

ALTER TABLE invoice_payment_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_invoice_payment_applications"
  ON invoice_payment_applications FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Atomic invoice payment application RPC
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_invoice_payment(
  p_invoice_id uuid,
  p_payment_id uuid,
  p_payment_amount numeric,
  p_business_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_invoice record;
  v_inserted boolean;
  v_new_amount_paid numeric;
  v_is_fully_paid boolean;
BEGIN
  -- Lock invoice row to serialize concurrent applications
  SELECT total_amount, amount_paid, status, business_id
  INTO v_invoice
  FROM invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'invoice_not_found');
  END IF;

  -- Validate business ownership
  IF v_invoice.business_id != p_business_id THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'business_mismatch');
  END IF;

  -- Idempotent insert: if this payment was already applied, do nothing
  INSERT INTO invoice_payment_applications (invoice_id, payment_id, amount_applied)
  VALUES (p_invoice_id, p_payment_id, p_payment_amount)
  ON CONFLICT (invoice_id, payment_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    -- Already applied — return idempotent result
    RETURN jsonb_build_object('applied', false, 'already_applied', true);
  END IF;

  -- Calculate authoritative amount_paid from the ledger (not read-modify-write)
  SELECT COALESCE(SUM(amount_applied), 0) INTO v_new_amount_paid
  FROM invoice_payment_applications
  WHERE invoice_id = p_invoice_id;

  v_is_fully_paid := v_new_amount_paid >= v_invoice.total_amount;

  -- Update invoice with authoritative totals
  UPDATE invoices
  SET amount_paid = v_new_amount_paid,
      status = CASE WHEN v_is_fully_paid THEN 'paid' ELSE status END,
      paid_at = CASE WHEN v_is_fully_paid AND paid_at IS NULL THEN now() ELSE paid_at END,
      updated_at = now()
  WHERE id = p_invoice_id;

  RETURN jsonb_build_object(
    'applied', true,
    'amount_applied', p_payment_amount,
    'new_amount_paid', v_new_amount_paid,
    'is_fully_paid', v_is_fully_paid
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Atomic campaign donation application RPC
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_campaign_donation(
  p_campaign_id uuid,
  p_payment_id uuid,
  p_amount numeric
) RETURNS jsonb AS $$
DECLARE
  v_rows_updated integer;
BEGIN
  -- Atomically transition donation from pending → success
  -- This is the idempotency gate: only one caller can transition
  UPDATE campaign_donations
  SET status = 'success'
  WHERE payment_id = p_payment_id
    AND campaign_id = p_campaign_id
    AND status = 'pending';

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

  IF v_rows_updated = 0 THEN
    -- Try fallback: donation created without payment_id
    UPDATE campaign_donations
    SET status = 'success', payment_id = p_payment_id
    WHERE campaign_id = p_campaign_id
      AND status = 'pending'
      AND payment_id IS NULL
    LIMIT 1;

    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  END IF;

  IF v_rows_updated = 0 THEN
    -- Already processed or not found
    RETURN jsonb_build_object('applied', false, 'already_applied', true);
  END IF;

  -- Only increment campaign stats if we actually transitioned a donation
  UPDATE campaigns
  SET raised_amount = raised_amount + p_amount,
      donor_count = donor_count + 1
  WHERE id = p_campaign_id;

  RETURN jsonb_build_object('applied', true, 'amount', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Add payment_id to platform_fees for payment-level traceability
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE platform_fees ADD COLUMN IF NOT EXISTS payment_id uuid REFERENCES payments(id);

-- Payment-level unique index: one fee per payment (regardless of entity type)
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_fees_payment_unique
  ON platform_fees(payment_id)
  WHERE payment_id IS NOT NULL AND refunded_at IS NULL;

-- Drop entity-level unique indexes that block legitimate second payments
-- (invoices can have multiple partial payments, campaigns can have many donations)
DROP INDEX IF EXISTS idx_platform_fees_invoice_unique;
DROP INDEX IF EXISTS idx_platform_fees_campaign_unique;

-- Keep entity-level indexes for single-payment entities (booking, order, reservation)
-- These are harmless alongside the payment-level index and provide backward safety.

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Grant execute on new RPCs to service_role
-- ═══════════════════════════════════════════════════════════════════════

GRANT EXECUTE ON FUNCTION apply_invoice_payment(uuid, uuid, numeric, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION apply_campaign_donation(uuid, uuid, numeric) TO service_role;
