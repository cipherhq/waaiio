-- ══════════════════════════════════════════════════
-- Migration 154: Service Packages & Enrollments
-- ══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS service_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  num_sessions INTEGER NOT NULL,
  service_ids UUID[] DEFAULT '{}',
  valid_days INTEGER DEFAULT 365,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS package_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL,
  customer_name TEXT,
  package_id UUID NOT NULL REFERENCES service_packages(id) ON DELETE CASCADE,
  sessions_total INTEGER NOT NULL,
  sessions_used INTEGER DEFAULT 0,
  purchased_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  payment_id UUID REFERENCES payments(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_package_enrollments_business ON package_enrollments(business_id);
CREATE INDEX idx_package_enrollments_phone ON package_enrollments(customer_phone);
CREATE INDEX idx_service_packages_business ON service_packages(business_id);

ALTER TABLE service_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_enrollments ENABLE ROW LEVEL SECURITY;

-- Owners manage their own packages
CREATE POLICY "owners_manage_packages" ON service_packages FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Service role full access (bot, cron, webhooks)
CREATE POLICY "service_role_packages" ON service_packages FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Owners manage their own enrollments
CREATE POLICY "owners_manage_enrollments" ON package_enrollments FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Service role full access
CREATE POLICY "service_role_enrollments" ON package_enrollments FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Auto-update updated_at on service_packages
CREATE TRIGGER set_updated_at_service_packages
  BEFORE UPDATE ON service_packages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
