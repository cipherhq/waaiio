-- Migration 310: Payment-level idempotency for financial operations
--
-- Fixes:
--   1. Invoice payment double-increment on retries/concurrent processing
--   2. Campaign donation double-counting when processSuccessfulPayment called twice
--   3. Platform fee entity-level UNIQUE blocking legitimate second payments
--   4. Platform fee missing payment_id for traceability
--
-- Core invariant: ONE successful payment → EXACTLY ONE financial effect.
-- RPCs validate payment row from DB — caller-supplied amounts are ignored.

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
-- 2. Legacy baseline: durable pre-migration recognized balance
--
--    legacy_amount_paid_baseline captures any amount_paid that cannot
--    be explained by known successful payment records. Computed once
--    at migration time and never recalculated.
--
--    Post-migration authoritative amount_paid =
--      legacy_amount_paid_baseline + SUM(invoice_payment_applications)
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS
  legacy_amount_paid_baseline numeric(12,2) NOT NULL DEFAULT 0;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Backfill historical successful invoice payments into ledger
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO invoice_payment_applications (invoice_id, payment_id, amount_applied)
SELECT
  p.invoice_id,
  p.id,
  p.amount
FROM payments p
WHERE p.invoice_id IS NOT NULL
  AND p.status = 'success'
  AND NOT EXISTS (
    SELECT 1 FROM invoice_payment_applications ipa
    WHERE ipa.invoice_id = p.invoice_id AND ipa.payment_id = p.id
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Compute legacy baselines per invoice
--
--    baseline = MAX(existing_amount_paid - backfilled_ledger_sum, 0)
--
--    CASE 1: amount_paid=0, backfill=0 → baseline=0
--    CASE 2: amount_paid=500, backfill=500 → baseline=0
--    CASE 3: amount_paid=700, backfill=500 → baseline=200
--    CASE 4: amount_paid=500, backfill=700 → baseline=0 (anomalous but safe)
--    CASE 5: already paid → baseline preserves recognized amount
-- ═══════════════════════════════════════════════════════════════════════

UPDATE invoices i
SET legacy_amount_paid_baseline = GREATEST(
  COALESCE(i.amount_paid, 0) - COALESCE(backfill.ledger_sum, 0),
  0
)
FROM (
  SELECT invoice_id, SUM(amount_applied) AS ledger_sum
  FROM invoice_payment_applications
  GROUP BY invoice_id
) backfill
WHERE i.id = backfill.invoice_id
  AND COALESCE(i.amount_paid, 0) > COALESCE(backfill.ledger_sum, 0);

-- Invoices with NO backfilled payments but existing amount_paid: baseline = amount_paid
UPDATE invoices i
SET legacy_amount_paid_baseline = COALESCE(i.amount_paid, 0)
WHERE COALESCE(i.amount_paid, 0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM invoice_payment_applications ipa WHERE ipa.invoice_id = i.id
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Atomic invoice payment application RPC
--    Validates payment row from DB — does NOT trust caller amounts.
--    Authoritative amount = legacy_baseline + SUM(ledger)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_invoice_payment(
  p_invoice_id uuid,
  p_payment_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_payment record;
  v_invoice record;
  v_amount numeric;
  v_ledger_total numeric;
  v_new_amount_paid numeric;
  v_is_fully_paid boolean;
BEGIN
  -- Load and validate payment from DB (authoritative source of truth)
  SELECT id, amount, invoice_id, status, business_id
  INTO v_payment
  FROM payments
  WHERE id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_found');
  END IF;

  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_successful');
  END IF;

  IF v_payment.invoice_id IS NULL OR v_payment.invoice_id != p_invoice_id THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_invoice_mismatch');
  END IF;

  v_amount := v_payment.amount;
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'invalid_amount');
  END IF;

  -- Lock invoice row to serialize concurrent applications
  SELECT total_amount, amount_paid, status, business_id, legacy_amount_paid_baseline
  INTO v_invoice
  FROM invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'invoice_not_found');
  END IF;

  -- Validate business relationship
  IF v_invoice.business_id != v_payment.business_id THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'business_mismatch');
  END IF;

  -- Idempotent insert: if this payment was already applied, do nothing
  INSERT INTO invoice_payment_applications (invoice_id, payment_id, amount_applied)
  VALUES (p_invoice_id, p_payment_id, v_amount)
  ON CONFLICT (invoice_id, payment_id) DO NOTHING;

  IF NOT FOUND THEN
    -- Already applied — return idempotent result
    RETURN jsonb_build_object('applied', false, 'already_applied', true);
  END IF;

  -- Authoritative amount_paid = legacy_baseline + SUM(all durable applications)
  SELECT COALESCE(SUM(amount_applied), 0) INTO v_ledger_total
  FROM invoice_payment_applications
  WHERE invoice_id = p_invoice_id;

  v_new_amount_paid := COALESCE(v_invoice.legacy_amount_paid_baseline, 0) + v_ledger_total;
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
    'amount_applied', v_amount,
    'new_amount_paid', v_new_amount_paid,
    'is_fully_paid', v_is_fully_paid
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. Atomic campaign donation application RPC
--    Validates payment row from DB including business_id.
--    No arbitrary fallback — payment_id must match a pending donation.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_campaign_donation(
  p_campaign_id uuid,
  p_payment_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_payment record;
  v_campaign record;
  v_amount numeric;
  v_rows_updated integer;
BEGIN
  -- Load and validate payment from DB (authoritative source of truth)
  SELECT id, amount, campaign_id, status, business_id
  INTO v_payment
  FROM payments
  WHERE id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_found');
  END IF;

  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_successful');
  END IF;

  IF v_payment.campaign_id IS NULL OR v_payment.campaign_id != p_campaign_id THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_campaign_mismatch');
  END IF;

  -- Validate business relationship: payment business must match campaign business
  SELECT id, business_id INTO v_campaign
  FROM campaigns WHERE id = p_campaign_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'campaign_not_found');
  END IF;

  IF v_campaign.business_id != v_payment.business_id THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'business_mismatch');
  END IF;

  v_amount := v_payment.amount;

  -- Atomically transition donation from pending → success
  -- This is the idempotency gate: only one caller can transition
  UPDATE campaign_donations
  SET status = 'success'
  WHERE payment_id = p_payment_id
    AND campaign_id = p_campaign_id
    AND status = 'pending';

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

  IF v_rows_updated = 0 THEN
    -- Already processed or donation not found for this payment
    RETURN jsonb_build_object('applied', false, 'already_applied', true);
  END IF;

  -- Only increment campaign stats if we actually transitioned a donation
  UPDATE campaigns
  SET raised_amount = raised_amount + v_amount,
      donor_count = donor_count + 1
  WHERE id = p_campaign_id;

  RETURN jsonb_build_object('applied', true, 'amount', v_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. Add payment_id to platform_fees for payment-level traceability
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE platform_fees ADD COLUMN IF NOT EXISTS payment_id uuid REFERENCES payments(id);

-- Unconditional payment-level unique index: one fee per payment, period.
-- No refunded_at filter — a refunded fee still blocks a duplicate original.
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_fees_payment_unique
  ON platform_fees(payment_id)
  WHERE payment_id IS NOT NULL;

-- Drop entity-level unique indexes that block legitimate second payments
DROP INDEX IF EXISTS idx_platform_fees_invoice_unique;
DROP INDEX IF EXISTS idx_platform_fees_campaign_unique;

-- Keep entity-level indexes for single-payment entities (booking, order, reservation)

-- ═══════════════════════════════════════════════════════════════════════
-- 8. Security: lock down RPC privileges
-- ═══════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION apply_invoice_payment(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_invoice_payment(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION apply_invoice_payment(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION apply_invoice_payment(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION apply_campaign_donation(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_campaign_donation(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION apply_campaign_donation(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION apply_campaign_donation(uuid, uuid) TO service_role;
