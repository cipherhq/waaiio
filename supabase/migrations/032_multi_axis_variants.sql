-- 032: Multi-axis product variants + per-variant images
-- Adds option group definitions on products and per-variant image/options on product_variants

-- A. Option group definitions on products
-- Stores: [{"name": "Length", "values": ["10\"","12\"","14\""]}, {"name": "Color", "values": ["Black","Brown"]}]
ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_options JSONB DEFAULT '[]'::jsonb;

-- B. Per-variant image + option values
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS image_url TEXT;
-- Stores: {"Length": "10\"", "Color": "Black"}
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS options JSONB DEFAULT '{}'::jsonb;

-- C. GIN index for JSONB matching
CREATE INDEX IF NOT EXISTS idx_product_variants_options ON product_variants USING gin (options);
