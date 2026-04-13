-- 040_bot_customization.sql
-- Bot Customization Engine: keywords, step overrides, sequences, rules, welcome buttons, templates

-- ─── whatsapp_config additions ────────────────────────────────────────────────

ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS welcome_buttons JSONB DEFAULT '[]'::jsonb;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS default_reply TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS bot_order_confirmation_template TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS bot_payment_receipt_template TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS bot_order_status_template TEXT;

-- ─── bot_keywords ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  match_type VARCHAR(10) NOT NULL DEFAULT 'contains' CHECK (match_type IN ('exact', 'contains', 'starts_with')),
  action_type VARCHAR(20) NOT NULL CHECK (action_type IN ('reply', 'start_flow', 'start_capability', 'url')),
  payload TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_keywords_business ON bot_keywords(business_id) WHERE is_active = true;

ALTER TABLE bot_keywords ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_crud" ON bot_keywords FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- ─── bot_step_overrides ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_step_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  flow_type VARCHAR(30) NOT NULL,
  step_id VARCHAR(60) NOT NULL,
  action VARCHAR(10) NOT NULL DEFAULT 'default' CHECK (action IN ('default', 'skip', 'require', 'custom')),
  custom_prompt TEXT,
  custom_options JSONB,
  branch_conditions JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, flow_type, step_id)
);

ALTER TABLE bot_step_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_crud" ON bot_step_overrides FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- ─── bot_sequences ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  trigger_event VARCHAR(40) NOT NULL CHECK (trigger_event IN (
    'after_booking', 'after_order', 'after_payment', 'after_signup',
    'after_no_show', 'after_cancellation', 'manual'
  )),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bot_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_crud" ON bot_sequences FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- ─── bot_sequence_steps ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_sequence_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES bot_sequences(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  message_type VARCHAR(10) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'template')),
  message_content TEXT NOT NULL,
  image_url TEXT,
  condition JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bot_sequence_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_crud" ON bot_sequence_steps FOR ALL
  USING (sequence_id IN (
    SELECT id FROM bot_sequences WHERE business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  ));

-- ─── bot_sequence_enrollments ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_sequence_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES bot_sequences(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone VARCHAR(20) NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  next_send_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  context JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_pending
  ON bot_sequence_enrollments(next_send_at, status) WHERE status = 'active';

ALTER TABLE bot_sequence_enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_view" ON bot_sequence_enrollments FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

CREATE POLICY "service_role_all" ON bot_sequence_enrollments FOR ALL
  USING (auth.role() = 'service_role');

-- ─── bot_rules ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  trigger_event VARCHAR(40) NOT NULL CHECK (trigger_event IN (
    'booking_created', 'booking_completed', 'booking_cancelled', 'booking_no_show',
    'order_created', 'order_delivered', 'order_cancelled',
    'payment_received', 'payment_failed',
    'customer_first_visit', 'customer_return_visit',
    'message_received'
  )),
  conditions JSONB DEFAULT '[]'::jsonb,
  action_type VARCHAR(20) NOT NULL CHECK (action_type IN (
    'send_message', 'send_template', 'enroll_sequence', 'assign_tag',
    'notify_owner', 'update_status'
  )),
  action_payload JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_rules_business ON bot_rules(business_id, trigger_event) WHERE is_active = true;

ALTER TABLE bot_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_crud" ON bot_rules FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
