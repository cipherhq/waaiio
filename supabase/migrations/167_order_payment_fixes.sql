-- Add order_id column to payments table (was only in metadata)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES orders(id);

-- Backfill existing payments from metadata
UPDATE payments
SET order_id = (metadata->>'order_id')::uuid
WHERE order_id IS NULL
  AND metadata->>'order_id' IS NOT NULL
  AND metadata->>'order_id' != '';

-- Index for order payment lookups
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id) WHERE order_id IS NOT NULL;
