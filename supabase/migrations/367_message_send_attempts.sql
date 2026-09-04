-- ═══════════════════════════════════════════════════════
-- 367: Message Send Attempt Schema (M-1, #257)
--
-- Pre-WAMID identity for every outbound Meta message.
-- Attempt UUID is bound to business BEFORE Meta call.
-- Financial disposition tracks reservation/settlement lifecycle.
-- Feature-gated: gate OFF = best-effort; gate ON = fail-closed.
-- ═══════════════════════════════════════════════════════

-- ── 1. Create message_send_attempts table ──

CREATE TABLE IF NOT EXISTS public.message_send_attempts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  attempt_scope         TEXT NOT NULL DEFAULT 'business'
                        CHECK (attempt_scope IN ('business', 'platform')),
  channel_id            UUID,
  phone_number_id       TEXT,
  recipient_phone       TEXT NOT NULL,
  recipient_country_code TEXT,
  flow_type             TEXT,
  session_id            UUID,
  transaction_ref       TEXT,
  message_category      TEXT,
  template_name         TEXT,
  is_free_entry_point   BOOLEAN DEFAULT false,
  meta_message_id       TEXT,
  config_version_id     UUID REFERENCES public.platform_config_versions(id),
  estimated_cost_minor  INTEGER,
  currency_code         TEXT,
  status                TEXT NOT NULL DEFAULT 'pending_authorization'
                        CHECK (status IN (
                          'pending_authorization', 'sending', 'accepted',
                          'failed_send', 'ambiguous', 'review_required'
                        )),
  financial_disposition TEXT NOT NULL DEFAULT 'pending_authorization'
                        CHECK (financial_disposition IN (
                          'pending_authorization', 'reserved', 'charged', 'released'
                        )),
  spend_period_start    TIMESTAMPTZ,
  needs_reconciliation  BOOLEAN NOT NULL DEFAULT false,
  reserved_at           TIMESTAMPTZ DEFAULT NOW(),
  sent_at               TIMESTAMPTZ,
  meta_accepted_at      TIMESTAMPTZ,
  reservation_expires_at TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Business scope requires business_id; platform scope allows NULL
  CONSTRAINT chk_business_scope CHECK (
    attempt_scope = 'platform' OR business_id IS NOT NULL
  )
);

-- ── 2. Indexes ──

CREATE INDEX IF NOT EXISTS idx_msa_business_id ON message_send_attempts(business_id);
CREATE INDEX IF NOT EXISTS idx_msa_meta_message_id ON message_send_attempts(meta_message_id)
  WHERE meta_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msa_status ON message_send_attempts(status)
  WHERE status NOT IN ('accepted', 'failed_send');
CREATE INDEX IF NOT EXISTS idx_msa_business_status ON message_send_attempts(business_id, status);
CREATE INDEX IF NOT EXISTS idx_msa_session ON message_send_attempts(session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msa_needs_reconciliation ON message_send_attempts(needs_reconciliation)
  WHERE needs_reconciliation = true;

-- ── 3. State transition enforcement ──

CREATE OR REPLACE FUNCTION public.enforce_attempt_status_transitions()
RETURNS TRIGGER AS $$
BEGIN
  -- Terminal statuses are write-once (except ambiguous → review_required)
  IF OLD.status IN ('accepted', 'failed_send', 'review_required')
     AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'attempt status is terminal: cannot change from % to %',
      OLD.status, NEW.status;
  END IF;

  -- Valid transitions only
  IF NOT (
    (OLD.status = 'pending_authorization' AND NEW.status IN ('sending', 'failed_send')) OR
    (OLD.status = 'sending' AND NEW.status IN ('accepted', 'failed_send', 'ambiguous')) OR
    (OLD.status = 'ambiguous' AND NEW.status IN ('accepted', 'failed_send', 'review_required')) OR
    (OLD.status = NEW.status)  -- no-op
  ) THEN
    RAISE EXCEPTION 'Invalid attempt status transition: % → %',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_attempt_status_transitions
  BEFORE UPDATE ON message_send_attempts FOR EACH ROW
  EXECUTE FUNCTION enforce_attempt_status_transitions();

-- ── 4. Financial disposition transition enforcement ──

CREATE OR REPLACE FUNCTION public.enforce_disposition_transitions()
RETURNS TRIGGER AS $$
BEGIN
  -- Write-once: terminal states are immutable
  IF OLD.financial_disposition IN ('charged', 'released')
     AND NEW.financial_disposition <> OLD.financial_disposition THEN
    RAISE EXCEPTION 'financial_disposition is write-once after terminal settlement: cannot change from % to %',
      OLD.financial_disposition, NEW.financial_disposition;
  END IF;

  -- Only valid transitions
  IF NOT (
    (OLD.financial_disposition = 'pending_authorization' AND NEW.financial_disposition = 'reserved') OR
    (OLD.financial_disposition = 'reserved' AND NEW.financial_disposition IN ('charged', 'released')) OR
    (OLD.financial_disposition = NEW.financial_disposition)  -- no-op
  ) THEN
    RAISE EXCEPTION 'Invalid financial_disposition transition: % → %',
      OLD.financial_disposition, NEW.financial_disposition;
  END IF;

  -- spend_period_start is immutable after binding
  IF OLD.spend_period_start IS NOT NULL
     AND NEW.spend_period_start IS DISTINCT FROM OLD.spend_period_start THEN
    RAISE EXCEPTION 'spend_period_start is immutable after binding';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_disposition_transitions
  BEFORE UPDATE ON message_send_attempts FOR EACH ROW
  EXECUTE FUNCTION enforce_disposition_transitions();

-- ── 5. meta_message_id immutability (write-once after persistence) ──

CREATE OR REPLACE FUNCTION public.enforce_wamid_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.meta_message_id IS NOT NULL
     AND NEW.meta_message_id IS DISTINCT FROM OLD.meta_message_id THEN
    RAISE EXCEPTION 'meta_message_id is write-once after WAMID persistence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_wamid_immutability
  BEFORE UPDATE ON message_send_attempts FOR EACH ROW
  EXECUTE FUNCTION enforce_wamid_immutability();

-- ── 6. RLS ──

ALTER TABLE message_send_attempts ENABLE ROW LEVEL SECURITY;

-- Business owners can read their own attempts
CREATE POLICY msa_business_select ON message_send_attempts
  FOR SELECT USING (
    business_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM businesses WHERE id = message_send_attempts.business_id AND owner_id = auth.uid()
    )
  );

-- Platform admins can read all
CREATE POLICY msa_admin_select ON message_send_attempts
  FOR SELECT USING (public.is_admin());

-- Service role mutations (backend only)
GRANT SELECT, INSERT, UPDATE ON message_send_attempts TO service_role;
GRANT SELECT ON message_send_attempts TO authenticated;
