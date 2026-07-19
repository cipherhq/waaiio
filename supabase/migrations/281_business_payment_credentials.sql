-- ═══════════════════════════════════════════════════════
-- 281: Business payment credentials (BYO gateway)
-- Allows businesses to use their own Paystack/Flutterwave
-- keys instead of the platform account.
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.business_payment_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id),
  gateway VARCHAR(20) NOT NULL,
  secret_key TEXT,
  platform_subaccount_code VARCHAR(100),
  connect_account_id VARCHAR(100),
  connection_type VARCHAR(20) NOT NULL DEFAULT 'subaccount',
  is_active BOOLEAN NOT NULL DEFAULT true,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_bpc_connection_type CHECK (
    connection_type IN ('subaccount', 'connect', 'byo')
  )
);

-- Only one active credential set per business
CREATE UNIQUE INDEX IF NOT EXISTS idx_bpc_business_active
  ON public.business_payment_credentials (business_id)
  WHERE is_active = true;

ALTER TABLE public.business_payment_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on bpc"
  ON public.business_payment_credentials
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Business owner manages own credentials"
  ON public.business_payment_credentials
  FOR ALL TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
