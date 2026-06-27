-- Add payout verification limits to platform_settings (single source of truth)
INSERT INTO platform_settings (key, value, description)
VALUES ('payout_verification_limits', '{"unverified": 0, "basic": 500000, "standard": 2000000, "full": 999999999}'::jsonb, 'Monthly payout limits per verification level (in local currency minor units). unverified=blocked, basic=500K, standard=2M, full=unlimited.')
ON CONFLICT (key) DO NOTHING;
