-- Payout adjustments table for tracking deductions from future payouts
-- (e.g. refunds that occurred after a payout was already sent)

CREATE TABLE IF NOT EXISTS public.payout_adjustments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  payout_id uuid NOT NULL REFERENCES public.business_payouts(id) ON DELETE CASCADE,
  payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  amount numeric NOT NULL,  -- negative = deduction from next payout
  reason text,
  applied_to_payout_id uuid REFERENCES public.business_payouts(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_payout_adjustments_business ON public.payout_adjustments(business_id);
CREATE INDEX IF NOT EXISTS idx_payout_adjustments_payout ON public.payout_adjustments(payout_id);
CREATE INDEX IF NOT EXISTS idx_payout_adjustments_unapplied ON public.payout_adjustments(business_id)
  WHERE applied_to_payout_id IS NULL;

-- RLS
ALTER TABLE public.payout_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business owners can view their own adjustments"
  ON public.payout_adjustments FOR SELECT
  USING (
    business_id IN (
      SELECT id FROM public.businesses WHERE owner_id = auth.uid()
    )
  );

CREATE POLICY "Service role full access on payout_adjustments"
  ON public.payout_adjustments FOR ALL
  USING (auth.role() = 'service_role');
