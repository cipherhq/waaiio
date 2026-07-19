-- ═══════════════════════════════════════════════════════
-- 283: Service-role-only secrets table for BYO credentials
--
-- Stores encrypted merchant gateway credentials.
-- NEVER accessible via browser/authenticated client.
-- Only service_role (server-side) can read.
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.business_connection_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_account_id UUID NOT NULL REFERENCES public.payout_accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id),
  -- Encrypted with AES-256-GCM via lib/encryption.ts
  -- Format: iv:authTag:ciphertext (hex-encoded)
  encrypted_secret_key TEXT NOT NULL,
  -- Masked identifier shown to business owner (e.g., "sk_****X4f2")
  key_identifier VARCHAR(30) NOT NULL,
  -- Platform-fee subaccount created on merchant's provider account
  platform_fee_subaccount_code VARCHAR(100),
  -- Verification state
  verified_at TIMESTAMPTZ,
  verification_method VARCHAR(30),
  -- Webhook configuration
  webhook_url TEXT,
  webhook_verified_at TIMESTAMPTZ,
  -- Lifecycle
  rotated_from_id UUID REFERENCES public.business_connection_secrets(id),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.business_connection_secrets ENABLE ROW LEVEL SECURITY;

-- Service role ONLY — no browser access whatsoever
CREATE POLICY "Service role only on connection secrets"
  ON public.business_connection_secrets
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Explicitly deny authenticated users
-- (RLS default-deny means no policy = no access, but this is defense in depth)
CREATE POLICY "Deny authenticated access to secrets"
  ON public.business_connection_secrets
  FOR SELECT TO authenticated
  USING (false);

-- Index for lookup by payout_account
CREATE INDEX idx_connection_secrets_payout_account
  ON public.business_connection_secrets (payout_account_id)
  WHERE revoked_at IS NULL;
