-- Queue enhancements: priority/VIP handling
-- Add priority_level column to queue_entries
ALTER TABLE queue_entries ADD COLUMN priority_level VARCHAR(10)
  DEFAULT 'normal' CHECK (priority_level IN ('normal', 'vip', 'urgent'));

-- Index for priority-based ordering
CREATE INDEX idx_queue_entries_priority ON queue_entries (business_id, queue_date, priority_level, queue_number);
