-- ═══════════════════════════════════════════════════════
-- 282: Payment connections data model
--
-- Replaces the single-active-per-business constraint on
-- payout_accounts with multi-connection + one-default model.
-- Adds business_connection_secrets for encrypted BYO credentials.
-- ═══════════════════════════════════════════════════════

-- 1. Drop the single-active constraint to allow multiple connections
DROP INDEX IF EXISTS public.idx_payout_accounts_business_active;

-- 2. Add connection management columns
ALTER TABLE public.payout_accounts
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connection_mode VARCHAR(20) NOT NULL DEFAULT 'managed',
  ADD COLUMN IF NOT EXISTS connection_status VARCHAR(20) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS flutterwave_mid VARCHAR(100),
  ADD COLUMN IF NOT EXISTS provider_account_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS last_health_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS health_status VARCHAR(20) DEFAULT 'healthy';

-- connection_mode: 'managed' | 'connect' | 'byo' | 'flutterwave_mid'
-- connection_status: 'pending' | 'active' | 'pending_review' | 'unhealthy' | 'revoked'
-- health_status: 'healthy' | 'unhealthy' | 'unchecked'

-- 3. Enforce exactly one default per business
CREATE UNIQUE INDEX idx_payout_accounts_business_default
  ON public.payout_accounts (business_id) WHERE is_default = true;

-- 4. Enforce one active connection per provider per business
CREATE UNIQUE INDEX idx_payout_accounts_business_gateway_active
  ON public.payout_accounts (business_id, gateway)
  WHERE connection_status IN ('active', 'pending', 'pending_review');
