-- ═══════════════════════════════════════════════════════
-- 369: Message Cost Events (M-2, #259)
--
-- Append-only per-attempt cost ledger.
-- Schema only — no settlement authority, webhook mutation,
-- pricing resolver, reconciliation cron, or send-path enforcement.
--
-- Ownership derives from attempt_id → message_send_attempts.
-- No duplicated business_id column.
-- Supports both business-scoped and platform-scoped attempts.
-- ═══════════════════════════════════════════════════════

-- ── 1. message_cost_events ──

CREATE TABLE IF NOT EXISTS public.message_cost_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id        UUID NOT NULL REFERENCES public.message_send_attempts(id) ON DELETE RESTRICT,
  event_type        TEXT NOT NULL CHECK (event_type IN ('reserve', 'charge', 'release', 'adjust', 'reconcile')),
  amount_minor      INTEGER,  -- nullable: NULL when unpriced / no authoritative amount
  charge_type       TEXT CHECK (charge_type IN ('included', 'overage', 'waived', 'unpriced')),
  source_key        TEXT,
  balance_after_minor INTEGER,  -- nullable: NULL for platform-scoped / unpriced events
  config_version_id UUID REFERENCES public.platform_config_versions(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- adjust/reconcile require non-null source_key
  CHECK (event_type NOT IN ('adjust', 'reconcile') OR source_key IS NOT NULL),

  -- unpriced events must not carry fabricated amount
  CHECK (charge_type IS DISTINCT FROM 'unpriced' OR amount_minor IS NULL)
);

-- ── 2. Idempotency and terminal exclusivity indexes ──

-- At most one reserve per attempt
CREATE UNIQUE INDEX uq_cost_events_reserve
  ON message_cost_events(attempt_id)
  WHERE event_type = 'reserve';

-- Terminal exclusivity: at most one of charge OR release per attempt
CREATE UNIQUE INDEX uq_cost_events_terminal
  ON message_cost_events(attempt_id)
  WHERE event_type IN ('charge', 'release');

-- Repeatable corrective events: unique per (attempt, event_type, source_key)
CREATE UNIQUE INDEX uq_cost_events_repeatable
  ON message_cost_events(attempt_id, event_type, source_key)
  WHERE event_type IN ('adjust', 'reconcile');

CREATE INDEX idx_mce_attempt ON message_cost_events(attempt_id);

-- ── 3. Append-only enforcement ──

CREATE OR REPLACE FUNCTION public.prevent_cost_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'message_cost_events is append-only: % denied', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cost_events_no_update
  BEFORE UPDATE ON message_cost_events FOR EACH ROW
  EXECUTE FUNCTION prevent_cost_event_mutation();

CREATE TRIGGER trg_cost_events_no_delete
  BEFORE DELETE ON message_cost_events FOR EACH ROW
  EXECUTE FUNCTION prevent_cost_event_mutation();

-- ── 4. RLS ──

ALTER TABLE message_cost_events ENABLE ROW LEVEL SECURITY;

-- Business owners read cost events for their own attempts.
-- Uses SECURITY DEFINER helper to bypass inner-table RLS when resolving
-- attempt → business → owner_id chain. auth.uid() is called inside the
-- SECURITY DEFINER context where the auth schema is accessible.
CREATE OR REPLACE FUNCTION public.check_cost_event_owner(p_attempt_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_owner UUID;
  v_uid UUID;
BEGIN
  -- Resolve auth.uid() in SECURITY DEFINER context (auth schema accessible)
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RETURN false; END IF;

  SELECT b.owner_id INTO v_owner
    FROM public.message_send_attempts msa
    JOIN public.businesses b ON b.id = msa.business_id
    WHERE msa.id = p_attempt_id;

  RETURN COALESCE(v_owner = v_uid, false);
END;
$$;

REVOKE ALL ON FUNCTION public.check_cost_event_owner(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_cost_event_owner(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.check_cost_event_owner(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_cost_event_owner(UUID) TO service_role;

CREATE POLICY mce_owner_select ON message_cost_events
  FOR SELECT USING (public.check_cost_event_owner(attempt_id));

-- Platform admins read all (including platform-scoped)
CREATE POLICY mce_admin_select ON message_cost_events
  FOR SELECT USING (public.is_admin());

-- ── 6. Grants ──
-- Clean slate: revoke everything from application roles before explicit grants.
REVOKE ALL ON message_cost_events FROM PUBLIC, authenticated, service_role, anon;

-- Authenticated: SELECT only (through RLS)
GRANT SELECT ON message_cost_events TO authenticated;

-- Service-role: SELECT + INSERT (future #260 settlement authority writes here)
GRANT SELECT, INSERT ON message_cost_events TO service_role;
