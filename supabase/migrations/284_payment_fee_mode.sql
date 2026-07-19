-- ═══════════════════════════════════════════════════════
-- 284: Fee mode tracking on payments
--
-- Records collection mode and fee breakdown on each payment
-- for accurate settlement and reconciliation.
-- ═══════════════════════════════════════════════════════
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS collection_mode VARCHAR(20) DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS fee_bearer VARCHAR(20) DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS payout_account_id UUID REFERENCES public.payout_accounts(id),
  ADD COLUMN IF NOT EXISTS waaiio_fee NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_gateway_fee NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS merchant_net NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS fee_finalized BOOLEAN DEFAULT false;

-- collection_mode: 'platform' | 'managed_split' | 'byo' | 'connect' | 'flutterwave_mid'
-- fee_bearer: 'platform' | 'merchant' | 'shared'
-- fee_finalized: false until actual gateway fee is confirmed (webhook/reconciliation)
