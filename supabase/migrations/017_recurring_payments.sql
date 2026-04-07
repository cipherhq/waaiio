-- 017_recurring_payments.sql
-- Recurring payment subscriptions for automatic customer charges

-- ── Add recurring_enabled to businesses ──
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS recurring_enabled BOOLEAN DEFAULT false;

-- ── customer_subscriptions: tracks each recurring payment relationship ──
CREATE TABLE IF NOT EXISTS customer_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
  frequency VARCHAR(10) NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'past_due')),
  gateway VARCHAR(20) CHECK (gateway IN ('paystack', 'stripe', 'flutterwave')),
  gateway_subscription_code TEXT,
  gateway_plan_code TEXT,
  gateway_customer_code TEXT,
  authorization_code TEXT,
  card_last_four VARCHAR(4),
  card_brand VARCHAR(20),
  next_charge_at TIMESTAMPTZ,
  last_charged_at TIMESTAMPTZ,
  charge_count INT NOT NULL DEFAULT 0,
  total_charged DECIMAL(12,2) NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  setup_channel VARCHAR(10) CHECK (setup_channel IN ('whatsapp', 'web')),
  cancelled_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── subscription_charges: logs every charge attempt ──
CREATE TABLE IF NOT EXISTS subscription_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES customer_subscriptions(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount DECIMAL(12,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('success', 'failed', 'pending')),
  gateway VARCHAR(20),
  gateway_reference TEXT,
  failure_reason TEXT,
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  charged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ──
CREATE INDEX idx_customer_subscriptions_business_status ON customer_subscriptions(business_id, status);
CREATE INDEX idx_customer_subscriptions_user_status ON customer_subscriptions(user_id, status);
CREATE INDEX idx_customer_subscriptions_next_charge ON customer_subscriptions(next_charge_at, status);
CREATE INDEX idx_customer_subscriptions_gateway_code ON customer_subscriptions(gateway_subscription_code) WHERE gateway_subscription_code IS NOT NULL;
CREATE INDEX idx_subscription_charges_subscription ON subscription_charges(subscription_id);
CREATE INDEX idx_subscription_charges_business ON subscription_charges(business_id);

-- ── Auto-update updated_at trigger ──
CREATE OR REPLACE FUNCTION update_customer_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customer_subscriptions_updated_at
  BEFORE UPDATE ON customer_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_customer_subscriptions_updated_at();

-- ── RLS Policies ──
ALTER TABLE customer_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_charges ENABLE ROW LEVEL SECURITY;

-- Business owners can view their subscriptions
CREATE POLICY "Business owners can view subscriptions"
  ON customer_subscriptions FOR SELECT
  USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- Business owners can manage their subscriptions
CREATE POLICY "Business owners can manage subscriptions"
  ON customer_subscriptions FOR ALL
  USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- Customers can view their own subscriptions
CREATE POLICY "Customers can view own subscriptions"
  ON customer_subscriptions FOR SELECT
  USING (user_id = auth.uid());

-- Customers can cancel their own subscriptions
CREATE POLICY "Customers can update own subscriptions"
  ON customer_subscriptions FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Service role has full access (for webhooks, workers)
CREATE POLICY "Service role full access on customer_subscriptions"
  ON customer_subscriptions FOR ALL
  USING (auth.role() = 'service_role');

-- Subscription charges: owners see their business charges
CREATE POLICY "Business owners can view charges"
  ON subscription_charges FOR SELECT
  USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- Customers see their own charges
CREATE POLICY "Customers can view own charges"
  ON subscription_charges FOR SELECT
  USING (user_id = auth.uid());

-- Service role full access for charges
CREATE POLICY "Service role full access on subscription_charges"
  ON subscription_charges FOR ALL
  USING (auth.role() = 'service_role');
