-- Fix bot session race condition: two simultaneous messages can create duplicate active sessions
-- Partial unique index ensures only one active session per phone number per business
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_sessions_unique_active
  ON bot_sessions (whatsapp_number, business_id)
  WHERE is_active = true;

-- Also cover null business_id (cross-business sessions like "my bookings")
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_sessions_unique_active_null_biz
  ON bot_sessions (whatsapp_number)
  WHERE is_active = true AND business_id IS NULL;
