-- Payout subaccounts for split payments
-- Stores gateway-specific subaccount identifiers so customer payments auto-split

CREATE TABLE public.payout_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  gateway VARCHAR(20) NOT NULL,  -- 'paystack' | 'flutterwave' | 'stripe'

  -- Gateway-specific subaccount identifiers
  subaccount_code VARCHAR(100),        -- Paystack: "ACCT_xxx", Flutterwave: subaccount_id
  stripe_account_id VARCHAR(100),      -- Stripe Connect: "acct_xxx"

  -- Bank details (Paystack/Flutterwave only)
  bank_code VARCHAR(10),
  bank_name VARCHAR(100),
  account_number VARCHAR(20),
  account_name VARCHAR(200),           -- Verified name from resolve API

  -- Split configuration
  platform_percentage DECIMAL(5,2) NOT NULL DEFAULT 2.5,  -- Platform's cut

  -- Status
  is_active BOOLEAN NOT NULL DEFAULT true,
  verified_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active payout account per business
CREATE UNIQUE INDEX idx_payout_accounts_business_active
  ON public.payout_accounts(business_id) WHERE is_active = true;

-- RLS
ALTER TABLE public.payout_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business owners can view own payout accounts"
  ON public.payout_accounts FOR SELECT
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Business owners can insert own payout accounts"
  ON public.payout_accounts FOR INSERT
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Business owners can update own payout accounts"
  ON public.payout_accounts FOR UPDATE
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
