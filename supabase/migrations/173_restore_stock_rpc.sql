-- Atomic stock restoration for products (inverse of decrement_stock from migration 020)
CREATE OR REPLACE FUNCTION restore_stock(p_product_id uuid, qty integer)
RETURNS void AS $$
BEGIN
  UPDATE products
  SET stock_quantity = COALESCE(stock_quantity, 0) + qty
  WHERE id = p_product_id AND track_inventory = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Atomic stock restoration for product variants
CREATE OR REPLACE FUNCTION restore_variant_stock(p_variant_id uuid, qty integer)
RETURNS void AS $$
BEGIN
  UPDATE product_variants
  SET stock_quantity = COALESCE(stock_quantity, 0) + qty
  WHERE id = p_variant_id AND stock_quantity IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Atomic ticket restoration for events
CREATE OR REPLACE FUNCTION restore_tickets_sold(p_event_id uuid, qty integer)
RETURNS void AS $$
BEGIN
  UPDATE events
  SET tickets_sold = GREATEST(0, COALESCE(tickets_sold, 0) - qty)
  WHERE id = p_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
