-- Platform fee invoices for direct bank transfer businesses
-- Waaiio charges platform fees on direct transfers but doesn't hold the funds.
-- This table tracks monthly invoices sent to businesses for fee collection.

CREATE TABLE IF NOT EXISTS platform_fee_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL UNIQUE, -- e.g. PFI-2026-06-001
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  -- Amounts in minor units (kobo/cents)
  total_transaction_amount INTEGER NOT NULL DEFAULT 0, -- sum of transaction amounts
  total_fee_amount INTEGER NOT NULL DEFAULT 0, -- sum of platform fees owed
  transaction_count INTEGER NOT NULL DEFAULT 0, -- number of transfers in period
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue', 'waived', 'cancelled')),
  due_date DATE NOT NULL, -- typically 5th of next month
  paid_at TIMESTAMPTZ,
  paid_via TEXT, -- 'paystack', 'stripe', 'manual', 'deducted'
  payment_reference TEXT, -- gateway reference or manual note
  waived_reason TEXT,
  waived_by UUID REFERENCES auth.users(id),
  reminder_sent_at TIMESTAMPTZ,
  overdue_notice_sent_at TIMESTAMPTZ,
  line_items JSONB DEFAULT '[]', -- breakdown of individual fees
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Prevent duplicate invoices for same business + period
CREATE UNIQUE INDEX IF NOT EXISTS idx_pfi_business_period
  ON platform_fee_invoices (business_id, period_start, period_end);

-- Fast lookup by status
CREATE INDEX IF NOT EXISTS idx_pfi_status ON platform_fee_invoices (status);
CREATE INDEX IF NOT EXISTS idx_pfi_due_date ON platform_fee_invoices (due_date) WHERE status IN ('pending', 'overdue');

-- Track which platform_fees have been invoiced
ALTER TABLE platform_fees ADD COLUMN IF NOT EXISTS invoiced_at TIMESTAMPTZ;
ALTER TABLE platform_fees ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES platform_fee_invoices(id) ON DELETE SET NULL;

-- RLS
ALTER TABLE platform_fee_invoices ENABLE ROW LEVEL SECURITY;

-- Business owners can view their own invoices
CREATE POLICY "Business owners view fee invoices" ON platform_fee_invoices
  FOR SELECT USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- Admin/finance can view and manage all invoices
CREATE POLICY "Admin manages fee invoices" ON platform_fee_invoices
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'finance'))
  );

-- Service role full access
CREATE POLICY "Service role manages fee invoices" ON platform_fee_invoices
  FOR ALL TO service_role USING (true) WITH CHECK (true);
