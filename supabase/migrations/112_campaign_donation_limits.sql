-- Add min/max donation amounts to campaigns (business-configurable)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS min_donation NUMERIC DEFAULT NULL;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS max_donation NUMERIC DEFAULT NULL;
