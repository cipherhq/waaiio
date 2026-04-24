-- Add state and zip_code to businesses, make neighborhood optional
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS state VARCHAR(100),
  ADD COLUMN IF NOT EXISTS zip_code VARCHAR(20);

-- Make neighborhood nullable (was required before, now optional with Google Places)
ALTER TABLE public.businesses
  ALTER COLUMN neighborhood DROP NOT NULL;
