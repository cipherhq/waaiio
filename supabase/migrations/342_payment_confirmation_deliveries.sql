-- Migration 342: Payment confirmation delivery tracking + RPCs
--
-- Tracks per-attempt WhatsApp delivery state for payment confirmations.
-- Separates Meta API acceptance from actual delivery truth.
--
-- State machine:
--   claiming → sending → accepted → sent → delivered → read
--                  ↓         ↓        ↓
--              failed    failed    failed
--                  ↓
--           indeterminate
--
-- 'claiming' = pre-send claim acquired, external call NOT authorized
-- 'sending'  = send authorized via begin_confirmation_send, Meta call imminent
-- Once 'sending', worker death/lease expiry NEVER authorizes another send.
--
-- attempt_source is provenance only, NOT a separate retry authority.
-- All blocking/numbering/max-attempt logic is payment-wide across all sources.

-- ═══════════════════════════════════════════════════════
-- Table: payment_confirmation_deliveries
-- ═══════════════════════════════════════════════════════

CREATE TABLE payment_confirmation_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id),

  -- Attempt identity (payment-wide numbering, NOT per-source)
  attempt_number SMALLINT NOT NULL DEFAULT 1,
  attempt_source TEXT NOT NULL CHECK (attempt_source IN (
    'webhook_stage3',
    'ive_paid_recovery'
  )),

  -- Worker claim (short lease for pre-send 'claiming' only)
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  claim_expires_at TIMESTAMPTZ,

  -- Meta correlation
  meta_message_id TEXT,

  -- Delivery state machine (monotonic)
  delivery_status TEXT NOT NULL DEFAULT 'claiming' CHECK (delivery_status IN (
    'claiming',
    'sending',
    'accepted',
    'sent',
    'delivered',
    'read',
    'failed',
    'indeterminate'
  )),

  -- Timestamps: set ONLY when the specific state is observed
  accepted_at TIMESTAMPTZ,       -- local API-acceptance observation time
  sent_at TIMESTAMPTZ,           -- actual Meta 'sent' callback timestamp
  delivered_at TIMESTAMPTZ,      -- actual Meta 'delivered' callback timestamp
  read_at TIMESTAMPTZ,           -- actual Meta 'read' callback timestamp
  failed_at TIMESTAMPTZ,         -- known failure timestamp
  indeterminate_at TIMESTAMPTZ,  -- uncertain send timestamp (NOT a failure)

  -- Failure diagnostics
  failure_code TEXT,
  failure_reason TEXT,

  -- Channel used
  channel_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(payment_id, attempt_number)
);

-- WAMID lookup for Meta status webhooks
CREATE UNIQUE INDEX idx_pcd_meta_message_id
  ON payment_confirmation_deliveries(meta_message_id)
  WHERE meta_message_id IS NOT NULL;

-- Payment-scoped queries
CREATE INDEX idx_pcd_payment_id ON payment_confirmation_deliveries(payment_id);

-- RLS: service_role only (no browser/SSR access)
ALTER TABLE payment_confirmation_deliveries ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- RPC: claim_confirmation_delivery
-- Serializes on the parent payments row (always exists).
-- Creates a pre-send claim. attempt_source is provenance only.
-- All blocking/numbering is payment-wide across all sources.
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION claim_confirmation_delivery(
  p_payment_id UUID,
  p_attempt_source TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
  v_existing RECORD;
  v_token UUID;
  v_attempt_num SMALLINT;
BEGIN
  -- Validate attempt_source
  IF p_attempt_source NOT IN ('webhook_stage3', 'ive_paid_recovery') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'invalid_attempt_source');
  END IF;

  -- ══ Serialize on the parent payments row (always exists) ══
  SELECT id, status FROM payments
  WHERE id = p_payment_id
  FOR UPDATE
  INTO v_payment;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'payment_not_found');
  END IF;

  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'payment_not_successful');
  END IF;

  -- ══ With payment lock held, inspect ALL delivery attempts (payment-wide) ══

  -- Block if any attempt is in a non-terminal active state
  SELECT id, delivery_status, claim_expires_at
  INTO v_existing
  FROM payment_confirmation_deliveries
  WHERE payment_id = p_payment_id
    AND delivery_status IN ('claiming', 'sending', 'accepted', 'sent', 'indeterminate')
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_existing.delivery_status = 'claiming' THEN
      -- Check if lease expired (worker died before begin_confirmation_send)
      IF v_existing.claim_expires_at IS NOT NULL AND v_existing.claim_expires_at > NOW() THEN
        RETURN jsonb_build_object('claimed', false, 'reason', 'claiming_in_progress');
      END IF;
      -- Expired 'claiming' = worker died BEFORE send authorization → safe to reclaim
      UPDATE payment_confirmation_deliveries
      SET delivery_status = 'failed',
          failure_reason = 'claim_expired_before_send',
          failed_at = NOW(),
          claim_token = NULL,
          updated_at = NOW()
      WHERE id = v_existing.id;
      -- Fall through to create new attempt
    ELSE
      -- sending/accepted/sent/indeterminate: provider side effect may exist → block
      RETURN jsonb_build_object(
        'claimed', false,
        'reason', 'active_delivery_' || v_existing.delivery_status
      );
    END IF;
  END IF;

  -- Block if already delivered/read
  PERFORM id FROM payment_confirmation_deliveries
  WHERE payment_id = p_payment_id
    AND delivery_status IN ('delivered', 'read')
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_delivered');
  END IF;

  -- Compute next attempt number (payment-wide, not per-source)
  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_attempt_num
  FROM payment_confirmation_deliveries
  WHERE payment_id = p_payment_id;

  -- Bounded retry limit (payment-wide max 3)
  IF v_attempt_num > 3 THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'max_attempts_exceeded');
  END IF;

  v_token := gen_random_uuid();

  INSERT INTO payment_confirmation_deliveries (
    payment_id, attempt_number, attempt_source,
    claim_token, claimed_at, claim_expires_at,
    delivery_status
  ) VALUES (
    p_payment_id, v_attempt_num, p_attempt_source,
    v_token, NOW(), NOW() + INTERVAL '2 minutes',
    'claiming'
  );

  RETURN jsonb_build_object(
    'claimed', true,
    'claim_token', v_token,
    'attempt_number', v_attempt_num,
    'attempt_id', (SELECT id FROM payment_confirmation_deliveries
                   WHERE payment_id = p_payment_id AND attempt_number = v_attempt_num)
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: begin_confirmation_send
-- Authorizes the external Meta call. Only 'claiming' → 'sending'.
-- After this succeeds, worker death NEVER authorizes another send.
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION begin_confirmation_send(
  p_attempt_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempt RECORD;
BEGIN
  SELECT id, delivery_status, claim_token, claim_expires_at
  INTO v_attempt
  FROM payment_confirmation_deliveries
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'attempt_not_found');
  END IF;

  IF v_attempt.delivery_status != 'claiming' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'not_in_claiming_state');
  END IF;

  IF v_attempt.claim_token IS NULL OR v_attempt.claim_token != p_claim_token THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'token_mismatch');
  END IF;

  IF v_attempt.claim_expires_at IS NOT NULL AND v_attempt.claim_expires_at <= NOW() THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'claim_expired');
  END IF;

  -- Authorize: transition to 'sending', clear lease
  UPDATE payment_confirmation_deliveries
  SET delivery_status = 'sending',
      claim_expires_at = NULL,
      updated_at = NOW()
  WHERE id = p_attempt_id;

  RETURN jsonb_build_object('authorized', true);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: complete_confirmation_send
-- Records Meta acceptance with WAMID. Only 'sending' → 'accepted'.
-- Drains any unmatched status callbacks for this WAMID under advisory lock.
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION complete_confirmation_send(
  p_attempt_id UUID,
  p_claim_token UUID,
  p_meta_message_id TEXT,
  p_accepted_at TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempt RECORD;
  v_unmatched RECORD;
  v_rank_current INT;
  v_rank_new INT;
BEGIN
  -- WAMID must be non-blank
  IF p_meta_message_id IS NULL OR TRIM(p_meta_message_id) = '' THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'blank_wamid');
  END IF;

  SELECT id, delivery_status, claim_token
  INTO v_attempt
  FROM payment_confirmation_deliveries
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'attempt_not_found');
  END IF;

  -- Idempotent for same-attempt/same-WAMID retry (DB write/response loss recovery)
  IF v_attempt.delivery_status != 'sending' THEN
    -- If already accepted with the same WAMID, treat as idempotent success
    IF v_attempt.delivery_status IN ('accepted', 'sent', 'delivered', 'read')
       AND EXISTS (SELECT 1 FROM payment_confirmation_deliveries WHERE id = p_attempt_id AND meta_message_id = p_meta_message_id) THEN
      RETURN jsonb_build_object('completed', true, 'already_completed', true);
    END IF;
    RETURN jsonb_build_object('completed', false, 'reason', 'not_in_sending_state');
  END IF;

  IF v_attempt.claim_token IS NULL OR v_attempt.claim_token != p_claim_token THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'token_mismatch');
  END IF;

  -- Take advisory lock keyed on WAMID to serialize with status callbacks
  PERFORM pg_advisory_xact_lock(hashtext(p_meta_message_id));

  -- Attach WAMID and transition to accepted
  UPDATE payment_confirmation_deliveries
  SET delivery_status = 'accepted',
      meta_message_id = p_meta_message_id,
      accepted_at = p_accepted_at,
      claim_token = NULL,
      updated_at = NOW()
  WHERE id = p_attempt_id;

  -- Drain any unmatched status callbacks for this WAMID
  FOR v_unmatched IN
    SELECT id, status, provider_timestamp, error_code, error_reason
    FROM unmatched_delivery_statuses
    WHERE meta_message_id = p_meta_message_id
    ORDER BY received_at ASC
    FOR UPDATE
  LOOP
    -- Apply monotonically: compute ranks
    SELECT CASE delivery_status
      WHEN 'accepted' THEN 2 WHEN 'sent' THEN 3
      WHEN 'delivered' THEN 4 WHEN 'read' THEN 5
      ELSE -1 END
    INTO v_rank_current
    FROM payment_confirmation_deliveries WHERE id = p_attempt_id;

    v_rank_new := CASE v_unmatched.status
      WHEN 'sent' THEN 3 WHEN 'delivered' THEN 4
      WHEN 'read' THEN 5 ELSE -1 END;

    IF v_unmatched.status = 'failed' THEN
      -- Failed only from pre-delivery states
      IF v_rank_current <= 3 THEN -- accepted or sent
        UPDATE payment_confirmation_deliveries
        SET delivery_status = 'failed',
            failure_code = v_unmatched.error_code,
            failure_reason = v_unmatched.error_reason,
            failed_at = v_unmatched.provider_timestamp,
            updated_at = NOW()
        WHERE id = p_attempt_id;
      END IF;
    ELSIF v_rank_new > v_rank_current THEN
      UPDATE payment_confirmation_deliveries
      SET delivery_status = v_unmatched.status,
          sent_at = CASE WHEN v_unmatched.status = 'sent' AND sent_at IS NULL
                         THEN v_unmatched.provider_timestamp ELSE sent_at END,
          delivered_at = CASE WHEN v_unmatched.status = 'delivered' AND delivered_at IS NULL
                              THEN v_unmatched.provider_timestamp ELSE delivered_at END,
          read_at = CASE WHEN v_unmatched.status = 'read' AND read_at IS NULL
                         THEN v_unmatched.provider_timestamp ELSE read_at END,
          updated_at = NOW()
      WHERE id = p_attempt_id;
    END IF;

    DELETE FROM unmatched_delivery_statuses WHERE id = v_unmatched.id;
  END LOOP;

  RETURN jsonb_build_object('completed', true);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: fail_confirmation_send
-- Records known failure or indeterminate state.
-- 'indeterminate' only valid from 'sending'.
-- 'failed' valid from 'claiming' or 'sending'.
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fail_confirmation_send(
  p_attempt_id UUID,
  p_claim_token UUID,
  p_failure_type TEXT,
  p_failure_code TEXT DEFAULT NULL,
  p_failure_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempt RECORD;
BEGIN
  -- Validate p_failure_type exactly
  IF p_failure_type NOT IN ('failed', 'indeterminate') THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'invalid_failure_type');
  END IF;

  SELECT id, delivery_status, claim_token
  INTO v_attempt
  FROM payment_confirmation_deliveries
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'attempt_not_found');
  END IF;

  -- Claim token must match
  IF v_attempt.claim_token IS NULL OR v_attempt.claim_token != p_claim_token THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'token_mismatch');
  END IF;

  -- 'indeterminate' ONLY valid from 'sending' (external side effect uncertain)
  IF p_failure_type = 'indeterminate' THEN
    IF v_attempt.delivery_status != 'sending' THEN
      RETURN jsonb_build_object('recorded', false, 'reason', 'indeterminate_only_from_sending');
    END IF;
    UPDATE payment_confirmation_deliveries
    SET delivery_status = 'indeterminate',
        indeterminate_at = NOW(),
        failure_code = p_failure_code,
        failure_reason = p_failure_reason,
        claim_token = NULL,
        updated_at = NOW()
    WHERE id = p_attempt_id;
    RETURN jsonb_build_object('recorded', true);
  END IF;

  -- 'failed' valid from 'claiming' (pre-send) or 'sending' (known provider error)
  IF v_attempt.delivery_status NOT IN ('claiming', 'sending') THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'cannot_fail_from_' || v_attempt.delivery_status);
  END IF;

  UPDATE payment_confirmation_deliveries
  SET delivery_status = 'failed',
      failed_at = NOW(),
      failure_code = p_failure_code,
      failure_reason = p_failure_reason,
      claim_token = NULL,
      updated_at = NOW()
  WHERE id = p_attempt_id;

  RETURN jsonb_build_object('recorded', true);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: advance_delivery_status
-- Monotonic status advancement from Meta status callbacks.
-- Keyed by WAMID. Uses advisory lock for WAMID race safety.
-- Provider timestamps only for observed events; no fabrication.
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION advance_delivery_status(
  p_meta_message_id TEXT,
  p_new_status TEXT,
  p_provider_timestamp TIMESTAMPTZ,
  p_error_code TEXT DEFAULT NULL,
  p_error_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempt RECORD;
  v_rank_current INT;
  v_rank_new INT;
  v_allowed_failed_from TEXT[] := ARRAY['claiming', 'sending', 'accepted', 'sent'];
BEGIN
  IF p_new_status NOT IN ('sent', 'delivered', 'read', 'failed') THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'invalid_status');
  END IF;

  -- Advisory lock keyed on WAMID to serialize with complete_confirmation_send
  PERFORM pg_advisory_xact_lock(hashtext(p_meta_message_id));

  -- Look up attempt by WAMID
  SELECT id, delivery_status, payment_id
  INTO v_attempt
  FROM payment_confirmation_deliveries
  WHERE meta_message_id = p_meta_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- WAMID not yet attached — record for later drain
    INSERT INTO unmatched_delivery_statuses (
      meta_message_id, status, provider_timestamp,
      error_code, error_reason, received_at
    ) VALUES (
      p_meta_message_id, p_new_status, p_provider_timestamp,
      p_error_code, p_error_reason, NOW()
    )
    ON CONFLICT (meta_message_id, status) DO NOTHING;

    RETURN jsonb_build_object('advanced', false, 'reason', 'wamid_not_found_recorded_unmatched');
  END IF;

  -- Monotonic rank: claiming=0, sending=1, accepted=2, sent=3, delivered=4, read=5
  v_rank_current := CASE v_attempt.delivery_status
    WHEN 'claiming' THEN 0 WHEN 'sending' THEN 1
    WHEN 'accepted' THEN 2 WHEN 'sent' THEN 3
    WHEN 'delivered' THEN 4 WHEN 'read' THEN 5
    ELSE -1 END;

  v_rank_new := CASE p_new_status
    WHEN 'sent' THEN 3 WHEN 'delivered' THEN 4
    WHEN 'read' THEN 5 ELSE -1 END;

  -- Handle 'failed': only from pre-delivery states
  IF p_new_status = 'failed' THEN
    IF v_attempt.delivery_status = ANY(v_allowed_failed_from) THEN
      UPDATE payment_confirmation_deliveries
      SET delivery_status = 'failed',
          failure_code = p_error_code,
          failure_reason = p_error_reason,
          failed_at = p_provider_timestamp,
          claim_expires_at = NULL,
          updated_at = NOW()
      WHERE id = v_attempt.id;
      RETURN jsonb_build_object('advanced', true, 'previous', v_attempt.delivery_status);
    ELSE
      RETURN jsonb_build_object('advanced', false, 'reason', 'cannot_fail_from_' || v_attempt.delivery_status);
    END IF;
  END IF;

  -- Monotonic forward (allow jumps, e.g. accepted→delivered)
  IF v_rank_new <= v_rank_current THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'already_at_or_past_' || p_new_status);
  END IF;

  -- Advance state — set ONLY the timestamp for the OBSERVED callback
  UPDATE payment_confirmation_deliveries
  SET delivery_status = p_new_status,
      sent_at = CASE WHEN p_new_status = 'sent' AND sent_at IS NULL
                     THEN p_provider_timestamp ELSE sent_at END,
      delivered_at = CASE WHEN p_new_status = 'delivered' AND delivered_at IS NULL
                         THEN p_provider_timestamp ELSE delivered_at END,
      read_at = CASE WHEN p_new_status = 'read' AND read_at IS NULL
                     THEN p_provider_timestamp ELSE read_at END,
      updated_at = NOW()
  WHERE id = v_attempt.id;

  RETURN jsonb_build_object('advanced', true, 'previous', v_attempt.delivery_status);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Privilege restrictions (proven pattern from migration 307)
-- ═══════════════════════════════════════════════════════

DO $$ BEGIN
  -- Revoke from PUBLIC, anon, and authenticated (defense in depth)
  REVOKE ALL ON FUNCTION claim_confirmation_delivery(UUID, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION begin_confirmation_send(UUID, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION complete_confirmation_send(UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;
  REVOKE ALL ON FUNCTION fail_confirmation_send(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION advance_delivery_status(TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT) FROM PUBLIC;

  EXECUTE 'REVOKE ALL ON FUNCTION claim_confirmation_delivery(UUID, TEXT) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION begin_confirmation_send(UUID, UUID) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION complete_confirmation_send(UUID, UUID, TEXT, TIMESTAMPTZ) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION fail_confirmation_send(UUID, UUID, TEXT, TEXT, TEXT) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION advance_delivery_status(TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT) FROM anon';

  EXECUTE 'REVOKE ALL ON FUNCTION claim_confirmation_delivery(UUID, TEXT) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION begin_confirmation_send(UUID, UUID) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION complete_confirmation_send(UUID, UUID, TEXT, TIMESTAMPTZ) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION fail_confirmation_send(UUID, UUID, TEXT, TEXT, TEXT) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION advance_delivery_status(TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT) FROM authenticated';

  -- Grant only to service_role
  EXECUTE 'GRANT EXECUTE ON FUNCTION claim_confirmation_delivery(UUID, TEXT) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION begin_confirmation_send(UUID, UUID) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION complete_confirmation_send(UUID, UUID, TEXT, TIMESTAMPTZ) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION fail_confirmation_send(UUID, UUID, TEXT, TEXT, TEXT) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION advance_delivery_status(TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT) TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
