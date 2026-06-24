-- Fix: security_sessions and security_events policies were missing TO service_role
-- Any authenticated user could read/write these tables

-- Drop the overly permissive policies
DROP POLICY IF EXISTS "security_sessions_service_all" ON security_sessions;
DROP POLICY IF EXISTS "security_events_service_all" ON security_events;

-- Re-create with proper service_role scoping
CREATE POLICY "security_sessions_service_all" ON security_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "security_events_service_all" ON security_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Drop the old user select policy (will be replaced with consistent naming)
DROP POLICY IF EXISTS "security_sessions_user_select" ON security_sessions;

-- Users should only see their own sessions
CREATE POLICY "Users view own sessions" ON security_sessions
  FOR SELECT USING (user_id = auth.uid());

-- Users should only see their own security events
CREATE POLICY "Users view own events" ON security_events
  FOR SELECT USING (user_id = auth.uid());

-- Drop the old admin-only select (replaced by user-scoped policy above)
DROP POLICY IF EXISTS "security_events_admin_select" ON security_events;
