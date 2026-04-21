-- ============================================================
-- 068: Platform Settings Config + Industry Config Seeding
-- Seeds pricing, broadcast, trial, and booking config into
-- platform_settings for dynamic management via admin panel.
-- Also seeds industry_config into category_templates.metadata.
-- ============================================================

-- 1. Public read policy so dashboard pages can read settings
CREATE POLICY "public_read_platform_settings" ON public.platform_settings
  FOR SELECT USING (true);

-- 2. Seed platform config keys
INSERT INTO public.platform_settings (key, value, description) VALUES
  (
    'pricing_tiers',
    '{
      "free":     { "feePercentage": 2.5, "feeFlat": 100, "maxBookings": 50,        "whitelabel": false },
      "growth":   { "feePercentage": 1.5, "feeFlat": 50,  "maxBookings": 500,       "whitelabel": false },
      "business": { "feePercentage": 1.0, "feeFlat": 50,  "maxBookings": 999999999, "whitelabel": true  }
    }'::jsonb,
    'Per-tier fee percentages, flat fees, booking limits, and whitelabel flag. Use 999999999 as sentinel for unlimited.'
  ),
  (
    'broadcast_limits',
    '{
      "free":     { "maxBroadcasts": 0,         "maxRecipients": 0         },
      "growth":   { "maxBroadcasts": 10,        "maxRecipients": 500       },
      "business": { "maxBroadcasts": 999999999, "maxRecipients": 999999999 }
    }'::jsonb,
    'Per-tier broadcast and recipient limits per month. Use 999999999 as sentinel for unlimited.'
  ),
  (
    'trial_days',
    '7'::jsonb,
    'Number of free trial days for new businesses.'
  ),
  (
    'booking_defaults',
    '{ "maxPartySize": 20, "maxAdvanceDays": 30, "reminderHours": [24, 2] }'::jsonb,
    'Default booking constraints: max party size, advance booking days, and reminder intervals in hours.'
  )
ON CONFLICT (key) DO NOTHING;

-- 3. Seed industry_config into category_templates.metadata
-- Merges an "industry_config" key into each template's existing metadata JSONB.

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "scheduling": { "askAllergies": true, "specialOccasionOptions": ["Birthday", "Anniversary", "Business Dinner", "Date Night"] }
}'::jsonb)
WHERE key = 'restaurant' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "scheduling": { "askTherapistPreference": true }
}'::jsonb)
WHERE key = 'spa' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "scheduling": { "askTherapistPreference": true }
}'::jsonb)
WHERE key = 'salon' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "scheduling": { "askPetType": true }
}'::jsonb)
WHERE key = 'veterinary' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "scheduling": { "askVehicleType": true }
}'::jsonb)
WHERE key = 'car_wash' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "payment": { "defaultCategories": ["Hourly Parking", "Daily Parking", "Monthly Pass"], "receiptWording": "Parking Payment" }
}'::jsonb)
WHERE key = 'car_park' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "payment": { "defaultCategories": ["Tithe", "Offering", "Building Fund", "Welfare"], "receiptWording": "Church Giving" }
}'::jsonb)
WHERE key = 'church' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "payment": { "defaultCategories": ["Zakat", "Sadaqah", "Fitrah"], "receiptWording": "Mosque Giving" }
}'::jsonb)
WHERE key = 'mosque' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "payment": { "defaultCategories": ["School Fees", "PTA Dues", "Exam Fees"], "receiptWording": "School Fee Payment" }
}'::jsonb)
WHERE key = 'school' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "payment": { "defaultCategories": ["Utility Bill", "Application Fee", "Tax Payment"], "receiptWording": "Government Payment" }
}'::jsonb)
WHERE key = 'government' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "payment": { "defaultCategories": ["Ride Payment"], "receiptWording": "Ride Payment" }
}'::jsonb)
WHERE key = 'taxi' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "ordering": { "deliveryOptions": ["delivery", "pickup"], "askDeliveryAddress": true }
}'::jsonb)
WHERE key = 'food_delivery' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "ordering": { "deliveryOptions": ["delivery", "pickup"], "askDeliveryAddress": true }
}'::jsonb)
WHERE key = 'shop' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "ordering": { "deliveryOptions": ["delivery"], "askDeliveryAddress": true }
}'::jsonb)
WHERE key = 'instagram_vendor' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "ordering": { "deliveryOptions": ["pickup"], "askDeliveryAddress": false }
}'::jsonb)
WHERE key = 'mall_vendor' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "ordering": { "deliveryOptions": ["delivery", "pickup"], "askDeliveryAddress": true }
}'::jsonb)
WHERE key = 'pharmacy' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "ordering": { "deliveryOptions": ["delivery"], "askDeliveryAddress": true }
}'::jsonb)
WHERE key = 'catering' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "ordering": { "deliveryOptions": ["pickup"], "askDeliveryAddress": false }
}'::jsonb)
WHERE key = 'tailor' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

UPDATE public.category_templates SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('industry_config', '{
  "ordering": { "deliveryOptions": ["delivery"], "askDeliveryAddress": true }
}'::jsonb)
WHERE key = 'logistics' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'industry_config');

