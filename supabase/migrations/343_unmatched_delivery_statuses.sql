-- Migration 343: Unmatched delivery statuses for WAMID race resolution
--
-- When a Meta status callback arrives before the WAMID is attached to
-- the payment_confirmation_deliveries row (normal race condition),
-- the callback is recorded here for later drain by complete_confirmation_send.
--
-- This table ONLY handles the known-WAMID race (sendText returned a WAMID
-- but DB attachment is a few ms behind). It does NOT solve no-WAMID timeouts.
--
-- Entries have a 1-hour TTL for cleanup of orphaned callbacks.

CREATE TABLE unmatched_delivery_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  provider_timestamp TIMESTAMPTZ,
  error_code TEXT,
  error_reason TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(meta_message_id, status)
);

-- Lookup by WAMID for drain
CREATE INDEX idx_uds_meta_message_id ON unmatched_delivery_statuses(meta_message_id);

-- Cleanup index for bounded retention
CREATE INDEX idx_uds_received_at ON unmatched_delivery_statuses(received_at);

-- RLS: service_role only
ALTER TABLE unmatched_delivery_statuses ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- Bounded retention: cleanup orphaned unmatched callbacks older than 1 hour.
-- Called opportunistically by advance_delivery_status (low frequency)
-- and can be called by a scheduled cron if needed.
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION cleanup_expired_unmatched_statuses()
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count INT;
BEGIN
  DELETE FROM unmatched_delivery_statuses
  WHERE received_at < NOW() - INTERVAL '1 hour';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Restrict to service_role
REVOKE ALL ON FUNCTION cleanup_expired_unmatched_statuses() FROM PUBLIC;
DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION cleanup_expired_unmatched_statuses() FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION cleanup_expired_unmatched_statuses() FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION cleanup_expired_unmatched_statuses() TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
