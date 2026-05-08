-- ═══════════════════════════════════════════════════════
-- Properties table: dedicated accommodation units
-- Replaces services table for reservation categories
-- (shortlet, hotel, car_rental)
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  description text,
  property_type varchar(50) NOT NULL DEFAULT 'apartment',
  price numeric NOT NULL DEFAULT 0,
  price_is_variable boolean NOT NULL DEFAULT false,
  deposit_amount numeric NOT NULL DEFAULT 0,
  max_guests integer NOT NULL DEFAULT 1,
  bedrooms integer NOT NULL DEFAULT 0,
  bathrooms integer NOT NULL DEFAULT 0,
  amenities text[] NOT NULL DEFAULT '{}',
  photos text[] NOT NULL DEFAULT '{}',
  address text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_properties_business ON properties(business_id);

-- Auto-update updated_at
CREATE OR REPLACE TRIGGER properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY properties_owner_select ON properties FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY properties_owner_insert ON properties FOR INSERT
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY properties_owner_update ON properties FOR UPDATE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY properties_owner_delete ON properties FOR DELETE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY properties_service_all ON properties FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Add property_id to reservations (keep service_id for backward compat)
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_property ON reservations(property_id);

-- Migrate existing service-based apartments to properties
-- Uses same UUID so existing reservations.service_id values match properties.id
INSERT INTO properties (id, business_id, name, description, price, price_is_variable, deposit_amount, is_active, sort_order, metadata, created_at, updated_at)
SELECT s.id, s.business_id, s.name, s.description, s.price, s.price_is_variable, COALESCE(s.deposit_amount, 0), s.is_active, s.sort_order, COALESCE(s.metadata, '{}'::jsonb), s.created_at, s.updated_at
FROM services s
JOIN businesses b ON s.business_id = b.id
WHERE b.flow_type = 'reservation'
ON CONFLICT (id) DO NOTHING;

-- Backfill property_id on existing reservations
UPDATE reservations SET property_id = service_id
WHERE service_id IS NOT NULL
  AND property_id IS NULL
  AND business_id IN (SELECT id FROM businesses WHERE flow_type = 'reservation');

-- Deactivate migrated services (don't delete — preserves FK refs)
UPDATE services SET is_active = false, metadata = COALESCE(metadata, '{}'::jsonb) || '{"migrated_to_properties": true}'::jsonb
WHERE business_id IN (SELECT id FROM businesses WHERE flow_type = 'reservation');
