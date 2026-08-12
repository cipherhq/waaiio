-- P1-QUEUE-1: Add 'cancelled' as a first-class queue_entries terminal state
-- P1-QUEUE-2: Create queue_reopen_subscriptions table for queue reopen notifications

-- ── P1-QUEUE-1: Expand queue_entries status CHECK constraint ──
-- Original constraint (migration 018): status IN ('waiting', 'serving', 'completed', 'no_show')
-- Adding 'cancelled' for voluntary customer leave (distinct from 'no_show' which means called but absent)

ALTER TABLE queue_entries
  DROP CONSTRAINT IF EXISTS queue_entries_status_check;

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_status_check
  CHECK (status IN ('waiting', 'serving', 'completed', 'no_show', 'cancelled'));

-- Allow transition waiting → cancelled in the API update route (code change, not SQL)
-- The active unique index (migration 304) already excludes cancelled:
--   WHERE status IN ('waiting', 'serving')
-- So cancelled entries don't block re-joining.

-- ── P1-QUEUE-2: Queue reopen notification subscriptions ──
-- Separate from waitlist_entries (which is booking-specific with service_id, event_id, auto-notify, conversion tracking)

CREATE TABLE IF NOT EXISTS queue_reopen_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone VARCHAR(20) NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'notified')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ
);

-- Only one active subscription per customer per business
CREATE UNIQUE INDEX idx_queue_reopen_sub_active
  ON queue_reopen_subscriptions (business_id, customer_phone)
  WHERE status = 'waiting';

-- Lookup index for notification dispatch on unpause
CREATE INDEX idx_queue_reopen_sub_business_status
  ON queue_reopen_subscriptions (business_id, status);

-- RLS
ALTER TABLE queue_reopen_subscriptions ENABLE ROW LEVEL SECURITY;

-- Business owners can view their subscriptions
CREATE POLICY "queue_reopen_sub_owner_select"
  ON queue_reopen_subscriptions FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Service role full access (bot inserts, API route updates on unpause)
CREATE POLICY "queue_reopen_sub_service_all"
  ON queue_reopen_subscriptions FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
