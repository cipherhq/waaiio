-- ════════════════════════════════════════════════════════
-- Migration 127: Notification preferences for business owners
-- Lets businesses choose how they get notified about new sales
-- ════════════════════════════════════════════════════════

-- Add notification preferences to whatsapp_config (business-level settings)
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS notify_email_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_sound_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_whatsapp_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_whatsapp_phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS notify_monthly_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notify_month_reset DATE;

COMMENT ON COLUMN whatsapp_config.notify_email_enabled IS 'Send email notifications for new sales (free, default ON)';
COMMENT ON COLUMN whatsapp_config.notify_sound_enabled IS 'Play sound in dashboard for new sales (free, default ON)';
COMMENT ON COLUMN whatsapp_config.notify_whatsapp_enabled IS 'Send WhatsApp notifications for new sales (tier-gated, default OFF)';
COMMENT ON COLUMN whatsapp_config.notify_whatsapp_phone IS 'Personal WhatsApp number to receive sale notifications (NOT the WABA number)';
COMMENT ON COLUMN whatsapp_config.notify_monthly_count IS 'Number of WhatsApp notifications sent this month (resets monthly)';
COMMENT ON COLUMN whatsapp_config.notify_month_reset IS 'Date when notify_monthly_count was last reset';
