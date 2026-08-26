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

-- RLS: service_role only
ALTER TABLE unmatched_delivery_statuses ENABLE ROW LEVEL SECURITY;
