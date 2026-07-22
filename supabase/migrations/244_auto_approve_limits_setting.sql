-- ═══════════════════════════════════════════════════════
-- 244: Add auto_approve_limits to platform_settings
-- ═══════════════════════════════════════════════════════
-- Moves hardcoded auto-approve limits to database for admin control.
-- Values are in local currency minor units.

INSERT INTO public.platform_settings (key, value, description)
VALUES (
  'auto_approve_limits',
  '{"NG": 500000, "US": 1000, "GB": 800, "CA": 1000, "GH": 5000}'::jsonb,
  'Max auto-approve payout amount per country in MAJOR currency units. Payouts above this require manual admin approval.'
)
ON CONFLICT (key) DO NOTHING;
