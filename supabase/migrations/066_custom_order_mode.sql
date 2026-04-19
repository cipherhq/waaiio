-- 066: Custom Order Mode
-- Adds deposit/balance tracking on orders and custom_order_data on orders + quote_requests

-- Deposit tracking on orders
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS deposit_percentage INTEGER,
  ADD COLUMN IF NOT EXISTS deposit_amount INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS balance_amount INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS balance_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS custom_order_data JSONB;

-- Custom order data on quote requests
ALTER TABLE quote_requests
  ADD COLUMN IF NOT EXISTS custom_order_data JSONB;

-- Index for finding orders with unpaid balances
CREATE INDEX IF NOT EXISTS idx_orders_balance_pending
  ON orders(business_id, status)
  WHERE balance_amount > 0 AND balance_paid_at IS NULL;
