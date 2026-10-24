-- ══════════════════════════════════════════════════════════
-- 461: Product Gallery Images
--
-- Adds gallery_urls column to products table, following the
-- proven services.gallery_urls pattern (migration 103).
--
-- products.image_url remains the primary image (unchanged).
-- gallery_urls stores up to 3 additional image URLs.
-- Total per product: 1 primary + 3 gallery = 4 images max.
-- ══════════════════════════════════════════════════════════

-- ── Step 1: Add column ───────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS gallery_urls TEXT[] NOT NULL DEFAULT '{}';

-- ── Step 2: Enforce max 3 gallery images ─────────────────
-- CHECK constraint prevents exceeding the gallery limit.
-- array_length returns NULL for empty arrays, so COALESCE handles that.
ALTER TABLE products
  ADD CONSTRAINT chk_product_gallery_max_3
  CHECK (COALESCE(array_length(gallery_urls, 1), 0) <= 3);

-- ── Step 3: Verification ─────────────────────────────────
DO $$
BEGIN
  -- Column exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'gallery_urls'
  ) THEN
    RAISE EXCEPTION 'M461: gallery_urls column missing from products';
  END IF;

  -- Constraint exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_product_gallery_max_3'
  ) THEN
    RAISE EXCEPTION 'M461: CHECK constraint chk_product_gallery_max_3 missing';
  END IF;

  -- Existing products unaffected (all have empty gallery by default)
  IF EXISTS (
    SELECT 1 FROM products WHERE COALESCE(array_length(gallery_urls, 1), 0) > 3
  ) THEN
    RAISE EXCEPTION 'M461: existing product violates gallery limit';
  END IF;

  RAISE NOTICE 'M461: Product gallery images migration complete';
END $$;
