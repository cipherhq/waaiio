-- Add capability types that exist in code but were missing from the DB enum
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'table_reservation';
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'estimates';
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'packages';
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'class_booking';
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'multi_location';
