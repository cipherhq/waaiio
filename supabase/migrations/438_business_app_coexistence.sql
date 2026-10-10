-- Migration 438: Business App Coexistence schema extensions (#592 Phase 2)
--
-- Adds coexistence-specific metadata columns to whatsapp_channels and creates
-- the coexistence_signup_nonces table for anti-replay nonce management.
--
-- NOTE: The canonical connection method discriminator is the existing
-- connection_method VARCHAR(20) column (added in M007, extended in M123)
-- which already supports 'coexist' in its CHECK constraint. This migration
-- does NOT add a duplicate connection_type column — it only adds supplementary
-- metadata columns for coexistence-specific data.
--
-- No SECURITY DEFINER functions. Service-role-only access on nonces table.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Extend whatsapp_channels with coexistence-specific metadata
-- ─────────────────────────────────────────────────────────────────────────

-- These columns are supplementary to the existing connection_method column.
-- They are only meaningful when connection_method = 'coexist'.
ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS coexist_meta_business_app_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS coexist_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN whatsapp_channels.coexist_meta_business_app_id IS 'The existing WhatsApp Business app ID that coexists with this channel (only meaningful when connection_method = ''coexist'')';
COMMENT ON COLUMN whatsapp_channels.coexist_verified_at IS 'When Meta confirmed coexistence eligibility for this channel (only meaningful when connection_method = ''coexist'')';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Coexistence signup nonces — anti-replay for onboarding callbacks
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coexistence_signup_nonces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  initiated_by_user_id UUID,
  nonce VARCHAR(128) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_session VARCHAR(256),
  CONSTRAINT nonce_not_empty CHECK (length(trim(nonce)) > 0)
);

COMMENT ON COLUMN coexistence_signup_nonces.initiated_by_user_id IS 'The authenticated user who started the coexistence signup flow. Binds the nonce to a specific user for session ownership verification.';

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
