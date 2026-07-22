-- ═══════════════════════════════════════════════════════
-- 274: Immutable invoice payment application ledger
-- Every payment applied to an invoice gets an immutable record.
-- UNIQUE(invoice_id, payment_id) ensures idempotency.
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.invoice_payment_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES public.payments(id),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id),
  business_id UUID NOT NULL REFERENCES public.businesses(id),
  currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
  amount_received NUMERIC(12,2) NOT NULL,
  amount_applied NUMERIC(12,2) NOT NULL,
  overpayment_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  resulting_invoice_status VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_invoice_payment_application UNIQUE (invoice_id, payment_id),
  CONSTRAINT chk_amounts_non_negative CHECK (
    amount_received >= 0 AND amount_applied >= 0 AND overpayment_amount >= 0
  ),
  CONSTRAINT chk_amounts_consistent CHECK (
    amount_applied + overpayment_amount = amount_received
  )
);

ALTER TABLE public.invoice_payment_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on invoice_payment_applications"
  ON public.invoice_payment_applications
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Business owner read own applications"
  ON public.invoice_payment_applications
  FOR SELECT
  TO authenticated
  USING (business_id IN (
    SELECT id FROM public.businesses WHERE owner_id = auth.uid()
  ));
