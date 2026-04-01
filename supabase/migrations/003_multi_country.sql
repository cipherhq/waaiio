-- ══════════════════════════════════════════════════════════
-- Migration 003: Multi-Country Support + WhatsApp Channels
-- ══════════════════════════════════════════════════════════

-- ── WhatsApp Channels table ──
CREATE TABLE IF NOT EXISTS whatsapp_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code VARCHAR(2) NOT NULL DEFAULT 'NG',
  phone_number VARCHAR(20) UNIQUE NOT NULL,
  gupshup_app_name VARCHAR(100) NOT NULL,
  gupshup_api_key TEXT NOT NULL,
  channel_type VARCHAR(10) NOT NULL DEFAULT 'shared' CHECK (channel_type IN ('shared', 'dedicated')),
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for channel lookup by phone number
CREATE INDEX IF NOT EXISTS idx_whatsapp_channels_phone ON whatsapp_channels(phone_number) WHERE is_active = true;
-- Index for shared channels per country
CREATE INDEX IF NOT EXISTS idx_whatsapp_channels_shared ON whatsapp_channels(country_code, channel_type) WHERE is_active = true AND channel_type = 'shared';
-- Index for dedicated channels per business
CREATE INDEX IF NOT EXISTS idx_whatsapp_channels_business ON whatsapp_channels(business_id) WHERE is_active = true AND channel_type = 'dedicated';

-- ── Add country_code to businesses ──
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS country_code VARCHAR(2) NOT NULL DEFAULT 'NG';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS whatsapp_channel_id UUID REFERENCES whatsapp_channels(id) ON DELETE SET NULL;

-- ── Add gateway to payments ──
ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway VARCHAR(10) NOT NULL DEFAULT 'paystack';

-- ── RLS for whatsapp_channels ──
ALTER TABLE whatsapp_channels ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by webhook + admin)
CREATE POLICY "Service role full access on whatsapp_channels"
  ON whatsapp_channels
  FOR ALL
  USING (auth.role() = 'service_role');

-- Business owners can read their own dedicated channel
CREATE POLICY "Business owners can read own channel"
  ON whatsapp_channels
  FOR SELECT
  USING (
    channel_type = 'dedicated'
    AND business_id IN (
      SELECT id FROM businesses WHERE owner_id = auth.uid()
    )
  );
