-- Migration 384: Terminal effect manifest tables
--
-- Phase A v15 foundation: 7 new tables + 1 partial unique index.
-- These tables underpin the formal effect manifest system for Stage-3
-- payment confirmation (tracking side-effects with durable authority).
--
-- CTO binding requirement: payment_rule_action_executions has restricted
-- table-level grants — service_role gets SELECT + column-level UPDATE only.
-- INSERT is exclusively through seal_payment_rule_actions (SECURITY DEFINER).

-- ═══════════════════════════════════════════════════════
-- 1. payment_terminal_manifests — manifest header (one per payment)
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_terminal_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL UNIQUE,
  manifest_version INTEGER NOT NULL DEFAULT 1,
  initialization_state TEXT NOT NULL DEFAULT 'initializing'
    CHECK (initialization_state IN ('initializing', 'initialized')),
  expected_effect_count INTEGER NOT NULL DEFAULT 0,
  expected_semantic_hash TEXT NOT NULL DEFAULT '',
  contract_version INTEGER NOT NULL DEFAULT 1,
  initialized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_terminal_manifests ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- 2. payment_terminal_effects — per-effect state rows
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_terminal_effects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL,
  effect_key TEXT NOT NULL,
  category TEXT NOT NULL
    CHECK (category IN ('required_internal', 'required_external', 'optional')),
  execution_class TEXT NOT NULL
    CHECK (execution_class IN ('internal', 'external')),
  provider_channel TEXT,
  contract_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'indeterminate', 'skipped')),
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  reserved_under_master_token UUID,
  emission_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  suppression_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (payment_id, effect_key)
);

ALTER TABLE payment_terminal_effects ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- 3. payment_loyalty_applications — exactly-once loyalty marker
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_loyalty_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL UNIQUE,
  business_id UUID NOT NULL,
  customer_phone TEXT NOT NULL,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  points_mode TEXT,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_loyalty_applications ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- 4. payment_receipt_applications — receipt generation marker
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_receipt_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL UNIQUE,
  file_path TEXT NOT NULL,
  generation_state TEXT NOT NULL DEFAULT 'completed'
    CHECK (generation_state IN ('completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_receipt_applications ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- 5. payment_visit_applications — exactly-once CRM visit marker
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_visit_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL UNIQUE,
  business_id UUID NOT NULL,
  customer_phone TEXT NOT NULL,
  visit_amount INTEGER NOT NULL DEFAULT 0,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_visit_applications ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- 6. payment_rule_action_manifests — rule-action seal header
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_rule_action_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL UNIQUE,
  action_count INTEGER NOT NULL,
  sealed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_rule_action_manifests ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- 7. payment_rule_action_executions — frozen per-rule action rows
--
-- CTO binding requirement #1: service_role has NO direct INSERT/DELETE.
-- Only seal_payment_rule_actions (SECURITY DEFINER) can INSERT.
-- service_role gets SELECT + column-level UPDATE on mutable fields only.
-- Frozen columns (rule_id, action_type, action_payload, action_fingerprint)
-- are immutable after seal.
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_rule_action_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL,
  rule_id UUID NOT NULL,
  action_type TEXT NOT NULL,
  action_payload JSONB NOT NULL,
  action_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'completed', 'failed', 'indeterminate')),
  emission_started_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (payment_id, rule_id)
);

ALTER TABLE payment_rule_action_executions ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- 8. Partial unique index for active sequence enrollments
--    Closes TOCTOU race in enrollInSequence (v12 design)
-- ═══════════════════════════════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS idx_bse_active_unique
  ON bot_sequence_enrollments (sequence_id, customer_phone)
  WHERE status = 'active';

-- ═══════════════════════════════════════════════════════
-- 9. Table-level privilege hardening for payment_rule_action_executions
--    (CTO binding requirement #1)
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
  -- Revoke all table privileges from non-owner roles
  REVOKE ALL ON TABLE payment_rule_action_executions FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE payment_rule_action_executions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE payment_rule_action_executions FROM authenticated;
  END IF;

  -- service_role: SELECT only (for reading frozen rows in Phase 2 execution)
  -- Plus column-level UPDATE on mutable fields only (status transitions)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON TABLE payment_rule_action_executions FROM service_role;
    GRANT SELECT ON TABLE payment_rule_action_executions TO service_role;
    GRANT UPDATE (status, emission_started_at, executed_at) ON TABLE payment_rule_action_executions TO service_role;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════
-- 10. Standard table-level privilege hardening for other new tables
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
  -- payment_terminal_manifests
  REVOKE ALL ON TABLE payment_terminal_manifests FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE payment_terminal_manifests FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE payment_terminal_manifests FROM authenticated;
  END IF;

  -- payment_terminal_effects
  REVOKE ALL ON TABLE payment_terminal_effects FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE payment_terminal_effects FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE payment_terminal_effects FROM authenticated;
  END IF;

  -- payment_loyalty_applications
  REVOKE ALL ON TABLE payment_loyalty_applications FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE payment_loyalty_applications FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE payment_loyalty_applications FROM authenticated;
  END IF;

  -- payment_receipt_applications
  REVOKE ALL ON TABLE payment_receipt_applications FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE payment_receipt_applications FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE payment_receipt_applications FROM authenticated;
  END IF;

  -- payment_visit_applications
  REVOKE ALL ON TABLE payment_visit_applications FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE payment_visit_applications FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE payment_visit_applications FROM authenticated;
  END IF;

  -- payment_rule_action_manifests
  REVOKE ALL ON TABLE payment_rule_action_manifests FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE payment_rule_action_manifests FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE payment_rule_action_manifests FROM authenticated;
  END IF;
END $$;
