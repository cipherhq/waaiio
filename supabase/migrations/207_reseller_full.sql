-- Reseller white-label: full phase 1-3 schema
-- Covers: branding, tiers, payouts, invoices, custom domains, onboarding

-- 1. Reseller table enhancements
ALTER TABLE resellers ADD COLUMN IF NOT EXISTS branding JSONB DEFAULT '{}';
-- branding: { logo_url, favicon_url, primary_color, accent_color }
ALTER TABLE resellers ADD COLUMN IF NOT EXISTS custom_domain TEXT;
ALTER TABLE resellers ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'starter' CHECK (tier IN ('starter', 'professional', 'enterprise'));
ALTER TABLE resellers ADD COLUMN IF NOT EXISTS billing_notes TEXT;
ALTER TABLE resellers ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;
ALTER TABLE resellers ADD COLUMN IF NOT EXISTS invite_token TEXT UNIQUE;
ALTER TABLE resellers ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE resellers ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

-- 2. Reseller payouts (commission disbursement)
CREATE TABLE IF NOT EXISTS reseller_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id UUID NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  gross_commission INTEGER NOT NULL DEFAULT 0,
  holdback INTEGER NOT NULL DEFAULT 0,
  deductions INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
  approved_by UUID REFERENCES auth.users(id),
  paid_at TIMESTAMPTZ,
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(reseller_id, period_start, period_end)
);

-- 3. Reseller invoices (charging resellers for platform access)
CREATE TABLE IF NOT EXISTS reseller_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id UUID NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue', 'cancelled')),
  due_date DATE,
  paid_at TIMESTAMPTZ,
  stripe_invoice_id TEXT,
  period_start DATE,
  period_end DATE,
  line_items JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Demo request enhancement
ALTER TABLE demo_requests ADD COLUMN IF NOT EXISTS auto_response_sent BOOLEAN DEFAULT false;

-- 5. RLS for reseller_payouts
ALTER TABLE reseller_payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Resellers view own payouts" ON reseller_payouts
  FOR SELECT USING (
    reseller_id IN (SELECT id FROM resellers WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role manages reseller payouts" ON reseller_payouts
  FOR ALL TO service_role WITH CHECK (true);

CREATE POLICY "Admin manages reseller payouts" ON reseller_payouts
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'finance'))
  );

-- 6. RLS for reseller_invoices
ALTER TABLE reseller_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Resellers view own invoices" ON reseller_invoices
  FOR SELECT USING (
    reseller_id IN (SELECT id FROM resellers WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role manages reseller invoices" ON reseller_invoices
  FOR ALL TO service_role WITH CHECK (true);

CREATE POLICY "Admin manages reseller invoices" ON reseller_invoices
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'finance'))
  );

-- 7. Indexes
CREATE INDEX IF NOT EXISTS idx_reseller_payouts_reseller ON reseller_payouts(reseller_id);
CREATE INDEX IF NOT EXISTS idx_reseller_payouts_status ON reseller_payouts(status);
CREATE INDEX IF NOT EXISTS idx_reseller_payouts_period ON reseller_payouts(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_reseller_invoices_reseller ON reseller_invoices(reseller_id);
CREATE INDEX IF NOT EXISTS idx_reseller_invoices_status ON reseller_invoices(status);
CREATE INDEX IF NOT EXISTS idx_reseller_invoices_due ON reseller_invoices(due_date) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_resellers_custom_domain ON resellers(custom_domain) WHERE custom_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_resellers_tier ON resellers(tier);

-- 8. Triggers
CREATE TRIGGER set_reseller_payouts_updated_at
  BEFORE UPDATE ON reseller_payouts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_reseller_invoices_updated_at
  BEFORE UPDATE ON reseller_invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
