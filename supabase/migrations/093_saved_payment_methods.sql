-- ═══════════════════════════════════════════════════════
-- 093: Saved Payment Methods
-- Store reusable card authorizations from Paystack/Stripe
-- so customers can pay with one tap on repeat bookings.
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS saved_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  gateway text NOT NULL, -- 'paystack' | 'stripe'
  -- Paystack fields
  authorization_code text, -- reusable auth code
  customer_code text, -- Paystack customer code
  -- Stripe fields
  stripe_payment_method_id text, -- pm_xxx
  stripe_customer_id text, -- cus_xxx
  -- Card display info (safe to store)
  card_last4 text,
  card_brand text, -- 'visa', 'mastercard', etc.
  card_exp_month smallint,
  card_exp_year smallint,
  card_type text, -- 'debit', 'credit'
  bank_name text,
  -- Status
  is_active boolean DEFAULT true,
  last_used_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(business_id, customer_phone, gateway)
);

CREATE INDEX idx_saved_pm_lookup ON saved_payment_methods(business_id, customer_phone, is_active);

-- RLS
ALTER TABLE saved_payment_methods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "saved_pm_owner" ON saved_payment_methods
  FOR SELECT USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

CREATE POLICY "saved_pm_service" ON saved_payment_methods
  FOR ALL USING (auth.role() = 'service_role');
