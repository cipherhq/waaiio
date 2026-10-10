-- Migration 438: Business App Coexistence schema extensions (#592 Phase 2)
--
-- Adds coexistence metadata columns to whatsapp_channels and creates
-- the coexistence_signup_nonces table for anti-replay nonce management.
--
-- No SECURITY DEFINER functions. Service-role-only access on nonces table.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Extend whatsapp_channels with coexistence metadata
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS connection_type VARCHAR(20) DEFAULT 'transfer'
    CHECK (connection_type IN ('transfer', 'coexist')),
  ADD COLUMN IF NOT EXISTS coexist_meta_business_app_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS coexist_verified_at TIMESTAMPTZ;

-- Coexistence metadata columns are only meaningful when connection_type = 'coexist'.
-- When connection_type = 'transfer' (default), these columns should remain NULL.
COMMENT ON COLUMN whatsapp_channels.connection_type IS 'How this channel was connected: transfer (standard) or coexist (business app coexistence)';
COMMENT ON COLUMN whatsapp_channels.coexist_meta_business_app_id IS 'The existing WhatsApp Business app ID that coexists with this channel (only for coexist connections)';
COMMENT ON COLUMN whatsapp_channels.coexist_verified_at IS 'When Meta confirmed coexistence eligibility for this channel';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Coexistence signup nonces — anti-replay for Meta onboarding callbacks
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coexistence_signup_nonces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  nonce VARCHAR(128) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_session VARCHAR(256),
  CONSTRAINT nonce_not_empty CHECK (length(trim(nonce)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_coexist_nonces_business
  ON coexistence_signup_nonces(business_id);

CREATE INDEX IF NOT EXISTS idx_coexist_nonces_lookup
  ON coexistence_signup_nonces(nonce) WHERE consumed_at IS NULL;

-- RLS: service_role only. No authenticated/anon access.
ALTER TABLE coexistence_signup_nonces ENABLE ROW LEVEL SECURITY;

-- Revoke all access from public, anon, and authenticated roles.
-- Only service_role (used by server-side admin operations) can access this table.
REVOKE ALL ON coexistence_signup_nonces FROM PUBLIC;
REVOKE ALL ON coexistence_signup_nonces FROM anon;
REVOKE ALL ON coexistence_signup_nonces FROM authenticated;
GRANT ALL ON coexistence_signup_nonces TO service_role;
