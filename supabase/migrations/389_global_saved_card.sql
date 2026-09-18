-- Migration 389: Global saved card — customer-scoped, cross-business reuse
--
-- Converts saved_payment_methods from business-scoped to customer-scoped:
-- - Deactivates existing active rows (no real users, test cards only)
-- - Makes business_id nullable (origin/audit metadata only)
-- - Changes FK lifecycle from CASCADE to SET NULL
-- - Adds authorization_email for Paystack email preservation
-- - Replaces business-scoped uniqueness with customer+gateway uniqueness
-- - Adds CHECK constraint for canonical +E.164 phone on active rows
-- - Removes merchant raw-table SELECT policy (global card = no merchant visibility)

-- 1. Deactivate all existing active saved cards (no real users yet)
UPDATE saved_payment_methods SET is_active = false WHERE is_active = true;

-- 2. Drop existing business-scoped unique constraint
ALTER TABLE saved_payment_methods
  DROP CONSTRAINT IF EXISTS saved_payment_methods_business_id_customer_phone_gateway_key;

-- 3. Make business_id nullable + change FK lifecycle
ALTER TABLE saved_payment_methods ALTER COLUMN business_id DROP NOT NULL;
ALTER TABLE saved_payment_methods DROP CONSTRAINT IF EXISTS saved_payment_methods_business_id_fkey;
ALTER TABLE saved_payment_methods
  ADD CONSTRAINT saved_payment_methods_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL;

-- 4. Add authorization_email column
ALTER TABLE saved_payment_methods ADD COLUMN IF NOT EXISTS authorization_email TEXT;

-- 5. Customer-scoped active uniqueness (one active card per customer per gateway)
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_pm_customer_gateway_active
  ON saved_payment_methods (customer_phone, gateway)
  WHERE is_active = true;

-- 6. Customer-scoped lookup index (replaces business-scoped)
DROP INDEX IF EXISTS idx_saved_pm_lookup;
CREATE INDEX IF NOT EXISTS idx_saved_pm_customer_lookup
  ON saved_payment_methods (customer_phone, is_active);

-- 7. CHECK constraint: active rows must have canonical +E.164 phone
ALTER TABLE saved_payment_methods ADD CONSTRAINT chk_active_canonical_phone
  CHECK (NOT is_active OR customer_phone LIKE '+%');

-- 8. Remove merchant raw-table SELECT policy (global card = no merchant visibility)
-- Retain only service_role access for runtime operations.
DROP POLICY IF EXISTS saved_pm_owner ON saved_payment_methods;
-- service_role policy already exists (ALL for service_role) — keep it.
