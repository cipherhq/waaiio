-- ============================================================
-- 203: Keyword Campaigns
-- Businesses can create keyword-triggered campaigns that auto-reply
-- and track opt-in responses. Extends bot_keywords with campaign_reply action.
-- ============================================================

-- ── 1. keyword_campaigns table ───────────────────────────────

CREATE TABLE keyword_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  keyword TEXT NOT NULL,
  description TEXT,
  response_type TEXT NOT NULL DEFAULT 'text'
    CHECK (response_type IN ('text', 'image', 'link', 'buttons')),
  response_text TEXT NOT NULL,
  response_media_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  opt_in_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, keyword)
);

ALTER TABLE keyword_campaigns ENABLE ROW LEVEL SECURITY;

-- Business owners manage their own campaigns
CREATE POLICY "owners_manage_campaigns" ON keyword_campaigns FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE owner_id = auth.uid()
  ));

-- ── 2. keyword_campaign_responses table ──────────────────────

CREATE TABLE keyword_campaign_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES keyword_campaigns(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  customer_name TEXT,
  responded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, phone)
);

ALTER TABLE keyword_campaign_responses ENABLE ROW LEVEL SECURITY;

-- Business owners can read responses
CREATE POLICY "owners_read_responses" ON keyword_campaign_responses FOR SELECT
  USING (business_id IN (
    SELECT id FROM businesses WHERE owner_id = auth.uid()
  ));

-- Service role can insert responses (bot handler)
CREATE POLICY "service_insert_responses" ON keyword_campaign_responses FOR INSERT
  WITH CHECK (true);

-- ── 3. Extend bot_keywords with campaign_id ──────────────────

ALTER TABLE bot_keywords ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES keyword_campaigns(id) ON DELETE CASCADE;

-- Expand action_type to include 'campaign_reply'
ALTER TABLE bot_keywords DROP CONSTRAINT IF EXISTS bot_keywords_action_type_check;
ALTER TABLE bot_keywords ADD CONSTRAINT bot_keywords_action_type_check
  CHECK (action_type IN ('reply', 'start_flow', 'start_capability', 'url', 'navigate_step', 'acknowledge', 'show_menu', 'campaign_reply'));

-- ── 4. Indexes ───────────────────────────────────────────────

CREATE INDEX idx_keyword_campaigns_business ON keyword_campaigns(business_id);
CREATE INDEX idx_keyword_campaigns_active ON keyword_campaigns(business_id, is_active) WHERE is_active = true;
CREATE INDEX idx_campaign_responses_campaign ON keyword_campaign_responses(campaign_id);
CREATE INDEX idx_campaign_responses_business ON keyword_campaign_responses(business_id);
CREATE INDEX idx_bot_keywords_campaign ON bot_keywords(campaign_id) WHERE campaign_id IS NOT NULL;
