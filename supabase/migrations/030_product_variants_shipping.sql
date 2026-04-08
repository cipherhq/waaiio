-- ══════════════════════════════════════════════════════════════
-- Migration 030: Product Variants, Shipping & Tracking
-- Adds variant support, shipping tracking, and shipped status
-- ══════════════════════════════════════════════════════════════

-- A. Add 'shipped' to order_status enum (between 'processing' and 'ready')
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'shipped' AFTER 'processing';

-- B. product_variants table
CREATE TABLE IF NOT EXISTS public.product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  label VARCHAR(200) NOT NULL,
  price INTEGER NOT NULL,
  stock_quantity INTEGER,
  sku VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product ON public.product_variants(product_id);

-- updated_at trigger
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_product_variants_updated_at') THEN
    CREATE TRIGGER trg_product_variants_updated_at
      BEFORE UPDATE ON public.product_variants
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
  END IF;
END$$;

-- C. Extend order_items with variant fields
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES public.product_variants(id) ON DELETE SET NULL;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS variant_label TEXT;

-- D. Extend orders with shipping tracking fields
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipping_carrier TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipping_cost INTEGER DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;

-- E. Extend products with variant + shipping fields
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS shipping_cost INTEGER;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS has_variants BOOLEAN NOT NULL DEFAULT false;

-- F. decrement_variant_stock RPC (mirrors decrement_stock for variants)
CREATE OR REPLACE FUNCTION decrement_variant_stock(p_variant_id uuid, qty integer)
RETURNS void AS $$
BEGIN
  UPDATE product_variants
  SET stock_quantity = GREATEST(0, COALESCE(stock_quantity, 0) - qty)
  WHERE id = p_variant_id AND stock_quantity IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- G. RLS for product_variants
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "product_variants_owner_select" ON public.product_variants
  FOR SELECT USING (product_id IN (
    SELECT p.id FROM products p
    JOIN businesses b ON b.id = p.business_id
    WHERE b.owner_id = auth.uid()
  ));

CREATE POLICY "product_variants_owner_insert" ON public.product_variants
  FOR INSERT WITH CHECK (product_id IN (
    SELECT p.id FROM products p
    JOIN businesses b ON b.id = p.business_id
    WHERE b.owner_id = auth.uid()
  ));

CREATE POLICY "product_variants_owner_update" ON public.product_variants
  FOR UPDATE USING (product_id IN (
    SELECT p.id FROM products p
    JOIN businesses b ON b.id = p.business_id
    WHERE b.owner_id = auth.uid()
  ));

CREATE POLICY "product_variants_owner_delete" ON public.product_variants
  FOR DELETE USING (product_id IN (
    SELECT p.id FROM products p
    JOIN businesses b ON b.id = p.business_id
    WHERE b.owner_id = auth.uid()
  ));

-- Service role can read all variants (for bot queries)
CREATE POLICY "product_variants_service_select" ON public.product_variants
  FOR SELECT USING (true);
