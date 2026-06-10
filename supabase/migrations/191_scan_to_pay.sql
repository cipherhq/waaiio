-- Payment links for scan-to-pay
CREATE TABLE IF NOT EXISTS payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  amount INTEGER, -- null = customer enters amount
  currency VARCHAR(3),
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  token VARCHAR(16) UNIQUE NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  uses_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_links_business ON payment_links(business_id);
CREATE INDEX idx_payment_links_token ON payment_links(token);

ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_manage_payment_links" ON payment_links
  FOR ALL USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

CREATE POLICY "service_insert_payment_links" ON payment_links
  FOR ALL TO service_role USING (true);
