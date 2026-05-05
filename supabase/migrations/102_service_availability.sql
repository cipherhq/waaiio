-- Per-service availability: days, hours, staff assignment
ALTER TABLE services ADD COLUMN IF NOT EXISTS available_days TEXT[] DEFAULT '{}';
ALTER TABLE services ADD COLUMN IF NOT EXISTS available_from TIME DEFAULT NULL;
ALTER TABLE services ADD COLUMN IF NOT EXISTS available_to TIME DEFAULT NULL;
ALTER TABLE services ADD COLUMN IF NOT EXISTS staff_ids UUID[] DEFAULT '{}';
ALTER TABLE services ADD COLUMN IF NOT EXISTS allow_staff_selection BOOLEAN DEFAULT false;
ALTER TABLE services ADD COLUMN IF NOT EXISTS requires_staff BOOLEAN DEFAULT false;
