-- Direct bank transfer payment system
-- Allows Growth/Business tier customers to pay via direct bank transfer
-- bypassing payment gateways for zero gateway fees

-- 1. Business bank account details (for receiving transfers)
CREATE TABLE IF NOT EXISTS business_bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bank_name VARCHAR(100) NOT NULL,
  account_number VARCHAR(20) NOT NULL,
  account_name VARCHAR(200) NOT NULL,
  bank_code VARCHAR(10),
  is_default BOOLEAN DEFAULT true,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Pending transfer records
CREATE TABLE IF NOT EXISTS pending_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES bookings(id),
  order_id UUID,
  invoice_id UUID,
  reservation_id UUID,
  customer_phone VARCHAR(30) NOT NULL,
  customer_name VARCHAR(200),
  expected_amount INTEGER NOT NULL,
  currency VARCHAR(5) NOT NULL DEFAULT 'NGN',
  reference_code VARCHAR(20) NOT NULL UNIQUE,
  proof_type VARCHAR(20),           -- 'screenshot', 'reference', 'text', null
  proof_text TEXT,                   -- typed reference or extracted text
  proof_image_url TEXT,              -- screenshot storage URL
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired', 'cancelled')),
  confirmed_by UUID REFERENCES auth.users(id),
  confirmed_at TIMESTAMPTZ,
  rejected_reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL,   -- 4 hours from creation
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Track monthly direct transfer volume for fee invoicing
-- (platform fee on direct transfers is invoiced monthly)
ALTER TABLE platform_fees ADD COLUMN IF NOT EXISTS is_direct_transfer BOOLEAN DEFAULT false;

-- 4. RLS
ALTER TABLE business_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_transfers ENABLE ROW LEVEL SECURITY;

-- Business owners manage their bank accounts
CREATE POLICY "Owners manage bank accounts" ON business_bank_accounts
  FOR ALL USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- Resellers manage sub-account bank accounts
CREATE POLICY "Resellers manage sub-account bank accounts" ON business_bank_accounts
  FOR ALL USING (
    business_id IN (
      SELECT b.id FROM businesses b
      JOIN resellers r ON b.reseller_id = r.id
      WHERE r.user_id = auth.uid()
    )
  );

-- Service role full access
CREATE POLICY "Service role manages bank accounts" ON business_bank_accounts
  FOR ALL TO service_role WITH CHECK (true);

-- Business owners manage pending transfers
CREATE POLICY "Owners manage pending transfers" ON pending_transfers
  FOR ALL USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- Service role full access
CREATE POLICY "Service role manages pending transfers" ON pending_transfers
  FOR ALL TO service_role WITH CHECK (true);

-- Admin can view all
CREATE POLICY "Admin views pending transfers" ON pending_transfers
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'support', 'finance'))
  );

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_business_bank_accounts_business ON business_bank_accounts(business_id);
CREATE INDEX IF NOT EXISTS idx_pending_transfers_business ON pending_transfers(business_id);
CREATE INDEX IF NOT EXISTS idx_pending_transfers_status ON pending_transfers(status);
CREATE INDEX IF NOT EXISTS idx_pending_transfers_reference ON pending_transfers(reference_code);
CREATE INDEX IF NOT EXISTS idx_pending_transfers_expires ON pending_transfers(expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pending_transfers_booking ON pending_transfers(booking_id) WHERE booking_id IS NOT NULL;

-- 6. Triggers
CREATE TRIGGER set_business_bank_accounts_updated_at
  BEFORE UPDATE ON business_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_pending_transfers_updated_at
  BEFORE UPDATE ON pending_transfers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 7. One default bank account per business
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_bank_accounts_default
  ON business_bank_accounts(business_id) WHERE is_default = true AND is_active = true;
