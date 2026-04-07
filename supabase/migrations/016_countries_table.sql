-- 016_countries_table.sql
-- Admin-managed global country configuration

CREATE TABLE IF NOT EXISTS countries (
  code         VARCHAR(4) PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  flag         VARCHAR(10) NOT NULL DEFAULT '',
  dialing_code VARCHAR(10) NOT NULL,
  currency_code VARCHAR(3) NOT NULL,
  currency_symbol VARCHAR(10) NOT NULL,
  currency_locale VARCHAR(10) NOT NULL DEFAULT 'en-US',
  payment_gateway VARCHAR(20) NOT NULL DEFAULT 'stripe',
  phone_digits SMALLINT NOT NULL DEFAULT 10,
  phone_pattern TEXT NOT NULL DEFAULT '',
  phone_placeholder VARCHAR(20) NOT NULL DEFAULT '',
  cities       JSONB NOT NULL DEFAULT '{}',
  pricing      JSONB NOT NULL DEFAULT '{}',
  verification_tiers JSONB NOT NULL DEFAULT '{}',
  doc_types    JSONB NOT NULL DEFAULT '[]',
  is_active    BOOLEAN NOT NULL DEFAULT true,
  sort_order   SMALLINT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID REFERENCES auth.users(id)
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_countries_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_countries_updated_at
  BEFORE UPDATE ON countries
  FOR EACH ROW
  EXECUTE FUNCTION update_countries_updated_at();

-- RLS
ALTER TABLE countries ENABLE ROW LEVEL SECURITY;

-- Anyone can read active countries
CREATE POLICY countries_read_active ON countries
  FOR SELECT USING (is_active = true);

-- Admins can do everything
CREATE POLICY countries_admin_all ON countries
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Seed with current 5 countries
INSERT INTO countries (code, name, flag, dialing_code, currency_code, currency_symbol, currency_locale, payment_gateway, phone_digits, phone_pattern, phone_placeholder, cities, pricing, verification_tiers, doc_types, is_active, sort_order)
VALUES
  (
    'NG', 'Nigeria', '🇳🇬', '+234', 'NGN', '₦', 'en-NG', 'paystack', 10,
    '^[789]\d{9}$', '8012345678',
    '{"lagos":{"name":"Lagos","neighborhoods":["Victoria Island","Ikoyi","Lekki Phase 1","Lekki Phase 2","Ikeja GRA","Yaba","Surulere","Ajah","Maryland","Magodo"]},"abuja":{"name":"Abuja","neighborhoods":["Wuse","Wuse 2","Maitama","Garki","Asokoro","Jabi","Gwarinpa","Utako","Central Area","Katampe"]},"port_harcourt":{"name":"Port Harcourt","neighborhoods":["GRA Phase 1","GRA Phase 2","Trans-Amadi","Old GRA","Rumuola","Elekahia","Rumuokwurusi","Peter Odili Road"]}}',
    '{"free":{"price":0,"feeFlat":100},"growth":{"price":15000,"feeFlat":50},"business":{"price":50000,"feeFlat":50}}',
    '{"unverified":{"label":"Unverified","limit":0,"requirements":"Just signed up"},"basic":{"label":"Basic","limit":500000,"requirements":"Email + Phone + Bank verified"},"standard":{"label":"Standard","limit":5000000,"requirements":"+ Business document (CAC/license)"},"full":{"label":"Full","limit":999999999,"requirements":"+ Government ID + Address proof"}}',
    '[{"key":"cac_certificate","label":"CAC Certificate","desc":"Certificate of incorporation from CAC"},{"key":"business_license","label":"Business License","desc":"State or local business license"},{"key":"government_id","label":"Government ID","desc":"National ID, voter''s card, or driver''s license"},{"key":"utility_bill","label":"Utility Bill","desc":"Recent utility bill showing business address"},{"key":"tin_certificate","label":"TIN Certificate","desc":"Tax Identification Number certificate"}]',
    true, 1
  ),
  (
    'US', 'United States', '🇺🇸', '+1', 'USD', '$', 'en-US', 'stripe', 10,
    '^[2-9]\d{9}$', '2025551234',
    '{"new_york":{"name":"New York","neighborhoods":["Manhattan","Brooklyn","Queens","Bronx","Harlem","SoHo","Williamsburg","Astoria"]},"los_angeles":{"name":"Los Angeles","neighborhoods":["Hollywood","Beverly Hills","Santa Monica","Venice","Downtown","Silver Lake","Koreatown","Culver City"]},"houston":{"name":"Houston","neighborhoods":["Downtown","Midtown","Heights","Montrose","River Oaks","Galleria","Third Ward","Sugar Land"]},"atlanta":{"name":"Atlanta","neighborhoods":["Buckhead","Midtown","Downtown","Decatur","East Atlanta","West End","Sandy Springs","Marietta"]}}',
    '{"free":{"price":0,"feeFlat":0.50},"growth":{"price":15,"feeFlat":0.25},"business":{"price":50,"feeFlat":0.25}}',
    '{"unverified":{"label":"Unverified","limit":0,"requirements":"Just signed up"},"basic":{"label":"Basic","limit":5000,"requirements":"Email + Phone + Bank verified"},"standard":{"label":"Standard","limit":50000,"requirements":"+ Business document (EIN/license)"},"full":{"label":"Full","limit":999999999,"requirements":"+ Government ID + Address proof"}}',
    '[{"key":"ein_letter","label":"EIN Letter","desc":"IRS EIN confirmation letter (CP 575)"},{"key":"business_license","label":"Business License","desc":"State or local business license"},{"key":"government_id","label":"Government ID","desc":"Driver''s license, passport, or state ID"},{"key":"utility_bill","label":"Utility Bill","desc":"Recent utility bill showing business address"},{"key":"articles_of_incorporation","label":"Articles of Incorporation","desc":"State-filed articles of incorporation"}]',
    true, 2
  ),
  (
    'GB', 'United Kingdom', '🇬🇧', '+44', 'GBP', '£', 'en-GB', 'stripe', 10,
    '^7\d{9}$', '7911123456',
    '{"london":{"name":"London","neighborhoods":["Shoreditch","Brixton","Peckham","Camden","Hackney","Dalston","Tottenham","Lewisham"]},"manchester":{"name":"Manchester","neighborhoods":["Northern Quarter","Chorlton","Didsbury","Ancoats","Rusholme","Moss Side","Salford","Withington"]},"birmingham":{"name":"Birmingham","neighborhoods":["City Centre","Edgbaston","Moseley","Handsworth","Erdington","Selly Oak","Aston","Digbeth"]}}',
    '{"free":{"price":0,"feeFlat":0.40},"growth":{"price":12,"feeFlat":0.20},"business":{"price":40,"feeFlat":0.20}}',
    '{"unverified":{"label":"Unverified","limit":0,"requirements":"Just signed up"},"basic":{"label":"Basic","limit":4000,"requirements":"Email + Phone + Bank verified"},"standard":{"label":"Standard","limit":40000,"requirements":"+ Business document (Companies House/license)"},"full":{"label":"Full","limit":999999999,"requirements":"+ Government ID + Address proof"}}',
    '[{"key":"companies_house","label":"Companies House Certificate","desc":"Certificate of incorporation from Companies House"},{"key":"business_license","label":"Business License","desc":"Local authority business license"},{"key":"government_id","label":"Government ID","desc":"Passport or UK driving licence"},{"key":"utility_bill","label":"Utility Bill","desc":"Recent utility bill showing business address"},{"key":"hmrc_registration","label":"HMRC Registration","desc":"HMRC tax registration document"}]',
    true, 3
  ),
  (
    'CA', 'Canada', '🇨🇦', '+1', 'CAD', 'CA$', 'en-CA', 'stripe', 10,
    '^[2-9]\d{9}$', '4165551234',
    '{"toronto":{"name":"Toronto","neighborhoods":["Downtown","Scarborough","North York","Etobicoke","Brampton","Mississauga","Yorkville","Liberty Village"]},"calgary":{"name":"Calgary","neighborhoods":["Downtown","Beltline","Kensington","Inglewood","Bridgeland","Mission","Bowness","NE Calgary"]},"vancouver":{"name":"Vancouver","neighborhoods":["Downtown","Kitsilano","Gastown","Mount Pleasant","Commercial Drive","Burnaby","Richmond","Surrey"]}}',
    '{"free":{"price":0,"feeFlat":0.50},"growth":{"price":20,"feeFlat":0.25},"business":{"price":65,"feeFlat":0.25}}',
    '{"unverified":{"label":"Unverified","limit":0,"requirements":"Just signed up"},"basic":{"label":"Basic","limit":7000,"requirements":"Email + Phone + Bank verified"},"standard":{"label":"Standard","limit":70000,"requirements":"+ Business document (BN/license)"},"full":{"label":"Full","limit":999999999,"requirements":"+ Government ID + Address proof"}}',
    '[{"key":"bn_certificate","label":"Business Number Certificate","desc":"CRA Business Number registration"},{"key":"business_license","label":"Business License","desc":"Provincial or municipal business license"},{"key":"government_id","label":"Government ID","desc":"Driver''s licence, passport, or provincial ID"},{"key":"utility_bill","label":"Utility Bill","desc":"Recent utility bill showing business address"},{"key":"articles_of_incorporation","label":"Articles of Incorporation","desc":"Federal or provincial incorporation docs"}]',
    true, 4
  ),
  (
    'GH', 'Ghana', '🇬🇭', '+233', 'GHS', 'GH₵', 'en-GH', 'paystack', 9,
    '^[2-9]\d{8}$', '241234567',
    '{"accra":{"name":"Accra","neighborhoods":["East Legon","Osu","Labone","Airport Residential","Cantonments","Dzorwulu","Spintex","Madina"]},"kumasi":{"name":"Kumasi","neighborhoods":["Adum","Bantama","Ashtown","Ahodwo","Danyame","Nhyiaeso","Suame","Tafo"]},"tema":{"name":"Tema","neighborhoods":["Community 1","Community 5","Community 25","Sakumono","Nungua","Kpone","Ashaiman","Baatsona"]}}',
    '{"free":{"price":0,"feeFlat":5},"growth":{"price":150,"feeFlat":2},"business":{"price":500,"feeFlat":2}}',
    '{"unverified":{"label":"Unverified","limit":0,"requirements":"Just signed up"},"basic":{"label":"Basic","limit":50000,"requirements":"Email + Phone + Bank verified"},"standard":{"label":"Standard","limit":500000,"requirements":"+ Business document (RGD certificate/license)"},"full":{"label":"Full","limit":999999999,"requirements":"+ Government ID + Address proof"}}',
    '[{"key":"rgd_certificate","label":"RGD Certificate","desc":"Registrar General''s Department certificate"},{"key":"business_license","label":"Business License","desc":"District assembly business license"},{"key":"government_id","label":"Government ID","desc":"Ghana Card, passport, or voter''s ID"},{"key":"utility_bill","label":"Utility Bill","desc":"Recent utility bill showing business address"},{"key":"tin_certificate","label":"TIN Certificate","desc":"GRA Tax Identification Number certificate"}]',
    true, 5
  )
ON CONFLICT (code) DO NOTHING;
