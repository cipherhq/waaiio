-- ============================================================
-- 010_payout_system.sql
-- Expanded payout system: terms acceptance, payout modes,
-- business payouts, admin audit logs
-- ============================================================

-- 1a. Add payout_mode to businesses
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS payout_mode VARCHAR(20) NOT NULL DEFAULT 'platform_managed';
  -- 'direct_split' = subaccount auto-split
  -- 'platform_managed' = Waaiio collects 100%, pays weekly

-- 1b. Add business_id to payments for cross-table queries
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id);

-- Backfill business_id from bookings
UPDATE public.payments p SET business_id = b.business_id
  FROM public.bookings b WHERE p.booking_id = b.id AND p.business_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_payments_business ON public.payments(business_id, created_at DESC);

-- 1c. Payout terms acceptance tracking
CREATE TABLE IF NOT EXISTS public.payout_terms_acceptance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  accepted_by UUID NOT NULL REFERENCES public.profiles(id),
  terms_version VARCHAR(10) NOT NULL DEFAULT '1.0',
  payout_mode VARCHAR(20) NOT NULL,
  ip_address VARCHAR(45),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_terms_business
  ON public.payout_terms_acceptance(business_id, accepted_at DESC);

-- 1d. Business payouts (platform-managed payout records)
CREATE TABLE IF NOT EXISTS public.business_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id),
  payout_account_id UUID REFERENCES public.payout_accounts(id),

  -- Period
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  -- Amounts
  gross_amount DECIMAL(12,2) NOT NULL,
  platform_fee DECIMAL(12,2) NOT NULL,
  gateway_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_amount DECIMAL(12,2) NOT NULL,

  -- Status workflow: pending → approved → processing → paid | failed | rejected
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  approved_by UUID REFERENCES public.profiles(id),
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,

  -- Transfer details
  transfer_method VARCHAR(20),  -- 'paystack_transfer' | 'stripe_transfer' | 'manual_bank' | 'manual_cash'
  transfer_reference VARCHAR(100),
  gateway_transfer_code VARCHAR(100),
  paid_at TIMESTAMPTZ,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_payouts_business
  ON public.business_payouts(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_payouts_status
  ON public.business_payouts(status);

-- 1e. Admin audit logs
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES public.profiles(id),
  action VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50),
  entity_id UUID,
  details JSONB DEFAULT '{}',
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
  ON public.admin_audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
  ON public.admin_audit_logs(entity_type, entity_id);

-- ============================================================
-- RLS Policies
-- ============================================================

-- payout_terms_acceptance
ALTER TABLE public.payout_terms_acceptance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business owners can view own terms acceptance"
  ON public.payout_terms_acceptance FOR SELECT
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Business owners can insert own terms acceptance"
  ON public.payout_terms_acceptance FOR INSERT
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

-- business_payouts
ALTER TABLE public.business_payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business owners can view own payouts"
  ON public.business_payouts FOR SELECT
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Admins have full access to business_payouts"
  ON public.business_payouts FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'admin')
  );

-- admin_audit_logs
ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view audit logs"
  ON public.admin_audit_logs FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'admin')
  );

CREATE POLICY "Admins can insert audit logs"
  ON public.admin_audit_logs FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'admin')
  );

-- Additional admin policies on existing tables
CREATE POLICY "Admins can view all payout accounts"
  ON public.payout_accounts FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'admin')
  );

CREATE POLICY "Admins can view all businesses"
  ON public.businesses FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role::text = 'admin')
  );
