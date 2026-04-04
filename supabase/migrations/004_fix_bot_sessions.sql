-- Fix bot_sessions column names to match application code

-- Rename columns
ALTER TABLE bot_sessions RENAME COLUMN phone TO whatsapp_number;
ALTER TABLE bot_sessions RENAME COLUMN step TO current_step;
ALTER TABLE bot_sessions RENAME COLUMN data TO session_data;

-- Add missing columns
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES profiles(id);
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours');

-- Recreate indexes with new column names
DROP INDEX IF EXISTS idx_bot_sessions_phone_business;
CREATE UNIQUE INDEX idx_bot_sessions_phone_business
  ON bot_sessions(whatsapp_number, business_id) WHERE business_id IS NOT NULL;

DROP INDEX IF EXISTS idx_bot_sessions_phone;
CREATE INDEX idx_bot_sessions_phone ON bot_sessions(whatsapp_number);

-- Index for active sessions lookup
CREATE INDEX IF NOT EXISTS idx_bot_sessions_active ON bot_sessions(whatsapp_number, is_active) WHERE is_active = true;
