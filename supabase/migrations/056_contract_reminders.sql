-- Add reminder tracking columns to contracts
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS reminder_24h_sent boolean DEFAULT false;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS reminder_48h_sent boolean DEFAULT false;

-- Index for efficient reminder queries
CREATE INDEX IF NOT EXISTS idx_contracts_pending_reminders
  ON contracts(status, created_at) WHERE status = 'pending';
