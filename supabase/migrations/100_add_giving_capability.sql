-- Add 'giving' to capability_type enum for faith-based businesses
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'giving';
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'poll';
