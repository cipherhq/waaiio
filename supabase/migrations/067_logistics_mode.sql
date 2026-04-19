-- 067: Logistics mode — two-address collection for courier/logistics businesses
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS pickup_address TEXT,
  ADD COLUMN IF NOT EXISTS dropoff_address TEXT,
  ADD COLUMN IF NOT EXISTS package_description TEXT,
  ADD COLUMN IF NOT EXISTS package_photo_url TEXT;
