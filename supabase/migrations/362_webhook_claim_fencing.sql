-- ═══════════════════════════════════════════════════════
-- Migration 362: Webhook Claim Fencing
-- ═══════════════════════════════════════════════════════
-- Replaces the non-atomic SELECT→UPDATE dedup in the Meta webhook
-- handler with PostgreSQL-level atomic claims via RPCs.
--
-- Three RPCs:
--   claim_webhook_event   — atomic INSERT-or-reclaim with FOR UPDATE
--   complete_webhook_event — fenced completion (requires matching claim_token)
--   fail_webhook_event     — fenced failure (requires matching claim_token)
--
-- Refs: #278, #271
-- ═══════════════════════════════════════════════════════

-- 1. Add claim_token column
ALTER TABLE public.processed_webhook_events
  ADD COLUMN IF NOT EXISTS claim_token UUID;

-- 2. Ensure status CHECK constraint is correct (drop any stale version first)
ALTER TABLE public.processed_webhook_events DROP CONSTRAINT IF EXISTS processed_webhook_events_status_check;
ALTER TABLE public.processed_webhook_events ADD CONSTRAINT processed_webhook_events_status_check
  CHECK (status IN ('received', 'processing', 'completed', 'failed'));

-- 3. claim_webhook_event RPC
CREATE OR REPLACE FUNCTION public.claim_webhook_event(
  p_event_id TEXT,
  p_gateway TEXT,
  p_event_type TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.processed_webhook_events;
  v_claim_token UUID := gen_random_uuid();
  v_stale_threshold INTERVAL := '90 seconds';
BEGIN
  -- Try INSERT first (new event — most common path)
  INSERT INTO public.processed_webhook_events (
    event_id, gateway, event_type, status, attempts, claim_token,
    first_received_at, last_attempted_at
  )
  VALUES (
    p_event_id, p_gateway, p_event_type, 'processing', 1, v_claim_token,
    NOW(), NOW()
  )
  ON CONFLICT (event_id) DO NOTHING;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true, 'claim_token', v_claim_token);
  END IF;

  -- Existing row — lock and inspect
  SELECT * INTO v_row
    FROM public.processed_webhook_events
    WHERE event_id = p_event_id
    FOR UPDATE;

  IF NOT FOUND THEN
    -- Should not happen after ON CONFLICT DO NOTHING, but fail-closed
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;

  IF v_row.status = 'completed' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_completed');
  END IF;

  -- Active processing — not stale
  IF v_row.status = 'processing'
     AND v_row.last_attempted_at > NOW() - v_stale_threshold THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'active_processing');
  END IF;

  -- Stale processing or failed — reclaim atomically
  UPDATE public.processed_webhook_events
  SET status = 'processing',
      attempts = v_row.attempts + 1,
      claim_token = v_claim_token,
      last_attempted_at = NOW()
  WHERE event_id = p_event_id;

  RETURN jsonb_build_object('claimed', true, 'claim_token', v_claim_token);
END;
$$;

-- 4. complete_webhook_event RPC
CREATE OR REPLACE FUNCTION public.complete_webhook_event(
  p_event_id TEXT,
  p_claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.processed_webhook_events
  SET status = 'completed',
      completed_at = NOW()
  WHERE event_id = p_event_id
    AND claim_token = p_claim_token
    AND status = 'processing';
  RETURN FOUND;
END;
$$;

-- 5. fail_webhook_event RPC
CREATE OR REPLACE FUNCTION public.fail_webhook_event(
  p_event_id TEXT,
  p_claim_token UUID,
  p_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.processed_webhook_events
  SET status = 'failed',
      last_error = LEFT(p_error, 500),
      last_attempted_at = NOW()
  WHERE event_id = p_event_id
    AND claim_token = p_claim_token
    AND status = 'processing';
  RETURN FOUND;
END;
$$;

-- 6. Privilege lockdown — all three RPCs: service_role only
REVOKE ALL ON FUNCTION public.claim_webhook_event(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_webhook_event(TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.claim_webhook_event(TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_event(TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.complete_webhook_event(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_webhook_event(TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.complete_webhook_event(TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_webhook_event(TEXT, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.fail_webhook_event(TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_webhook_event(TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.fail_webhook_event(TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fail_webhook_event(TEXT, UUID, TEXT) TO service_role;
