-- ═══════════════════════════════════════════════════════
-- Migration 414: Seed signup_open platform setting
--
-- Admin-controlled public signup gate (#453).
-- Defaults to false (closed) — Owner/Admin opens via
-- platform_settings when ready for public launch.
-- ═══════════════════════════════════════════════════════

INSERT INTO public.platform_settings (key, value, description)
VALUES (
  'signup_open',
  'false'::jsonb,
  'Whether new public account creation is allowed. Set to true to open public signup at launch.'
)
ON CONFLICT (key) DO NOTHING;
