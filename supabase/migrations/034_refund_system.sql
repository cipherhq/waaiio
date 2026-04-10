-- 034: Refund system — columns on payments + refunds table

-- Add refund columns to payments table
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_reason TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_by UUID;

-- Create refunds table for granular tracking (supports multiple partial refunds)
CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  gateway TEXT,
  gateway_refund_reference TEXT,
  gateway_response JSONB,
  refund_type TEXT NOT NULL DEFAULT 'full' CHECK (refund_type IN ('full', 'partial')),
  is_direct_split BOOLEAN NOT NULL DEFAULT FALSE,
  initiated_by UUID,
  initiated_by_role TEXT NOT NULL DEFAULT 'business' CHECK (initiated_by_role IN ('business', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_business_id ON refunds(business_id);

-- RLS
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;

-- Business owners see their own refunds
CREATE POLICY "Business owners see own refunds"
  ON refunds FOR SELECT
  USING (
    business_id IN (
      SELECT id FROM businesses WHERE owner_id = auth.uid()
    )
  );

-- Business owners can insert refunds for their own businesses
CREATE POLICY "Business owners insert own refunds"
  ON refunds FOR INSERT
  WITH CHECK (
    business_id IN (
      SELECT id FROM businesses WHERE owner_id = auth.uid()
    )
  );

-- Business owners can update their own refunds
CREATE POLICY "Business owners update own refunds"
  ON refunds FOR UPDATE
  USING (
    business_id IN (
      SELECT id FROM businesses WHERE owner_id = auth.uid()
    )
  );

-- Admins see all refunds
CREATE POLICY "Admins see all refunds"
  ON refunds FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Admins can insert any refund
CREATE POLICY "Admins insert any refund"
  ON refunds FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Admins can update any refund
CREATE POLICY "Admins update any refund"
  ON refunds FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
