-- Add access_token to signed_waivers for public token-based access
ALTER TABLE signed_waivers ADD COLUMN IF NOT EXISTS access_token VARCHAR(32)
  DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);

-- Backfill existing rows that may have NULL
UPDATE signed_waivers SET access_token = substr(replace(gen_random_uuid()::text, '-', ''), 1, 16) WHERE access_token IS NULL;

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_signed_waivers_access_token ON signed_waivers(access_token);

-- Increase waiver_templates token default to 16 chars
ALTER TABLE waiver_templates ALTER COLUMN token SET DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
