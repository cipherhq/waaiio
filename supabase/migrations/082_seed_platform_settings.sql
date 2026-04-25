-- Seed platform_settings with all configurable values
-- These override the hardcoded defaults in constants.ts

INSERT INTO platform_settings (key, value, description) VALUES
(
  'pricing_tiers',
  '{"free":{"feePercentage":2.5,"feeFlat":0.5,"maxBookings":50,"whitelabel":false},"growth":{"feePercentage":1.5,"feeFlat":0.25,"maxBookings":500,"whitelabel":false},"business":{"feePercentage":1.0,"feeFlat":0.25,"maxBookings":999999999,"whitelabel":true}}',
  'Per-tier transaction fees, booking limits, and whitelabel access'
),
(
  'broadcast_limits',
  '{"free":{"maxBroadcasts":0,"maxRecipients":0},"growth":{"maxBroadcasts":10,"maxRecipients":500},"business":{"maxBroadcasts":999999999,"maxRecipients":999999999}}',
  'Per-tier broadcast sending limits (monthly)'
),
(
  'conversation_limits',
  '{"free":200,"growth":1000,"business":999999999}',
  'Per-tier WhatsApp conversation limits (monthly). Waaiio pays Meta, cost included in platform fee.'
),
(
  'trial_days',
  '7',
  'Number of free trial days for new businesses (0% fees during trial)'
),
(
  'booking_defaults',
  '{"maxPartySize":20,"maxAdvanceDays":90,"reminderHours":[24]}',
  'Default booking configuration for new businesses'
)
ON CONFLICT (key) DO NOTHING;
