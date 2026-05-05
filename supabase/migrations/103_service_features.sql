-- ══════════════════════════════════════════════════════════════
-- Feature 1: Service Add-ons
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS service_addons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE CASCADE, -- NULL = applies to all services
  name VARCHAR(200) NOT NULL,
  description TEXT,
  price INTEGER NOT NULL DEFAULT 0,
  price_type VARCHAR(20) NOT NULL DEFAULT 'fixed', -- fixed, per_unit, per_hour
  is_required BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_addons_business ON service_addons(business_id);
CREATE INDEX IF NOT EXISTS idx_service_addons_service ON service_addons(service_id);

ALTER TABLE service_addons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_addons_select" ON service_addons FOR SELECT USING (true);
CREATE POLICY "service_addons_insert" ON service_addons FOR INSERT WITH CHECK (
  business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
);
CREATE POLICY "service_addons_update" ON service_addons FOR UPDATE USING (
  business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
);
CREATE POLICY "service_addons_delete" ON service_addons FOR DELETE USING (
  business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
);

-- ══════════════════════════════════════════════════════════════
-- Feature 2: Service Packages (simple: package is a service with included_service_ids)
-- No separate table — use services.metadata for package config
-- ══════════════════════════════════════════════════════════════
ALTER TABLE services ADD COLUMN IF NOT EXISTS is_package BOOLEAN DEFAULT false;
ALTER TABLE services ADD COLUMN IF NOT EXISTS included_service_ids UUID[] DEFAULT '{}';

-- ══════════════════════════════════════════════════════════════
-- Feature 3: Venue/Location on bookings
-- ══════════════════════════════════════════════════════════════
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS venue_name TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS venue_address TEXT;

-- ══════════════════════════════════════════════════════════════
-- Feature 5: Multi-day bookings
-- ══════════════════════════════════════════════════════════════
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS end_date DATE;

-- ══════════════════════════════════════════════════════════════
-- Feature 1 (cont): Add-ons snapshot on bookings
-- ══════════════════════════════════════════════════════════════
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addons_snapshot JSONB;

-- ══════════════════════════════════════════════════════════════
-- Feature 6: Service Gallery (max 3 images)
-- ══════════════════════════════════════════════════════════════
ALTER TABLE services ADD COLUMN IF NOT EXISTS gallery_urls TEXT[] DEFAULT '{}';

-- ══════════════════════════════════════════════════════════════
-- Feature 7: Service Quotes
-- ══════════════════════════════════════════════════════════════
ALTER TABLE services ADD COLUMN IF NOT EXISTS quote_enabled BOOLEAN DEFAULT false;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES services(id);
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS quote_type VARCHAR(20) DEFAULT 'order';

-- ══════════════════════════════════════════════════════════════
-- Feature 3/5: Per-service toggles via metadata (no new columns needed)
-- collect_venue: boolean (in services.metadata)
-- multi_day: boolean (in services.metadata)
-- These are read from services.metadata in the bot flow
-- ══════════════════════════════════════════════════════════════
