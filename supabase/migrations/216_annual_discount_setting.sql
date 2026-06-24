-- Make annual discount configurable via platform_settings
-- Default: 20 (meaning 20% off)
INSERT INTO platform_settings (key, value)
VALUES ('annual_discount_percentage', '20'::jsonb)
ON CONFLICT (key) DO NOTHING;
