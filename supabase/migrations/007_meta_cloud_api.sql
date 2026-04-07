-- ════════════════════════════════════════════════════════
-- Migration 007: Meta WhatsApp Cloud API support
-- Adds fields for direct Cloud API connections alongside Gupshup
-- ════════════════════════════════════════════════════════

-- Add Meta Cloud API fields to whatsapp_channels
ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS provider VARCHAR(20) DEFAULT 'gupshup'
    CHECK (provider IN ('gupshup', 'meta_cloud')),
  ADD COLUMN IF NOT EXISTS waba_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS phone_number_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS meta_access_token TEXT,
  ADD COLUMN IF NOT EXISTS meta_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(128),
  ADD COLUMN IF NOT EXISTS quality_rating VARCHAR(20),
  ADD COLUMN IF NOT EXISTS messaging_limit VARCHAR(20),
  ADD COLUMN IF NOT EXISTS connection_method VARCHAR(20)
    CHECK (connection_method IN ('shared', 'transfer', 'coexist'));

-- Track the connection status for own-number setups
ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS connection_status VARCHAR(20) DEFAULT 'active'
    CHECK (connection_status IN ('pending', 'verifying', 'active', 'suspended', 'disconnected'));

-- Store the Meta App credentials per-business for own-number connections
-- (the shared number uses env vars, own numbers use per-record tokens)
CREATE INDEX IF NOT EXISTS idx_whatsapp_channels_waba_id ON whatsapp_channels(waba_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_channels_phone_number_id ON whatsapp_channels(phone_number_id);

-- Add wa_method to businesses to track which connection type they chose during onboarding
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS wa_method VARCHAR(20) DEFAULT 'shared'
    CHECK (wa_method IN ('shared', 'transfer', 'coexist'));

COMMENT ON COLUMN whatsapp_channels.provider IS 'Message provider: gupshup (shared numbers) or meta_cloud (direct Cloud API)';
COMMENT ON COLUMN whatsapp_channels.waba_id IS 'WhatsApp Business Account ID from Meta';
COMMENT ON COLUMN whatsapp_channels.phone_number_id IS 'Phone Number ID from Meta Cloud API';
COMMENT ON COLUMN whatsapp_channels.meta_access_token IS 'Long-lived System User access token for Cloud API';
COMMENT ON COLUMN whatsapp_channels.connection_method IS 'How the number was connected: shared, transfer, or coexist';
COMMENT ON COLUMN businesses.wa_method IS 'WhatsApp connection method chosen during onboarding';
