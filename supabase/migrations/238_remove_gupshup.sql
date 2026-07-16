-- Remove Gupshup as a provider
-- All channels should already be meta_cloud. Migrate any remaining.

-- 1. Deactivate any remaining Gupshup channels
UPDATE whatsapp_channels SET is_active = false WHERE provider = 'gupshup';

-- 2. Drop Gupshup-specific columns
ALTER TABLE whatsapp_channels DROP COLUMN IF EXISTS gupshup_api_key;
ALTER TABLE whatsapp_channels DROP COLUMN IF EXISTS gupshup_app_name;
ALTER TABLE whatsapp_channels DROP COLUMN IF EXISTS gupshup_app_id;

-- 3. Add constraint: only meta_cloud allowed for active channels
-- (Don't alter the enum — just add a CHECK on active channels)
ALTER TABLE whatsapp_channels
  ADD CONSTRAINT chk_active_provider_meta
  CHECK (is_active = false OR provider = 'meta_cloud');

-- 4. Set default provider to meta_cloud (if not already)
ALTER TABLE whatsapp_channels ALTER COLUMN provider SET DEFAULT 'meta_cloud';
