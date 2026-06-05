-- 181: Financial integrity — dedup indexes, tier tampering guard, stock RPC lockdown, refund policy fix

-- ── 1a. Unique index on platform_fees for order_id (prevents duplicate fees for orders) ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_fees_order_unique
  ON platform_fees (order_id)
  WHERE order_id IS NOT NULL AND refunded_at IS NULL;

-- ── 1b. Unique index on platform_fees for reservation_id ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_fees_reservation_unique
  ON platform_fees (reservation_id)
  WHERE reservation_id IS NOT NULL AND refunded_at IS NULL;

-- ── 1c. Prevent direct subscription_tier updates by non-service-role users ──
CREATE OR REPLACE FUNCTION prevent_tier_tampering()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow if subscription_tier hasn't changed
  IF OLD.subscription_tier = NEW.subscription_tier THEN
    RETURN NEW;
  END IF;
  -- Allow service_role (used by API routes)
  IF current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;
  -- Block authenticated users from changing tier
  RAISE EXCEPTION 'subscription_tier cannot be modified directly';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_tier_tampering
  BEFORE UPDATE ON businesses
  FOR EACH ROW
  WHEN (OLD.subscription_tier IS DISTINCT FROM NEW.subscription_tier)
  EXECUTE FUNCTION prevent_tier_tampering();

-- ── 1d. Restrict stock restoration RPCs to service_role only ──
REVOKE ALL ON FUNCTION restore_stock(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restore_stock(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION restore_variant_stock(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restore_variant_stock(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION restore_tickets_sold(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restore_tickets_sold(uuid, integer) TO service_role;

-- ── 1e. Remove owner UPDATE policy on refund_requests (prevent marking own refunds as success) ──
DROP POLICY IF EXISTS "Business owners update own refunds" ON refund_requests;
DROP POLICY IF EXISTS "owners_update_refund_requests" ON refund_requests;
-- Owners can still SELECT and INSERT refund requests, just not UPDATE status
