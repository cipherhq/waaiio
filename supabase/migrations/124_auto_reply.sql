-- ════════════════════════════════════════════════════════
-- Migration 124: Auto-reply & business hours for WhatsApp bot
-- Lets businesses set business hours and an away message
-- so customers know when the business is closed.
-- ════════════════════════════════════════════════════════

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS business_hours JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS away_message TEXT DEFAULT 'Thanks for your message! We''re currently closed. We''ll get back to you during business hours.',
  ADD COLUMN IF NOT EXISTS instant_reply_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS instant_reply_message TEXT DEFAULT 'Hi! Thanks for reaching out. We''ll be with you shortly.';
