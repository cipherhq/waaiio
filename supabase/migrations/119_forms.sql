-- ═══════════════════════════════════════════════════════
-- Custom Forms: business creates forms, sends links to
-- customers for data collection
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title varchar(200) NOT NULL,
  description text,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- fields format: [{ id, label, type, required, options?, placeholder? }]
  -- types: text, textarea, number, email, phone, select, checkbox, date, file
  token varchar(20) UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  response_count integer NOT NULL DEFAULT 0,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- settings: { notify_on_submit, redirect_url, submit_message }
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forms_business ON forms(business_id);
CREATE INDEX IF NOT EXISTS idx_forms_token ON forms(token) WHERE token IS NOT NULL;

CREATE TABLE IF NOT EXISTS form_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone varchar(30),
  customer_name varchar(200),
  customer_email varchar(200),
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- answers format: { field_id: value, field_id: [values], ... }
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_form_responses_form ON form_responses(form_id);
CREATE INDEX IF NOT EXISTS idx_form_responses_business ON form_responses(business_id);

-- RLS
ALTER TABLE forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY forms_owner_select ON forms FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY forms_owner_insert ON forms FOR INSERT
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY forms_owner_update ON forms FOR UPDATE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY forms_owner_delete ON forms FOR DELETE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY forms_service_all ON forms FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY form_responses_owner_select ON form_responses FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY form_responses_owner_delete ON form_responses FOR DELETE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY form_responses_service_all ON form_responses FOR ALL TO service_role
  USING (true) WITH CHECK (true);
