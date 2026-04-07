-- ============================================================
-- 015: Business Verification / KYC + Fraud Prevention columns
-- ============================================================

-- Verification level enum
DO $$ BEGIN
  CREATE TYPE verification_level AS ENUM ('unverified', 'basic', 'standard', 'full');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add verification columns to businesses
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS verification_level verification_level NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verification_notes TEXT,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS payout_limit_monthly BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.businesses.verification_status IS 'unverified | pending | verified | rejected';
COMMENT ON COLUMN public.businesses.payout_limit_monthly IS '0 = no payouts allowed; set based on verification level';

-- Business documents table
CREATE TABLE IF NOT EXISTS public.business_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  file_url TEXT NOT NULL,
  file_name VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN public.business_documents.type IS 'cac_certificate | business_license | government_id | utility_bill | tin_certificate';
COMMENT ON COLUMN public.business_documents.status IS 'pending | approved | rejected';

-- Verification requests table (admin-triggered)
CREATE TABLE IF NOT EXISTS public.verification_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  requested_level verification_level NOT NULL,
  requested_by UUID NOT NULL REFERENCES public.profiles(id),
  documents_required TEXT[] NOT NULL DEFAULT '{}',
  message TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN public.verification_requests.status IS 'pending | completed | expired';

-- RLS policies
ALTER TABLE public.business_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_requests ENABLE ROW LEVEL SECURITY;

-- Admin: full access on business_documents
CREATE POLICY "admin_all_business_documents" ON public.business_documents
  FOR ALL USING (public.is_admin());

-- Admin: full access on verification_requests
CREATE POLICY "admin_all_verification_requests" ON public.verification_requests
  FOR ALL USING (public.is_admin());

-- Business owner: read own documents
CREATE POLICY "owner_read_own_documents" ON public.business_documents
  FOR SELECT USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );

-- Business owner: insert own documents
CREATE POLICY "owner_insert_own_documents" ON public.business_documents
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );

-- Business owner: read own verification requests
CREATE POLICY "owner_read_own_verification_requests" ON public.verification_requests
  FOR SELECT USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );

-- Fraud flags on payouts
ALTER TABLE public.business_payouts
  ADD COLUMN IF NOT EXISTS flags JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.business_payouts.flags IS 'Array of { type, message, severity }';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_business_documents_business ON public.business_documents(business_id);
CREATE INDEX IF NOT EXISTS idx_verification_requests_business ON public.verification_requests(business_id);
CREATE INDEX IF NOT EXISTS idx_businesses_verification_status ON public.businesses(verification_status);
CREATE INDEX IF NOT EXISTS idx_businesses_verification_level ON public.businesses(verification_level);

-- Auto-set existing businesses with connected bank accounts to 'basic'
UPDATE public.businesses b
SET verification_level = 'basic',
    verification_status = 'verified',
    payout_limit_monthly = 500000
WHERE EXISTS (
  SELECT 1 FROM public.payout_accounts pa
  WHERE pa.business_id = b.id AND pa.is_active = true
)
AND b.verification_level = 'unverified';
