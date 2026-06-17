-- 204: Add max_guests and party_type to parties table
ALTER TABLE parties ADD COLUMN IF NOT EXISTS max_guests INTEGER;
ALTER TABLE parties ADD COLUMN IF NOT EXISTS party_type VARCHAR(50);
