-- Migration 310: Payment-level idempotency for financial operations
--
-- Core invariant: ONE successful payment → EXACTLY ONE financial effect.
-- RPCs validate payment row from DB — caller-supplied amounts are ignored.
--
-- Legacy invariant: at migration completion, every invoice's amount_paid
-- remains EXACTLY what it was before migration. Historical payment records
-- are marked as already-processed but do NOT reinterpret existing balance.
-- Legacy replays do NOT create second economic fees.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Invoice payment applications ledger
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS invoice_payment_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  amount_applied numeric(12,2) NOT NULL DEFAULT 0,
  is_legacy_marker boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(invoice_id, payment_id)
);

ALTER TABLE invoice_payment_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_invoice_payment_applications"
  ON invoice_payment_applications FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Freeze pre-migration amount_paid as durable legacy baseline
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS
  legacy_amount_paid_baseline numeric(12,2) NOT NULL DEFAULT 0;

UPDATE invoices
SET legacy_amount_paid_baseline = COALESCE(amount_paid, 0)
WHERE COALESCE(amount_paid, 0) > 0;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Backfill historical payments as REPLAY MARKERS (amount_applied=0)
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO invoice_payment_applications (invoice_id, payment_id, amount_applied, is_legacy_marker)
SELECT p.invoice_id, p.id, 0, true
FROM payments p
WHERE p.invoice_id IS NOT NULL
  AND p.status = 'success'
  AND NOT EXISTS (
    SELECT 1 FROM invoice_payment_applications ipa
    WHERE ipa.invoice_id = p.invoice_id AND ipa.payment_id = p.id
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Campaign donations: add legacy marker + payment uniqueness
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE campaign_donations ADD COLUMN IF NOT EXISTS
  is_legacy boolean NOT NULL DEFAULT false;

-- Mark pre-migration successful donations as legacy
UPDATE campaign_donations SET is_legacy = true WHERE status = 'success';

-- Deduplicate payment_id before adding UNIQUE constraint.
-- Keep the earliest donation per payment_id, mark others as legacy orphans.
-- This handles any existing anomalous duplicate payment_id rows safely.
WITH ranked AS (
  SELECT id, payment_id,
    ROW_NUMBER() OVER (PARTITION BY payment_id ORDER BY created_at ASC, id ASC) AS rn
  FROM campaign_donations
  WHERE payment_id IS NOT NULL
)
UPDATE campaign_donations cd
SET payment_id = NULL, is_legacy = true
FROM ranked r
WHERE cd.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_donations_payment_unique
  ON campaign_donations(payment_id)
  WHERE payment_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Atomic invoice payment application RPC
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_invoice_payment(
  p_invoice_id uuid,
  p_payment_id uuid
) RETURNS jsonb
SET search_path = public
AS $$
DECLARE
  v_payment record;
  v_invoice record;
  v_amount numeric;
  v_ledger_total numeric;
  v_new_amount_paid numeric;
  v_is_fully_paid boolean;
  v_existing_marker record;
BEGIN
  SELECT id, amount, invoice_id, status, business_id
  INTO v_payment FROM public.payments WHERE id = p_payment_id;

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

  SELECT total_amount, amount_paid, status, business_id, legacy_amount_paid_baseline
  INTO v_invoice FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'invoice_not_found');
  END IF;
  IF v_invoice.business_id != v_payment.business_id THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'business_mismatch');
  END IF;

  -- Idempotent insert
  INSERT INTO public.invoice_payment_applications (invoice_id, payment_id, amount_applied, is_legacy_marker)
  VALUES (p_invoice_id, p_payment_id, v_amount, false)
  ON CONFLICT (invoice_id, payment_id) DO NOTHING;

  IF NOT FOUND THEN
    -- Check if this is a legacy marker or a previous new application
    SELECT is_legacy_marker INTO v_existing_marker
    FROM public.invoice_payment_applications
    WHERE invoice_id = p_invoice_id AND payment_id = p_payment_id;

    RETURN jsonb_build_object(
      'applied', false,
      'already_applied', true,
      'is_legacy', COALESCE(v_existing_marker.is_legacy_marker, false),
      'amount', v_amount
    );
  END IF;

  -- Authoritative: baseline + SUM(all amount_applied)
  SELECT COALESCE(SUM(amount_applied), 0) INTO v_ledger_total
  FROM public.invoice_payment_applications
  WHERE invoice_id = p_invoice_id;

  v_new_amount_paid := COALESCE(v_invoice.legacy_amount_paid_baseline, 0) + v_ledger_total;
  v_is_fully_paid := v_new_amount_paid >= v_invoice.total_amount;

  UPDATE public.invoices
  SET amount_paid = v_new_amount_paid,
      status = CASE WHEN v_is_fully_paid THEN 'paid' ELSE status END,
      paid_at = CASE WHEN v_is_fully_paid AND paid_at IS NULL THEN now() ELSE paid_at END,
      updated_at = now()
  WHERE id = p_invoice_id;

  RETURN jsonb_build_object(
    'applied', true,
    'is_legacy', false,
    'amount', v_amount,
    'new_amount_paid', v_new_amount_paid,
    'is_fully_paid', v_is_fully_paid
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. Atomic campaign donation application RPC
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_campaign_donation(
  p_campaign_id uuid,
  p_payment_id uuid
) RETURNS jsonb
SET search_path = public
AS $$
DECLARE
  v_payment record;
  v_campaign record;
  v_amount numeric;
  v_rows_updated integer;
  v_donation record;
BEGIN
  SELECT id, amount, campaign_id, status, business_id
  INTO v_payment FROM public.payments WHERE id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_found');
  END IF;
  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_successful');
  END IF;
  IF v_payment.campaign_id IS NULL OR v_payment.campaign_id != p_campaign_id THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_campaign_mismatch');
  END IF;

  SELECT id, business_id INTO v_campaign FROM public.campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'campaign_not_found');
  END IF;
  IF v_campaign.business_id != v_payment.business_id THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'business_mismatch');
  END IF;

  v_amount := v_payment.amount;

  -- Transition pending → success
  UPDATE public.campaign_donations
  SET status = 'success'
  WHERE payment_id = p_payment_id AND campaign_id = p_campaign_id AND status = 'pending';
  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

  IF v_rows_updated = 0 THEN
    -- Check if already success (legacy or previous application)
    SELECT is_legacy INTO v_donation
    FROM public.campaign_donations
    WHERE payment_id = p_payment_id AND campaign_id = p_campaign_id AND status = 'success';

    IF FOUND THEN
      RETURN jsonb_build_object(
        'applied', false,
        'already_applied', true,
        'is_legacy', COALESCE(v_donation.is_legacy, false),
        'amount', v_amount
      );
    ELSE
      RETURN jsonb_build_object('applied', false, 'reason', 'donation_not_found');
    END IF;
  END IF;

  UPDATE public.campaigns
  SET raised_amount = raised_amount + v_amount, donor_count = donor_count + 1
  WHERE id = p_campaign_id;

  RETURN jsonb_build_object('applied', true, 'is_legacy', false, 'amount', v_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. Platform fees: payment_id + payment-level uniqueness
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE platform_fees ADD COLUMN IF NOT EXISTS payment_id uuid REFERENCES payments(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_fees_payment_unique
  ON platform_fees(payment_id) WHERE payment_id IS NOT NULL;

DROP INDEX IF EXISTS idx_platform_fees_invoice_unique;
DROP INDEX IF EXISTS idx_platform_fees_campaign_unique;

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
