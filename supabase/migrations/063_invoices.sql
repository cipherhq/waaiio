-- 063_invoices.sql — Invoice tables, triggers, indexes, RLS, FK additions

-- ── Add invoice capability enum value ──
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'invoice';

-- ── invoices table ──

CREATE TABLE IF NOT EXISTS public.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id),
  customer_profile_id UUID REFERENCES public.customer_profiles(id),

  -- Auto-generated BW-IXXXX reference
  reference_code VARCHAR(10) UNIQUE,

  -- Customer info (denormalized)
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  customer_email TEXT,
  customer_address TEXT,

  -- Status lifecycle: draft → sent → viewed → paid / overdue / cancelled
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'viewed', 'paid', 'overdue', 'cancelled')),

  -- Financials
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_type VARCHAR(10) CHECK (discount_type IN ('flat', 'percent')),
  discount_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'NGN',

  -- Dates
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,

  -- Content
  notes TEXT,
  terms TEXT,

  -- Delivery
  token VARCHAR(64) UNIQUE,
  token_expires_at TIMESTAMPTZ,
  sent_via VARCHAR(20),
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,

  -- WhatsApp tracking (same pattern as contracts)
  wa_message_id TEXT,
  wa_delivery_status VARCHAR(20),

  -- Manual payment
  manual_payment_method TEXT,
  manual_payment_note TEXT,
  marked_paid_by UUID REFERENCES auth.users(id),

  -- Payment link
  payment_id UUID,

  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── invoice_items table ──

CREATE TABLE IF NOT EXISTS public.invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Reference code trigger (BW-IXXXX) ──

CREATE OR REPLACE FUNCTION public.generate_invoice_reference()
RETURNS TRIGGER AS $$
DECLARE
  new_code VARCHAR(10);
  code_exists BOOLEAN;
BEGIN
  LOOP
    new_code := 'BW-I' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
    SELECT EXISTS(SELECT 1 FROM public.invoices WHERE reference_code = new_code) INTO code_exists;
    EXIT WHEN NOT code_exists;
  END LOOP;
  NEW.reference_code := new_code;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_invoice_reference_code
  BEFORE INSERT ON public.invoices
  FOR EACH ROW
  WHEN (NEW.reference_code IS NULL OR NEW.reference_code = '')
  EXECUTE FUNCTION public.generate_invoice_reference();

-- ── Updated-at trigger ──

CREATE TRIGGER update_invoices_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── FK additions to payments and platform_fees ──

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES public.invoices(id);
ALTER TABLE public.platform_fees ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES public.invoices(id);

-- ── Indexes ──

CREATE INDEX idx_invoices_business_created ON public.invoices(business_id, created_at DESC);
CREATE INDEX idx_invoices_business_status ON public.invoices(business_id, status);
CREATE INDEX idx_invoices_token ON public.invoices USING hash(token);
CREATE INDEX idx_invoices_due_date ON public.invoices(due_date) WHERE status IN ('sent', 'viewed');
CREATE INDEX idx_invoice_items_invoice ON public.invoice_items(invoice_id, sort_order);

-- ── RLS ──

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;

-- Business owner can manage invoices
CREATE POLICY invoices_owner_all ON public.invoices
  FOR ALL
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

-- Invoice items inherit access from parent invoice
CREATE POLICY invoice_items_owner_all ON public.invoice_items
  FOR ALL
  USING (invoice_id IN (SELECT id FROM public.invoices WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())))
  WITH CHECK (invoice_id IN (SELECT id FROM public.invoices WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())));
