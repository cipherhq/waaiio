-- Add PayPal and Square to customer_subscriptions gateway CHECK constraint
-- The existing CHECK only allows 'paystack', 'stripe', 'flutterwave'
ALTER TABLE customer_subscriptions DROP CONSTRAINT IF EXISTS customer_subscriptions_gateway_check;
ALTER TABLE customer_subscriptions ADD CONSTRAINT customer_subscriptions_gateway_check
  CHECK (gateway IN ('paystack', 'stripe', 'flutterwave', 'square', 'paypal'));

-- Also add to subscription_charges if it has a similar constraint
ALTER TABLE subscription_charges DROP CONSTRAINT IF EXISTS subscription_charges_gateway_check;

-- Ensure processed_webhook_events gateway column accepts paypal
-- (No constraint on this table, just documenting)

-- Add 'paypal' to payout_accounts gateway values (VARCHAR, no constraint change needed)
