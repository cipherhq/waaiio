-- Waiver templates: reusable waiver forms per business
CREATE TABLE IF NOT EXISTS waiver_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title VARCHAR(300) NOT NULL,
  body TEXT NOT NULL,
  fields JSONB NOT NULL DEFAULT '["name","signature","date"]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  require_before_booking BOOLEAN NOT NULL DEFAULT false,
  token VARCHAR(32) UNIQUE NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Signed waivers: each individual signing
CREATE TABLE IF NOT EXISTS signed_waivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES waiver_templates(id) ON DELETE RESTRICT,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_name VARCHAR(200) NOT NULL,
  customer_phone VARCHAR(30),
  customer_email VARCHAR(200),
  signature_url TEXT,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pdf_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  audit_trail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_waiver_templates_business ON waiver_templates(business_id);
CREATE INDEX idx_signed_waivers_business ON signed_waivers(business_id);
CREATE INDEX idx_signed_waivers_template ON signed_waivers(template_id);
CREATE INDEX idx_signed_waivers_phone ON signed_waivers(customer_phone);

ALTER TABLE waiver_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE signed_waivers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_manage_waiver_templates" ON waiver_templates
  FOR ALL USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

CREATE POLICY "owners_view_signed_waivers" ON signed_waivers
  FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Service role can insert signed waivers (public signing page)
CREATE POLICY "service_insert_signed_waivers" ON signed_waivers
  FOR INSERT TO service_role WITH CHECK (true);

CREATE TRIGGER update_waiver_templates_updated_at
  BEFORE UPDATE ON waiver_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
