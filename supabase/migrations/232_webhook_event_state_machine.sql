-- ═══════════════════════════════════════════════════════
-- Migration 232: Webhook Event State Machine
-- ═══════════════════════════════════════════════════════
-- Enhances processed_webhook_events with a proper state machine
-- to support retry logic, failure tracking, and correlation.
--
-- States: received → processing → completed | failed
--
-- This is additive — existing upsert code continues to work
-- because status defaults to 'completed' and all new columns
-- have sensible defaults.
-- ═══════════════════════════════════════════════════════

-- 1. Add state machine columns
ALTER TABLE processed_webhook_events
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed'
    CHECK (status IN ('received', 'processing', 'completed', 'failed')),
  ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS first_received_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;

-- 2. Backfill: existing records are all completed
UPDATE processed_webhook_events
  SET status = 'completed',
      completed_at = processed_at
  WHERE status IS NULL OR completed_at IS NULL;

-- 3. Index for finding failed/stale events for retry
CREATE INDEX IF NOT EXISTS idx_webhook_events_retry
  ON processed_webhook_events(status, last_attempted_at)
  WHERE status IN ('failed', 'processing');

-- 4. Index for cleanup of old completed events
CREATE INDEX IF NOT EXISTS idx_webhook_events_completed
  ON processed_webhook_events(completed_at)
  WHERE status = 'completed';
