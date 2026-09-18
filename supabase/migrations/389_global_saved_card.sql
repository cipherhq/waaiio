-- Migration 389: Global saved card — customer-scoped, cross-business reuse
--
-- Converts saved_payment_methods from business-scoped to customer-scoped:
-- - Deactivates existing active rows (no real users, test cards only)
-- - Makes business_id nullable (origin/audit metadata only)
-- - Changes FK lifecycle from CASCADE to SET NULL
-- - Adds authorization_email for Paystack email preservation
-- - Replaces business-scoped uniqueness with customer+gateway uniqueness
-- - Adds CHECK constraint for canonical +E.164 phone on active rows
-- - Removes merchant raw-table SELECT policy (global card = no merchant visibility)

-- 1. Deactivate all existing active saved cards (no real users yet)
UPDATE saved_payment_methods SET is_active = false WHERE is_active = true;

-- 2. Drop existing business-scoped unique constraint
ALTER TABLE saved_payment_methods
  DROP CONSTRAINT IF EXISTS saved_payment_methods_business_id_customer_phone_gateway_key;

-- 3. Make business_id nullable + change FK lifecycle
ALTER TABLE saved_payment_methods ALTER COLUMN business_id DROP NOT NULL;
ALTER TABLE saved_payment_methods DROP CONSTRAINT IF EXISTS saved_payment_methods_business_id_fkey;
ALTER TABLE saved_payment_methods
  ADD CONSTRAINT saved_payment_methods_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL;

-- 4. Add authorization_email column
ALTER TABLE saved_payment_methods ADD COLUMN IF NOT EXISTS authorization_email TEXT;

-- 5. Customer-scoped active uniqueness (one active card per customer per gateway)
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_pm_customer_gateway_active
  ON saved_payment_methods (customer_phone, gateway)
  WHERE is_active = true;

-- 6. Customer-scoped lookup index (replaces business-scoped)
DROP INDEX IF EXISTS idx_saved_pm_lookup;
CREATE INDEX IF NOT EXISTS idx_saved_pm_customer_lookup
  ON saved_payment_methods (customer_phone, is_active);

-- 7. CHECK constraint: active rows must have canonical +E.164 phone
-- Validates: starts with +, followed by 1-9, then 7-14 more digits
ALTER TABLE saved_payment_methods ADD CONSTRAINT chk_active_canonical_phone
  CHECK (NOT is_active OR customer_phone ~ '^\+[1-9]\d{7,14}$');

-- 8. Remove merchant raw-table SELECT policy (global card = no merchant visibility)
-- Retain only service_role access for runtime operations.
DROP POLICY IF EXISTS saved_pm_owner ON saved_payment_methods;
-- service_role policy already exists (ALL for service_role) — keep it.

-- ═══════════════════════════════════════════════════════
-- 9. payment_saved_card_offers — durable payment-scoped offer authority
--
-- One offer per payment. Prevents duplicate Save/Replace CTAs on webhook retry.
-- State machine: pending → sending → sent → accepted/declined
--                                    → ambiguous (no auto-resend)
-- Does NOT store provider secrets (auth code, email, PIN).
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_saved_card_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL UNIQUE,
  customer_phone TEXT NOT NULL CHECK (customer_phone ~ '^\+[1-9]\d{7,14}$'),
  business_id UUID NOT NULL,
  offer_type TEXT NOT NULL CHECK (offer_type IN ('save', 'replace')),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sending', 'sent', 'accepted', 'declined', 'ambiguous')),
  current_method_id UUID,
  card_display TEXT,
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  meta_message_id TEXT,
  sent_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_saved_card_offers ENABLE ROW LEVEL SECURITY;

-- Service-role only — no merchant/authenticated access
DO $$
BEGIN
  REVOKE ALL ON TABLE payment_saved_card_offers FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE payment_saved_card_offers FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE payment_saved_card_offers FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON TABLE payment_saved_card_offers FROM service_role;
    GRANT SELECT ON TABLE payment_saved_card_offers TO service_role;
    -- All mutations through SECURITY DEFINER RPCs below
  END IF;
END $$;

-- K8: Add referential integrity
ALTER TABLE payment_saved_card_offers
  ADD CONSTRAINT fk_offer_payment FOREIGN KEY (payment_id) REFERENCES payments(id),
  ADD CONSTRAINT fk_offer_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_channels(id) ON DELETE SET NULL;
-- current_method_id is a hint/locator, not authorization — FK for data integrity
ALTER TABLE payment_saved_card_offers
  ADD CONSTRAINT fk_offer_method FOREIGN KEY (current_method_id)
    REFERENCES saved_payment_methods(id) ON DELETE SET NULL;

-- ═══════════════════════════════════════════════════════
-- 10. Saved-card offer state-machine RPCs (K1)
--
-- M349 recurring-intent style: one row per payment, atomic create/claim,
-- FOR UPDATE transitions, claim-token fencing, terminal idempotency.
-- ═══════════════════════════════════════════════════════

-- Create or claim an offer (atomic, conflict-safe)
CREATE OR REPLACE FUNCTION create_or_claim_saved_card_offer(
  p_payment_id UUID,
  p_customer_phone TEXT,
  p_business_id UUID,
  p_offer_type TEXT,
  p_current_method_id UUID DEFAULT NULL,
  p_card_display TEXT DEFAULT NULL,
  p_channel_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing RECORD;
  v_token UUID;
BEGIN
  -- Check for existing offer
  SELECT * INTO v_existing FROM payment_saved_card_offers
  WHERE payment_id = p_payment_id FOR UPDATE;

  IF FOUND THEN
    -- Already exists — only claim if retryable (pending)
    IF v_existing.state = 'pending' THEN
      v_token := gen_random_uuid();
      UPDATE payment_saved_card_offers SET
        state = 'sending', claim_token = v_token,
        claim_expires_at = NOW() + INTERVAL '2 minutes'
      WHERE id = v_existing.id AND state = 'pending';
      RETURN jsonb_build_object('created', false, 'claimed', true,
        'offer_id', v_existing.id, 'claim_token', v_token, 'offer_type', v_existing.offer_type);
    END IF;
    -- Not retryable — return current state
    RETURN jsonb_build_object('created', false, 'claimed', false,
      'current_state', v_existing.state, 'offer_id', v_existing.id);
  END IF;

  -- Create new offer in sending state
  v_token := gen_random_uuid();
  INSERT INTO payment_saved_card_offers
    (payment_id, customer_phone, business_id, offer_type, current_method_id,
     card_display, channel_id, state, claim_token, claim_expires_at)
  VALUES
    (p_payment_id, p_customer_phone, p_business_id, p_offer_type, p_current_method_id,
     p_card_display, p_channel_id, 'sending', v_token, NOW() + INTERVAL '2 minutes')
  ON CONFLICT (payment_id) DO NOTHING;

  IF NOT FOUND THEN
    -- Concurrent insert won — re-read
    SELECT * INTO v_existing FROM payment_saved_card_offers
    WHERE payment_id = p_payment_id FOR UPDATE;
    RETURN jsonb_build_object('created', false, 'claimed', false,
      'current_state', v_existing.state, 'offer_id', v_existing.id);
  END IF;

  RETURN jsonb_build_object('created', true, 'claimed', true,
    'claim_token', v_token, 'offer_type', p_offer_type);
END;
$$;

-- Mark offer as sent (claim-token fenced)
CREATE OR REPLACE FUNCTION mark_saved_card_offer_sent(
  p_payment_id UUID,
  p_claim_token UUID,
  p_meta_message_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_offer RECORD;
BEGIN
  SELECT * INTO v_offer FROM payment_saved_card_offers
  WHERE payment_id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_found');
  END IF;
  IF v_offer.state != 'sending' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_sending', 'state', v_offer.state);
  END IF;
  IF v_offer.claim_token IS NULL OR v_offer.claim_token != p_claim_token THEN
    RETURN jsonb_build_object('success', false, 'reason', 'token_mismatch');
  END IF;

  UPDATE payment_saved_card_offers SET
    state = 'sent', meta_message_id = p_meta_message_id,
    sent_at = NOW(), claim_token = NULL, claim_expires_at = NULL
  WHERE id = v_offer.id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- Release failed send back to pending (claim-token fenced)
CREATE OR REPLACE FUNCTION release_saved_card_offer(
  p_payment_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_offer RECORD;
BEGIN
  SELECT * INTO v_offer FROM payment_saved_card_offers
  WHERE payment_id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'reason', 'not_found'); END IF;
  IF v_offer.state != 'sending' THEN RETURN jsonb_build_object('success', false, 'reason', 'not_sending'); END IF;
  IF v_offer.claim_token IS NULL OR v_offer.claim_token != p_claim_token THEN
    RETURN jsonb_build_object('success', false, 'reason', 'token_mismatch');
  END IF;

  UPDATE payment_saved_card_offers SET
    state = 'pending', claim_token = NULL, claim_expires_at = NULL
  WHERE id = v_offer.id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- Mark ambiguous (claim-token fenced)
CREATE OR REPLACE FUNCTION mark_saved_card_offer_ambiguous(
  p_payment_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_offer RECORD;
BEGIN
  SELECT * INTO v_offer FROM payment_saved_card_offers
  WHERE payment_id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'reason', 'not_found'); END IF;
  IF v_offer.state != 'sending' THEN RETURN jsonb_build_object('success', false, 'reason', 'not_sending'); END IF;
  IF v_offer.claim_token IS NULL OR v_offer.claim_token != p_claim_token THEN
    RETURN jsonb_build_object('success', false, 'reason', 'token_mismatch');
  END IF;

  UPDATE payment_saved_card_offers SET
    state = 'ambiguous', claim_token = NULL, claim_expires_at = NULL
  WHERE id = v_offer.id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- Accept offer (customer-phone + offer-type binding)
CREATE OR REPLACE FUNCTION accept_saved_card_offer(
  p_payment_id UUID,
  p_customer_phone TEXT,
  p_expected_offer_type TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_offer RECORD;
BEGIN
  SELECT * INTO v_offer FROM payment_saved_card_offers
  WHERE payment_id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_offer.customer_phone != p_customer_phone THEN
    RETURN jsonb_build_object('result', 'wrong_customer');
  END IF;
  IF v_offer.offer_type != p_expected_offer_type THEN
    RETURN jsonb_build_object('result', 'wrong_type');
  END IF;
  IF v_offer.state = 'accepted' THEN
    RETURN jsonb_build_object('result', 'already_accepted');
  END IF;
  IF v_offer.state = 'declined' THEN
    RETURN jsonb_build_object('result', 'declined');
  END IF;
  IF v_offer.state NOT IN ('sent', 'ambiguous') THEN
    RETURN jsonb_build_object('result', 'invalid_state', 'state', v_offer.state);
  END IF;

  UPDATE payment_saved_card_offers SET
    state = 'accepted', resolved_at = NOW()
  WHERE id = v_offer.id;

  RETURN jsonb_build_object('result', 'transitioned');
END;
$$;

-- Decline offer (customer-phone binding, idempotent)
CREATE OR REPLACE FUNCTION decline_saved_card_offer(
  p_payment_id UUID,
  p_customer_phone TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_offer RECORD;
BEGIN
  SELECT * INTO v_offer FROM payment_saved_card_offers
  WHERE payment_id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_offer.customer_phone != p_customer_phone THEN
    RETURN jsonb_build_object('result', 'wrong_customer');
  END IF;
  IF v_offer.state = 'declined' THEN
    RETURN jsonb_build_object('result', 'already_declined');
  END IF;
  IF v_offer.state = 'accepted' THEN
    RETURN jsonb_build_object('result', 'already_accepted');
  END IF;
  IF v_offer.state NOT IN ('sent', 'ambiguous') THEN
    RETURN jsonb_build_object('result', 'invalid_state', 'state', v_offer.state);
  END IF;

  UPDATE payment_saved_card_offers SET
    state = 'declined', resolved_at = NOW()
  WHERE id = v_offer.id;

  RETURN jsonb_build_object('result', 'transitioned');
END;
$$;

-- Privilege hardening for offer RPCs
DO $$
BEGIN
  REVOKE ALL ON FUNCTION create_or_claim_saved_card_offer(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION mark_saved_card_offer_sent(UUID, UUID, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION release_saved_card_offer(UUID, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION mark_saved_card_offer_ambiguous(UUID, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION accept_saved_card_offer(UUID, TEXT, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION decline_saved_card_offer(UUID, TEXT) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION create_or_claim_saved_card_offer(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID) FROM anon;
    REVOKE ALL ON FUNCTION mark_saved_card_offer_sent(UUID, UUID, TEXT) FROM anon;
    REVOKE ALL ON FUNCTION release_saved_card_offer(UUID, UUID) FROM anon;
    REVOKE ALL ON FUNCTION mark_saved_card_offer_ambiguous(UUID, UUID) FROM anon;
    REVOKE ALL ON FUNCTION accept_saved_card_offer(UUID, TEXT, TEXT) FROM anon;
    REVOKE ALL ON FUNCTION decline_saved_card_offer(UUID, TEXT) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION create_or_claim_saved_card_offer(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID) FROM authenticated;
    REVOKE ALL ON FUNCTION mark_saved_card_offer_sent(UUID, UUID, TEXT) FROM authenticated;
    REVOKE ALL ON FUNCTION release_saved_card_offer(UUID, UUID) FROM authenticated;
    REVOKE ALL ON FUNCTION mark_saved_card_offer_ambiguous(UUID, UUID) FROM authenticated;
    REVOKE ALL ON FUNCTION accept_saved_card_offer(UUID, TEXT, TEXT) FROM authenticated;
    REVOKE ALL ON FUNCTION decline_saved_card_offer(UUID, TEXT) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION create_or_claim_saved_card_offer(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION mark_saved_card_offer_sent(UUID, UUID, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION release_saved_card_offer(UUID, UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION mark_saved_card_offer_ambiguous(UUID, UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION accept_saved_card_offer(UUID, TEXT, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION decline_saved_card_offer(UUID, TEXT) TO service_role;
  END IF;
END $$;
