-- ═══════════════════════════════════════════════════════
-- 368: Messaging Allowance Schema (A-1, #258)
--
-- Domain foundation tables for messaging cost accounting.
-- Schema only — no grant logic, consumption ordering,
-- spend authorization, trial lifecycle, or provider-send behavior.
--
-- messaging_allowances: per-business entitlement pools
-- messaging_allowance_events: append-only ledger of mutations
-- ═══════════════════════════════════════════════════════

-- ── 1. messaging_allowances ──

CREATE TABLE IF NOT EXISTS public.messaging_allowances (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  type              TEXT NOT NULL CHECK (type IN ('trial_grant', 'subscription_included', 'purchased', 'promotional')),
  amount_minor      INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency_code     TEXT NOT NULL,
  remaining_minor   INTEGER NOT NULL CHECK (remaining_minor >= 0),
  source_ref        TEXT NOT NULL,
  config_version_id UUID REFERENCES public.platform_config_versions(id),
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Exactly-once grant identity
  UNIQUE(business_id, type, source_ref),

  -- Remaining cannot exceed amount
  CHECK (remaining_minor <= amount_minor)
);

CREATE INDEX IF NOT EXISTS idx_ma_business ON messaging_allowances(business_id);
CREATE INDEX IF NOT EXISTS idx_ma_expires ON messaging_allowances(expires_at)
  WHERE expires_at IS NOT NULL;

-- ── 2. messaging_allowance_events ──

CREATE TABLE IF NOT EXISTS public.messaging_allowance_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  allowance_id      UUID NOT NULL REFERENCES public.messaging_allowances(id) ON DELETE RESTRICT,
  business_id       UUID NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  event_type        TEXT NOT NULL CHECK (event_type IN ('grant', 'reserve', 'charge', 'release', 'expire', 'adjust')),
  amount_minor      INTEGER NOT NULL,  -- signed: positive for grant/release, negative for reserve/charge
  attempt_id        UUID REFERENCES public.message_send_attempts(id),
  source_key        TEXT,
  charge_type       TEXT,
  balance_after_minor INTEGER NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- adjust requires non-null source_key
  CHECK (event_type <> 'adjust' OR source_key IS NOT NULL)
);

-- ── 3. Partial unique indexes (PostgreSQL NULL-safe idempotency) ──

-- One-shot non-attempt events: at most one grant and one expire per allowance
CREATE UNIQUE INDEX uq_allowance_events_grant
  ON messaging_allowance_events(allowance_id, event_type)
  WHERE event_type IN ('grant', 'expire');

-- One-shot attempt-bound events: at most one reserve, charge, release per (allowance, attempt)
CREATE UNIQUE INDEX uq_allowance_events_attempt
  ON messaging_allowance_events(allowance_id, event_type, attempt_id)
  WHERE attempt_id IS NOT NULL AND event_type IN ('reserve', 'charge', 'release');

-- Adjust replay: unique per (allowance, source_key)
CREATE UNIQUE INDEX uq_allowance_events_adjust
  ON messaging_allowance_events(allowance_id, event_type, source_key)
  WHERE event_type = 'adjust';

CREATE INDEX IF NOT EXISTS idx_mae_allowance ON messaging_allowance_events(allowance_id);
CREATE INDEX IF NOT EXISTS idx_mae_attempt ON messaging_allowance_events(attempt_id)
  WHERE attempt_id IS NOT NULL;

-- ── 4. Append-only enforcement (triggers block UPDATE/DELETE including service_role) ──

CREATE OR REPLACE FUNCTION public.prevent_allowance_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'messaging_allowance_events is append-only: % denied', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_allowance_events_no_update
  BEFORE UPDATE ON messaging_allowance_events FOR EACH ROW
  EXECUTE FUNCTION prevent_allowance_event_mutation();

CREATE TRIGGER trg_allowance_events_no_delete
  BEFORE DELETE ON messaging_allowance_events FOR EACH ROW
  EXECUTE FUNCTION prevent_allowance_event_mutation();

-- ── 5. RLS ──

ALTER TABLE messaging_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_allowance_events ENABLE ROW LEVEL SECURITY;

-- Business owners read their own allowances
CREATE POLICY ma_owner_select ON messaging_allowances
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM businesses WHERE id = messaging_allowances.business_id AND owner_id = auth.uid()
  ));

CREATE POLICY ma_admin_select ON messaging_allowances
  FOR SELECT USING (public.is_admin());

-- Business owners read their own events
CREATE POLICY mae_owner_select ON messaging_allowance_events
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM businesses WHERE id = messaging_allowance_events.business_id AND owner_id = auth.uid()
  ));

CREATE POLICY mae_admin_select ON messaging_allowance_events
  FOR SELECT USING (public.is_admin());

-- ── 6. Grants ──

-- Allowances: authenticated SELECT, service-role INSERT/UPDATE
GRANT SELECT ON messaging_allowances TO authenticated;
GRANT SELECT, INSERT, UPDATE ON messaging_allowances TO service_role;

-- Events: authenticated SELECT, service-role INSERT only (no UPDATE/DELETE — trigger-enforced)
GRANT SELECT ON messaging_allowance_events TO authenticated;
GRANT SELECT, INSERT ON messaging_allowance_events TO service_role;
