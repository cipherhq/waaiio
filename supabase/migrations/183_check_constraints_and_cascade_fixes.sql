-- Migration 183: CHECK constraints, CASCADE→RESTRICT fix, performance index, stale index cleanup
-- All constraints verified against production data before applying (zero violations found)

-- 3a. Non-negative CHECK constraints on financial tables
ALTER TABLE payments ADD CONSTRAINT chk_payments_amount_nonneg CHECK (amount >= 0);

ALTER TABLE platform_fees ADD CONSTRAINT chk_platform_fees_amount_nonneg CHECK (transaction_amount >= 0 AND fee_total >= 0);

ALTER TABLE business_payouts ADD CONSTRAINT chk_payouts_amount_nonneg CHECK (gross_amount >= 0 AND net_amount >= 0);

-- 3b. CASCADE → RESTRICT on refund_requests.payment_id FK
-- Prevents accidental deletion of payments that have refund requests
-- Verified: no application code deletes from the payments table
ALTER TABLE refund_requests DROP CONSTRAINT IF EXISTS refund_requests_payment_id_fkey;
ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_payment_id_fkey
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT;

-- 3c. Performance index on orders (business + status, excluding soft-deleted)
CREATE INDEX IF NOT EXISTS idx_orders_business_status ON orders(business_id, status) WHERE deleted_at IS NULL;

-- 3d. Drop stale index from pre-rename era (restaurants → businesses)
DROP INDEX IF EXISTS idx_subscriptions_restaurant;
