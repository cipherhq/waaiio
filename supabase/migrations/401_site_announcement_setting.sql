-- #395: Seed site_announcement key in platform_settings.
-- This is a separate informational system — it does NOT affect
-- the existing maintenance_mode key or WhatsApp/payment behavior.

INSERT INTO public.platform_settings (key, value, description)
VALUES (
  'site_announcement',
  '{"enabled": false, "type": "launch_countdown", "headline": "", "message": "", "target_date": null, "cta_text": null, "cta_link": null, "style": "brand"}'::jsonb,
  'Public site announcement/countdown banner. Informational only — does not disable any runtime capabilities.'
)
ON CONFLICT (key) DO NOTHING;
