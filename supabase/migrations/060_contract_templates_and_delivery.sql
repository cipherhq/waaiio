-- Feature 1: Custom/Saved Contract Templates per business
CREATE TABLE IF NOT EXISTS contract_templates (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title varchar(200) NOT NULL,
  content text,
  template_url text,
  category varchar(50) DEFAULT 'custom',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contract_templates_business ON contract_templates(business_id);

ALTER TABLE contract_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business owners manage templates"
  ON contract_templates FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Feature 2: WhatsApp delivery/read status tracking on contracts
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS wa_message_id text;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS wa_delivery_status varchar(20) DEFAULT 'sent';
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS wa_status_updated_at timestamptz;

-- WhatsApp delivery/read status tracking on contract_signers
ALTER TABLE contract_signers ADD COLUMN IF NOT EXISTS wa_message_id text;
ALTER TABLE contract_signers ADD COLUMN IF NOT EXISTS wa_delivery_status varchar(20) DEFAULT 'sent';
ALTER TABLE contract_signers ADD COLUMN IF NOT EXISTS wa_status_updated_at timestamptz;
