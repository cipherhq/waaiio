-- Add buffer time between appointments
-- e.g., 10 minutes cleanup between a 30-min haircut = 40 min total blocked
ALTER TABLE services ADD COLUMN IF NOT EXISTS buffer_minutes INT NOT NULL DEFAULT 0;
