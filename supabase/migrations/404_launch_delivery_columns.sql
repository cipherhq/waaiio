-- #397: Add delivery-tracking columns to launch_subscribers.
-- Enables idempotent per-campaign delivery, provider message tracking, and error diagnostics.

-- campaign_version: prevents double-send when admin retries or launches a new campaign.
-- One notification per subscriber per campaign_version.
ALTER TABLE launch_subscribers
  ADD COLUMN IF NOT EXISTS campaign_version TEXT,
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS delivery_error TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- Index for efficient delivery queries
CREATE INDEX IF NOT EXISTS idx_launch_subscribers_delivery
  ON launch_subscribers(opt_in_status, notification_status, campaign_version);

-- Unique constraint: one delivery per subscriber per campaign
CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_subscribers_campaign_unique
  ON launch_subscribers(wa_number, campaign_version) WHERE campaign_version IS NOT NULL;

-- Seed configurable launch notification settings
INSERT INTO public.platform_settings (key, value, description)
VALUES (
  'launch_notification_config',
  '{"template_name": "waaiio_launch_alert", "template_language": "en_US", "template_params": ["Waaiio"], "campaign_version": "v1"}'::jsonb,
  'Launch notification template config. template_name/language must match an approved Meta template. campaign_version prevents double-send.'
)
ON CONFLICT (key) DO NOTHING;
