-- Add custom_label column to business_capabilities
-- Allows businesses to rename bot menu option labels
ALTER TABLE business_capabilities ADD COLUMN IF NOT EXISTS custom_label TEXT;
