-- 305: Annual subscription support + loyalty tier wiring
--
-- 1. Extend customer_subscriptions.frequency to include 'yearly'
-- 2. Extend services.recurring_interval to include 'yearly'
-- 3. No changes to invoices (already supports 'yearly')

-- ═══════════════════════════════════════════════════════
-- 1. Extend customer_subscriptions frequency constraint
-- ═══════════════════════════════════════════════════════

-- Drop the existing CHECK constraint and re-add with 'yearly'
ALTER TABLE customer_subscriptions DROP CONSTRAINT IF EXISTS customer_subscriptions_frequency_check;
ALTER TABLE customer_subscriptions ADD CONSTRAINT customer_subscriptions_frequency_check
  CHECK (frequency IN ('weekly', 'monthly', 'yearly'));

-- ═══════════════════════════════════════════════════════
-- 2. Extend services recurring_interval constraint
-- ═══════════════════════════════════════════════════════

-- Drop and re-add the CHECK constraint
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_recurring_interval_check;
ALTER TABLE services ADD CONSTRAINT services_recurring_interval_check
  CHECK (recurring_interval IS NULL OR recurring_interval IN ('weekly', 'monthly', 'yearly'));
