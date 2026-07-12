-- Add reminder_sent flag to event_tickets for deduplication
ALTER TABLE event_tickets ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT false;

-- Index for efficient reminder cron queries
CREATE INDEX IF NOT EXISTS idx_event_tickets_reminder_pending
  ON event_tickets (event_id)
  WHERE status = 'valid' AND reminder_sent = false;
