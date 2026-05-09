-- ════════════════════════════════════════════════════════
-- Migration 123: Add assigned_channel_id to businesses
-- Allows admin to assign a specific WhatsApp channel to a business
-- Works alongside whatsapp_channel_id (self-service) — assigned takes priority
-- ════════════════════════════════════════════════════════

-- Add assigned_channel_id column (may already exist if added manually)
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS assigned_channel_id UUID REFERENCES whatsapp_channels(id) ON DELETE SET NULL;

-- Backfill: copy whatsapp_channel_id → assigned_channel_id where set
UPDATE businesses
SET assigned_channel_id = whatsapp_channel_id
WHERE whatsapp_channel_id IS NOT NULL AND assigned_channel_id IS NULL;

-- Expand connection_method CHECK to allow future values
ALTER TABLE whatsapp_channels DROP CONSTRAINT IF EXISTS whatsapp_channels_connection_method_check;
ALTER TABLE whatsapp_channels ADD CONSTRAINT whatsapp_channels_connection_method_check
  CHECK (connection_method IN ('shared', 'transfer', 'coexist', 'waaiio_hosted', 'embedded_signup'));

-- Expand wa_method CHECK to allow 'own_phone'
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_wa_method_check;
ALTER TABLE businesses ADD CONSTRAINT businesses_wa_method_check
  CHECK (wa_method IN ('shared', 'transfer', 'coexist', 'own_phone'));

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_businesses_assigned_channel ON businesses(assigned_channel_id) WHERE assigned_channel_id IS NOT NULL;
