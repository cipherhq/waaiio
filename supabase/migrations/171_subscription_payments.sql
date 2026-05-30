-- ══════════════════════════════════════════════════════════
-- 170: Subscription payment history tracking
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id),
  amount INTEGER NOT NULL, -- in smallest currency unit
  currency TEXT NOT NULL DEFAULT 'NGN',
  gateway TEXT NOT NULL, -- 'paystack', 'stripe'
  gateway_reference TEXT, -- payment reference from gateway
  plan TEXT NOT NULL, -- 'growth', 'business'
  action TEXT NOT NULL DEFAULT 'upgrade' CHECK (action IN ('upgrade', 'renewal', 'downgrade')),
  status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed', 'pending')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscription_payments_business ON subscription_payments (business_id, created_at DESC);

ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscription_payments_owner" ON subscription_payments
  FOR SELECT USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- Admin roles can view all subscription payments
CREATE POLICY "subscription_payments_admin" ON subscription_payments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'finance')
    )
  );

-- Add missing columns to subscriptions table
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS gateway TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'NGN';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
