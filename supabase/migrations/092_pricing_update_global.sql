-- ═══════════════════════════════════════════════════════
-- 092: Global Pricing Update + India Launch
--
-- New pricing strategy based on competitor analysis:
-- US/UK/CA: $39-99/mo (was $17-50, underpriced vs WATI $59-279)
-- NG: ₦14,999-39,999/mo (slight increase)
-- GH: GH₵149-399 (slight increase)
-- IN: ₹999-2,999/mo (new market, competitive with AiSensy/Gallabox)
--
-- Pricing JSONB now includes feePercentage and trialDays per tier.
-- ═══════════════════════════════════════════════════════

-- Update Nigeria pricing
UPDATE countries SET pricing = '{
  "free": {"price": 0, "feeFlat": 150, "feePercentage": 2.5, "trialDays": 30},
  "growth": {"price": 14999, "feeFlat": 100, "feePercentage": 1.5, "trialDays": 30},
  "business": {"price": 39999, "feeFlat": 75, "feePercentage": 1.0, "trialDays": 30}
}'::jsonb WHERE code = 'NG';

-- Update US pricing
UPDATE countries SET pricing = '{
  "free": {"price": 0, "feeFlat": 0.50, "feePercentage": 2.5, "trialDays": 14},
  "growth": {"price": 39, "feeFlat": 0.40, "feePercentage": 1.5, "trialDays": 14},
  "business": {"price": 99, "feeFlat": 0.35, "feePercentage": 1.0, "trialDays": 14}
}'::jsonb WHERE code = 'US';

-- Update UK pricing
UPDATE countries SET pricing = '{
  "free": {"price": 0, "feeFlat": 0.35, "feePercentage": 2.5, "trialDays": 14},
  "growth": {"price": 29, "feeFlat": 0.30, "feePercentage": 1.5, "trialDays": 14},
  "business": {"price": 79, "feeFlat": 0.25, "feePercentage": 1.0, "trialDays": 14}
}'::jsonb WHERE code = 'GB';

-- Update Canada pricing
UPDATE countries SET pricing = '{
  "free": {"price": 0, "feeFlat": 0.50, "feePercentage": 2.5, "trialDays": 14},
  "growth": {"price": 39, "feeFlat": 0.40, "feePercentage": 1.5, "trialDays": 14},
  "business": {"price": 99, "feeFlat": 0.35, "feePercentage": 1.0, "trialDays": 14}
}'::jsonb WHERE code = 'CA';

-- Update Ghana pricing
UPDATE countries SET pricing = '{
  "free": {"price": 0, "feeFlat": 3, "feePercentage": 2.5, "trialDays": 30},
  "growth": {"price": 149, "feeFlat": 2, "feePercentage": 1.5, "trialDays": 30},
  "business": {"price": 399, "feeFlat": 1.50, "feePercentage": 1.0, "trialDays": 30}
}'::jsonb WHERE code = 'GH';

-- Add India 🇮🇳
INSERT INTO countries (code, name, flag, dialing_code, currency_code, currency_symbol, currency_locale, payment_gateway, phone_digits, phone_pattern, phone_placeholder, cities, pricing, verification_tiers, doc_types, is_active, sort_order)
VALUES (
  'IN', 'India', '🇮🇳', '+91', 'INR', '₹', 'en-IN', 'stripe', 10,
  '^[6-9]\d{9}$', '9876543210',
  '{"mumbai":{"name":"Mumbai","neighborhoods":["Andheri","Bandra","Juhu","Powai","Colaba","Dadar","Lower Parel","Malad"]},"delhi":{"name":"Delhi","neighborhoods":["Connaught Place","Karol Bagh","Saket","Hauz Khas","Dwarka","Rohini","Lajpat Nagar","Rajouri Garden"]},"bangalore":{"name":"Bangalore","neighborhoods":["Koramangala","Indiranagar","Whitefield","HSR Layout","Jayanagar","MG Road","Marathahalli","Electronic City"]},"hyderabad":{"name":"Hyderabad","neighborhoods":["Banjara Hills","Jubilee Hills","Madhapur","Gachibowli","Hitech City","Secunderabad","Kukatpally","Ameerpet"]},"chennai":{"name":"Chennai","neighborhoods":["T. Nagar","Anna Nagar","Adyar","Mylapore","Velachery","Porur","Nungambakkam","Guindy"]}}',
  '{"free":{"price":0,"feeFlat":10,"feePercentage":2.5,"trialDays":14},"growth":{"price":999,"feeFlat":5,"feePercentage":1.5,"trialDays":14},"business":{"price":2999,"feeFlat":3,"feePercentage":1.0,"trialDays":14}}',
  '{"unverified":{"label":"Unverified","limit":0,"requirements":"Just signed up"},"basic":{"label":"Basic","limit":50000,"requirements":"Email + Phone + Bank verified"},"standard":{"label":"Standard","limit":500000,"requirements":"+ Business document (GST/license)"},"full":{"label":"Full","limit":999999999,"requirements":"+ Government ID + Address proof"}}',
  '[{"key":"gst_certificate","label":"GST Certificate","desc":"GST registration certificate"},{"key":"business_license","label":"Shop & Establishment License","desc":"Municipal shop and establishment license"},{"key":"government_id","label":"Government ID","desc":"Aadhaar card, PAN card, or passport"},{"key":"utility_bill","label":"Utility Bill","desc":"Recent utility bill showing business address"},{"key":"incorporation_certificate","label":"Certificate of Incorporation","desc":"MCA incorporation certificate (for companies)"}]',
  true, 6
)
ON CONFLICT (code) DO UPDATE SET
  pricing = EXCLUDED.pricing,
  cities = EXCLUDED.cities,
  verification_tiers = EXCLUDED.verification_tiers,
  doc_types = EXCLUDED.doc_types,
  is_active = EXCLUDED.is_active;
