-- Add per-product minimum order quantity
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_order_qty integer DEFAULT 1;

-- Comment
COMMENT ON COLUMN products.min_order_qty IS 'Minimum quantity a customer must order for this product';
