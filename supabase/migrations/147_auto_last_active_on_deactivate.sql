-- Automatically update last_active_at when a bot session is deactivated.
-- This ensures returning-customer routing always picks the most recently used business,
-- regardless of which code path deactivates the session.

CREATE OR REPLACE FUNCTION update_last_active_on_deactivate()
RETURNS TRIGGER AS $$
BEGIN
  -- Only fire when is_active changes from true to false
  IF OLD.is_active = true AND NEW.is_active = false THEN
    NEW.last_active_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bot_session_deactivate ON bot_sessions;

CREATE TRIGGER trg_bot_session_deactivate
  BEFORE UPDATE ON bot_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_last_active_on_deactivate();
