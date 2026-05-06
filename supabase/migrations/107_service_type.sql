-- Distinguish giving categories from booking services
ALTER TABLE services ADD COLUMN IF NOT EXISTS service_type VARCHAR(20) DEFAULT 'booking';
-- Values: 'booking' (appointments/services), 'giving' (tithes/offerings/donations)

-- Auto-tag existing giving items by name pattern
UPDATE services SET service_type = 'giving'
WHERE price_is_variable = true
  AND LOWER(name) SIMILAR TO '%(tithe|offering|donation|seed|building fund|welfare|zakat|sadaqah)%';
