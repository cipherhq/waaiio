-- Resellers table
CREATE TABLE IF NOT EXISTS resellers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  logo_url TEXT,
  commission_percentage DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  billing_type TEXT NOT NULL DEFAULT 'per_seat' CHECK (billing_type IN ('per_seat', 'revenue_share', 'flat_monthly')),
  flat_monthly_amount INTEGER DEFAULT 0,
  max_sub_accounts INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Add reseller_id to businesses
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS reseller_id UUID REFERENCES resellers(id) ON DELETE SET NULL;

-- Add reseller columns to platform_fees
ALTER TABLE platform_fees ADD COLUMN IF NOT EXISTS reseller_id UUID REFERENCES resellers(id) ON DELETE SET NULL;
ALTER TABLE platform_fees ADD COLUMN IF NOT EXISTS reseller_commission INTEGER DEFAULT 0;

-- RLS
ALTER TABLE resellers ENABLE ROW LEVEL SECURITY;

-- Reseller manages own record
CREATE POLICY "Resellers manage own record" ON resellers
  FOR ALL USING (user_id = auth.uid());

-- Service role full access
CREATE POLICY "Service role manages resellers" ON resellers
  FOR ALL TO service_role USING (true);

-- Reseller can view their sub-businesses
CREATE POLICY "Resellers view sub-businesses" ON businesses
  FOR SELECT USING (
    reseller_id IN (SELECT id FROM resellers WHERE user_id = auth.uid())
  );

-- Reseller can update their sub-businesses (limited fields)
CREATE POLICY "Resellers update sub-businesses" ON businesses
  FOR UPDATE USING (
    reseller_id IN (SELECT id FROM resellers WHERE user_id = auth.uid())
  );

-- Index
CREATE INDEX IF NOT EXISTS idx_businesses_reseller_id ON businesses(reseller_id) WHERE reseller_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_resellers_user_id ON resellers(user_id);
CREATE INDEX IF NOT EXISTS idx_platform_fees_reseller_id ON platform_fees(reseller_id) WHERE reseller_id IS NOT NULL;

-- Updated_at trigger
CREATE TRIGGER set_resellers_updated_at BEFORE UPDATE ON resellers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
