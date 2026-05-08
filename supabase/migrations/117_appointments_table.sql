-- ═══════════════════════════════════════════════════════
-- Appointments table: calendar-based bookable items
-- Separated from services so each evolves independently
-- Services table retains on-demand items only
-- ═══════════════════════════════════════════════════════

-- Add 'appointment' to flow_type enum
ALTER TYPE flow_type ADD VALUE IF NOT EXISTS 'appointment';

CREATE TABLE IF NOT EXISTS appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  description text,
  price numeric NOT NULL DEFAULT 0,
  price_is_variable boolean NOT NULL DEFAULT false,
  duration_minutes integer NOT NULL DEFAULT 30,
  deposit_amount numeric NOT NULL DEFAULT 0,
  max_capacity integer DEFAULT 1,
  requires_staff boolean NOT NULL DEFAULT false,
  staff_ids uuid[] DEFAULT '{}',
  allow_staff_selection boolean NOT NULL DEFAULT false,
  available_days text[] DEFAULT '{}',
  available_from time,
  available_to time,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  image_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointments_business ON appointments(business_id);

-- RLS
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY appointments_owner_select ON appointments FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY appointments_owner_insert ON appointments FOR INSERT
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY appointments_owner_update ON appointments FOR UPDATE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY appointments_owner_delete ON appointments FOR DELETE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY appointments_service_all ON appointments FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Add appointment_id to bookings (alongside existing service_id)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL;

-- Add 'appointment' to capability_type enum
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'appointment';

-- Migrate existing scheduled services → appointments table
-- Uses same UUID so existing bookings.service_id values still match
INSERT INTO appointments (id, business_id, name, description, price, price_is_variable,
  duration_minutes, deposit_amount, max_capacity, requires_staff, staff_ids,
  allow_staff_selection, available_days, available_from, available_to, is_active,
  sort_order, image_url, metadata, created_at, updated_at)
SELECT s.id, s.business_id, s.name, s.description, s.price, s.price_is_variable,
  COALESCE(s.duration_minutes, 30), COALESCE(s.deposit_amount, 0), COALESCE(s.max_capacity, 1),
  COALESCE(s.requires_staff, false), COALESCE(s.staff_ids, '{}'),
  COALESCE(s.allow_staff_selection, false), COALESCE(s.available_days, '{}'),
  s.available_from, s.available_to, s.is_active, s.sort_order,
  s.image_url, COALESCE(s.metadata, '{}'::jsonb), s.created_at, s.updated_at
FROM services s
WHERE s.duration_minutes IS NOT NULL AND s.service_type = 'booking'
ON CONFLICT (id) DO NOTHING;

-- Backfill appointment_id on existing bookings
UPDATE bookings SET appointment_id = service_id
WHERE service_id IS NOT NULL AND flow_type = 'scheduling'
AND service_id IN (SELECT id FROM appointments);

-- Deactivate migrated services (keep rows for FK integrity)
UPDATE services SET is_active = false,
  metadata = COALESCE(metadata, '{}'::jsonb) || '{"migrated_to_appointments": true}'::jsonb
WHERE duration_minutes IS NOT NULL AND service_type = 'booking';
