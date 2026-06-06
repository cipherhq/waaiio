-- Shorten waiver template tokens from 24 to 8 characters
-- Existing tokens will keep working, new ones will be shorter
ALTER TABLE waiver_templates ALTER COLUMN token SET DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

-- Update existing tokens to be shorter (if any)
UPDATE waiver_templates SET token = substr(token, 1, 8) WHERE length(token) > 8;
