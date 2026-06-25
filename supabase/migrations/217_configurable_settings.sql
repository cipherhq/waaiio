-- ============================================================
-- 217: Configurable Settings — New settings + rich descriptions
-- Adds new platform_settings rows for operational limits and
-- updates ALL existing settings with detailed descriptions
-- including units, formats, and valid ranges.
-- ============================================================

-- --------------------------------------------------------
-- 1. Insert NEW configurable settings
-- --------------------------------------------------------
INSERT INTO platform_settings (key, value, description) VALUES
(
  'transfer_expiry_hours',
  '4'::jsonb,
  'Hours before a pending bank transfer expires and booking is cancelled. Default: 4 hours.'
),
(
  'payout_cooling_period_days',
  '7'::jsonb,
  'Days a new business must wait before first payout. Prevents fraud on new accounts. Default: 7 days.'
),
(
  'minimum_payout',
  '{"NG": 5000, "US": 2500, "GB": 2000, "CA": 2500, "GH": 50}'::jsonb,
  'Minimum payout amount per country (in local currency minor units). Below this, payout is held until next period. Format: {"NG": 5000, "US": 2500, ...}'
),
(
  'fraud_velocity_threshold',
  '50'::jsonb,
  'Max transactions per day before flagging a business for fraud review. Default: 50/day.'
),
(
  'default_platform_fee_percent',
  '2.5'::jsonb,
  'Default platform fee percentage used as fallback when tier-specific fee is not available. Default: 2.5%.'
),
(
  'bot_rate_limit_per_minute',
  '20'::jsonb,
  'Max WhatsApp messages per minute per phone number. Excess silently dropped. Prevents bot spam burning AI/WhatsApp costs. Default: 20/min.'
),
(
  'max_businesses_per_user',
  '20'::jsonb,
  'Max businesses a single user can create. Prevents trial abuse. Enterprise users may need more — contact support. Default: 20.'
),
(
  'ocr_confidence_threshold',
  '0.7'::jsonb,
  'Minimum AI confidence score (0.0-1.0) to accept a receipt scan as matching. Higher = fewer false positives but more manual reviews. Default: 0.7.'
),
(
  'invoice_expiry_days',
  '30'::jsonb,
  'Days before an unpaid invoice link expires. Default: 30 days.'
),
(
  'contract_signing_hours',
  '72'::jsonb,
  'Hours before a contract/document signing link expires. Some industries (legal, real estate) may need longer. Default: 72 hours (3 days).'
),
(
  'abuse_cooldown_soft_minutes',
  '5'::jsonb,
  'Minutes of soft cooldown after a customer sends 5+ gibberish messages. Bot stops responding temporarily. Default: 5 minutes.'
),
(
  'abuse_cooldown_hard_minutes',
  '30'::jsonb,
  'Minutes of hard cooldown after a customer sends 5+ profane messages. Longer penalty. Default: 30 minutes.'
)
ON CONFLICT (key) DO NOTHING;

-- --------------------------------------------------------
-- 2. Update descriptions for ALL existing settings
-- --------------------------------------------------------

-- From migration 012 (admin_expansion)
UPDATE platform_settings SET description = 'Legacy default platform fee percentage. Superseded by pricing_tiers per-tier fees. Kept for backward compatibility.' WHERE key = 'platform_fee_percentage';
UPDATE platform_settings SET description = 'Array of active ISO 3166-1 alpha-2 country codes. Only these countries appear in onboarding and payment gateway selection. Format: ["NG","GH","US","UK","CA"].' WHERE key = 'supported_countries';
UPDATE platform_settings SET description = 'Map of country code to ISO 4217 currency code. Used by payment gateways and invoice formatting. Format: {"NG":"NGN","GH":"GHS",...}.' WHERE key = 'supported_currencies';
UPDATE platform_settings SET description = 'When true, all public pages show maintenance banner and API routes return 503. Dashboard remains accessible for admins. Boolean.' WHERE key = 'maintenance_mode';
UPDATE platform_settings SET description = 'Minimum client app version required. Clients below this version see a forced-update screen. Semver string, e.g. "1.0.0".' WHERE key = 'min_app_version';
UPDATE platform_settings SET description = 'Current Terms of Service version string. When bumped, users see a re-acceptance prompt on next login. Semver string, e.g. "1.0".' WHERE key = 'terms_version';
UPDATE platform_settings SET description = 'Current Privacy Policy version string. When bumped, users see a re-acceptance prompt on next login. Semver string, e.g. "1.0".' WHERE key = 'privacy_version';
UPDATE platform_settings SET description = 'Primary support email shown in error pages, bot fallback messages, and footer. String.' WHERE key = 'support_email';
UPDATE platform_settings SET description = 'Max active bot sessions allowed per business per month. Prevents runaway AI costs. Default: 1000. Integer.' WHERE key = 'max_bot_sessions_per_business';

-- From migration 068 (platform_settings_config) / 082 (seed)
UPDATE platform_settings SET description = 'Platform fee percentage per tier. Format: {"free": {"feePercentage": 2.5, "feeFlat": 0, "maxBookings": 50, "whitelabel": false}, ...}. feeFlat is in local currency minor units. Use 999999999 as sentinel for unlimited.' WHERE key = 'pricing_tiers';
UPDATE platform_settings SET description = 'Max broadcasts and recipients per tier per month. Format: {"free": {"maxBroadcasts": 0, "maxRecipients": 0}, ...}. Use 999999999 as sentinel for unlimited.' WHERE key = 'broadcast_limits';
UPDATE platform_settings SET description = 'Max WhatsApp conversations per tier per month. Waaiio pays Meta — cost included in platform fee. Format: {"free": 200, "growth": 1000, "business": 999999999}.' WHERE key = 'conversation_limits';
UPDATE platform_settings SET description = 'Number of days for free trial. All features unlocked during trial, 0% platform fees. Integer. Default: 7.' WHERE key = 'trial_days';
UPDATE platform_settings SET description = 'Default booking settings: max party size (integer), max advance booking days (integer), reminder hours before appointment (array of integers). Format: {"maxPartySize": 20, "maxAdvanceDays": 90, "reminderHours": [24]}.' WHERE key = 'booking_defaults';

-- From migration 086 (admin_content_settings)
UPDATE platform_settings SET description = 'Landing page hero section content. Format: {"badge": "...", "headline": "...", "subheadline": "..."}. Supports plain text only, no HTML.' WHERE key = 'hero_content';
UPDATE platform_settings SET description = 'Contact email addresses shown on contact and legal pages. Format: {"general": "...", "dpo": "...", "abuse": "...", "privacy": "..."}.' WHERE key = 'contact_emails';
UPDATE platform_settings SET description = 'Social media profile URLs displayed in website footer. Format: {"twitter": "", "linkedin": "", "instagram": "", "facebook": "", "whatsapp": ""}. Empty string hides the icon.' WHERE key = 'social_links';
UPDATE platform_settings SET description = 'Shared WhatsApp numbers per country for Starter/Free tier businesses. Format: {"NG": "12029226251", ...}. Must be valid E.164 numbers without the + prefix.' WHERE key = 'whatsapp_shared_numbers';
UPDATE platform_settings SET description = 'Default bot greeting messages per business category. Use {name} placeholder for business name. Format: {"barber": "Welcome to {name}! ...", "default": "..."}. Falls back to "default" key.' WHERE key = 'default_greetings';
UPDATE platform_settings SET description = 'Array of business UUIDs to pin/feature at top of the public directory listing. Format: ["uuid1", "uuid2"]. Empty array means no pinned businesses.' WHERE key = 'directory_featured';
UPDATE platform_settings SET description = 'Array of business UUIDs to hide from the public directory. Hidden businesses are still accessible via direct link. Format: ["uuid1"]. Empty array means nothing hidden.' WHERE key = 'directory_hidden';

-- From migration 216 (annual_discount_setting)
UPDATE platform_settings SET description = 'Annual billing discount percentage. 20 means 20% off yearly plans. Annual price = monthly * 12 * (1 - discount/100). Integer, range 0-100. Default: 20.' WHERE key = 'annual_discount_percentage';
