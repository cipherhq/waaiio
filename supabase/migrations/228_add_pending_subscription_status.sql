-- Add 'pending' to customer_subscriptions status CHECK constraint
-- Pending = Stripe checkout session created but not yet completed
ALTER TABLE customer_subscriptions DROP CONSTRAINT IF EXISTS customer_subscriptions_status_check;
ALTER TABLE customer_subscriptions ADD CONSTRAINT customer_subscriptions_status_check
  CHECK (status IN ('active', 'paused', 'cancelled', 'past_due', 'pending', 'failed'));
