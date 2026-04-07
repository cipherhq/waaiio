-- ═══════════════════════════════════════════════════════
-- Migration 008: Composable Capabilities Architecture
-- ═══════════════════════════════════════════════════════

-- 1. Add new values to business_category enum
DO $$
BEGIN
  -- Only add values that don't already exist
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'car_park' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'car_park';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'tattoo' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'tattoo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'real_estate' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'real_estate';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'travel_agency' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'travel_agency';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'logistics' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'logistics';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'taxi' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'taxi';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'government' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'government';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'instagram_vendor' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'instagram_vendor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'crowdfunding_org' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'crowdfunding_org';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'laundry' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'laundry';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'veterinary' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'veterinary';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'dental' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'dental';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'coworking' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'coworking';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'tutor' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'tutor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'photographer' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'photographer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'mall_vendor' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'mall_vendor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'pharmacy' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'pharmacy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'hotel' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'hotel';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'car_wash' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'car_wash';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'catering' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'catering';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'funeral' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'funeral';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'tailor' AND enumtypid = 'business_category'::regtype) THEN
    ALTER TYPE business_category ADD VALUE 'tailor';
  END IF;
END$$;

-- 2. Create capability_type enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'capability_type') THEN
    CREATE TYPE capability_type AS ENUM (
      'scheduling', 'payment', 'ordering', 'ticketing', 'reminders', 'crowdfunding'
    );
  END IF;
END$$;

-- 3. Create business_capabilities table
CREATE TABLE IF NOT EXISTS business_capabilities (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  capability capability_type NOT NULL,
  is_enabled boolean DEFAULT true NOT NULL,
  config jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(business_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_business_capabilities_business_id ON business_capabilities(business_id);
CREATE INDEX IF NOT EXISTS idx_business_capabilities_enabled ON business_capabilities(business_id) WHERE is_enabled = true;

-- 4. Add payment_gateway column to businesses table
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'businesses' AND column_name = 'payment_gateway') THEN
    ALTER TABLE businesses ADD COLUMN payment_gateway varchar(20);
  END IF;
END$$;

-- 5. Create campaigns table (for crowdfunding capability)
CREATE TABLE IF NOT EXISTS campaigns (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  goal_amount numeric(12,2) NOT NULL DEFAULT 0,
  raised_amount numeric(12,2) NOT NULL DEFAULT 0,
  currency varchar(3) DEFAULT 'NGN',
  start_date date,
  end_date date,
  status varchar(20) DEFAULT 'active' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
  image_url text,
  donor_count integer DEFAULT 0,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_campaigns_business_id ON campaigns(business_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- 6. Create category_definitions table (admin-managed categories)
CREATE TABLE IF NOT EXISTS category_definitions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  key varchar(50) NOT NULL UNIQUE,
  label varchar(100) NOT NULL,
  icon varchar(10),
  description text,
  default_capabilities jsonb DEFAULT '[]'::jsonb,
  is_system boolean DEFAULT false NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- 7. Auto-migrate existing businesses: create capability rows from flow_type
INSERT INTO business_capabilities (business_id, capability, is_enabled)
SELECT b.id, cap.capability, true
FROM businesses b
CROSS JOIN LATERAL (
  SELECT unnest(CASE b.flow_type
    WHEN 'scheduling' THEN ARRAY['scheduling']::capability_type[]
    WHEN 'payment' THEN ARRAY['payment']::capability_type[]
    WHEN 'ordering' THEN ARRAY['ordering']::capability_type[]
    WHEN 'ticketing' THEN ARRAY['ticketing']::capability_type[]
    ELSE ARRAY['scheduling']::capability_type[]
  END) AS capability
) cap
WHERE NOT EXISTS (
  SELECT 1 FROM business_capabilities bc
  WHERE bc.business_id = b.id AND bc.capability = cap.capability
);

-- 8. Seed category_definitions with all built-in categories
INSERT INTO category_definitions (key, label, icon, description, default_capabilities, is_system, sort_order) VALUES
  ('restaurant', 'Restaurant', '🍽️', 'Restaurants and dining', '["scheduling"]', true, 1),
  ('barber', 'Barbershop', '💈', 'Barbershops and grooming', '["scheduling"]', true, 2),
  ('spa', 'Spa', '🧖', 'Spas and wellness', '["scheduling"]', true, 3),
  ('salon', 'Hair Salon', '💇', 'Hair salons and styling', '["scheduling"]', true, 4),
  ('gym', 'Gym / Fitness', '🏋️', 'Gyms and fitness centers', '["scheduling"]', true, 5),
  ('clinic', 'Clinic / Hospital', '🏥', 'Clinics and hospitals', '["scheduling"]', true, 6),
  ('consultant', 'Consultant', '💼', 'Consultants and advisors', '["scheduling"]', true, 7),
  ('church', 'Church', '⛪', 'Churches and ministries', '["payment"]', true, 8),
  ('mosque', 'Mosque', '🕌', 'Mosques and Islamic centers', '["payment"]', true, 9),
  ('school', 'School', '🎓', 'Schools and education', '["payment"]', true, 10),
  ('ngo', 'NGO / Charity', '🤝', 'NGOs and charities', '["payment"]', true, 11),
  ('shop', 'Shop / Retail', '🛍️', 'Shops and retail stores', '["ordering"]', true, 12),
  ('food_delivery', 'Food Delivery', '🛵', 'Food delivery services', '["ordering"]', true, 13),
  ('events', 'Events', '🎪', 'Event venues and organizers', '["ticketing"]', true, 14),
  ('transport', 'Transport', '🚌', 'Transportation services', '["ticketing"]', true, 15),
  ('cinema', 'Cinema', '🎬', 'Cinemas and movie theaters', '["ticketing"]', true, 16),
  ('car_park', 'Parking', '🅿️', 'Parking lots and garages', '["payment"]', true, 17),
  ('tattoo', 'Tattoo Shop', '🎨', 'Tattoo and piercing studios', '["scheduling", "payment"]', true, 18),
  ('real_estate', 'Real Estate', '🏠', 'Real estate agencies', '["scheduling", "payment"]', true, 19),
  ('travel_agency', 'Travel Agency', '✈️', 'Travel and tour agencies', '["scheduling", "payment", "ticketing"]', true, 20),
  ('logistics', 'Logistics & Shipping', '🚚', 'Logistics and delivery', '["ordering", "payment"]', true, 21),
  ('taxi', 'Taxi & Ride-Hailing', '🚕', 'Taxi and ride services', '["payment"]', true, 22),
  ('government', 'Government & Utilities', '🏛️', 'Government offices and utilities', '["payment"]', true, 23),
  ('instagram_vendor', 'Online Vendor', '🛒', 'Online and social media vendors', '["ordering"]', true, 24),
  ('crowdfunding_org', 'Crowdfunding', '❤️', 'Crowdfunding organizations', '["crowdfunding", "payment"]', true, 25),
  ('laundry', 'Laundry & Dry Cleaning', '👔', 'Laundry and dry cleaning', '["scheduling", "ordering"]', true, 26),
  ('veterinary', 'Veterinary', '🐾', 'Veterinary clinics', '["scheduling", "payment"]', true, 27),
  ('dental', 'Dental Clinic', '🦷', 'Dental clinics', '["scheduling", "payment", "reminders"]', true, 28),
  ('coworking', 'Coworking Space', '🏢', 'Coworking and shared offices', '["scheduling", "payment"]', true, 29),
  ('tutor', 'Tutor & Coaching', '📚', 'Tutoring and coaching', '["scheduling", "payment"]', true, 30),
  ('photographer', 'Photographer', '📷', 'Photography services', '["scheduling", "payment"]', true, 31),
  ('mall_vendor', 'Mall Vendor', '🏪', 'Mall and market vendors', '["payment", "ordering"]', true, 32),
  ('pharmacy', 'Pharmacy', '💊', 'Pharmacies', '["ordering", "payment"]', true, 33),
  ('hotel', 'Hotel & Lodge', '🛏️', 'Hotels and lodges', '["scheduling", "payment"]', true, 34),
  ('car_wash', 'Car Wash', '🚿', 'Car wash services', '["scheduling", "payment"]', true, 35),
  ('catering', 'Catering', '🍳', 'Catering services', '["ordering", "payment"]', true, 36),
  ('funeral', 'Funeral Services', '🌺', 'Funeral and memorial services', '["payment", "scheduling"]', true, 37),
  ('tailor', 'Tailor & Fashion', '✂️', 'Tailoring and fashion design', '["ordering", "scheduling", "payment"]', true, 38),
  ('other', 'Other (Custom)', '🔧', 'Other business types', '["scheduling"]', true, 99)
ON CONFLICT (key) DO NOTHING;

-- 9. RLS Policies

-- business_capabilities: owners can read/write their own
ALTER TABLE business_capabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "business_capabilities_owner_select" ON business_capabilities
  FOR SELECT USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

CREATE POLICY "business_capabilities_owner_insert" ON business_capabilities
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

CREATE POLICY "business_capabilities_owner_update" ON business_capabilities
  FOR UPDATE USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

CREATE POLICY "business_capabilities_owner_delete" ON business_capabilities
  FOR DELETE USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- campaigns: owners can CRUD their own
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "campaigns_owner_select" ON campaigns
  FOR SELECT USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

CREATE POLICY "campaigns_owner_insert" ON campaigns
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

CREATE POLICY "campaigns_owner_update" ON campaigns
  FOR UPDATE USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

CREATE POLICY "campaigns_owner_delete" ON campaigns
  FOR DELETE USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- category_definitions: public read, admin write
ALTER TABLE category_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "category_definitions_public_read" ON category_definitions
  FOR SELECT USING (true);

-- Service role bypass for auto-migration inserts
CREATE POLICY "business_capabilities_service_insert" ON business_capabilities
  FOR INSERT WITH CHECK (true);

-- Updated_at triggers
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_business_capabilities_updated_at') THEN
    CREATE TRIGGER trg_business_capabilities_updated_at
      BEFORE UPDATE ON business_capabilities
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_campaigns_updated_at') THEN
    CREATE TRIGGER trg_campaigns_updated_at
      BEFORE UPDATE ON campaigns
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_category_definitions_updated_at') THEN
    CREATE TRIGGER trg_category_definitions_updated_at
      BEFORE UPDATE ON category_definitions
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END$$;
