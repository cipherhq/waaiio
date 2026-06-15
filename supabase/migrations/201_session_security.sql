-- Session security: track active sessions and security events

-- Active login sessions (for session binding + concurrent detection)
CREATE TABLE IF NOT EXISTS security_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  user_agent_hash TEXT NOT NULL,
  country TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_security_sessions_user ON security_sessions(user_id, is_active, last_seen_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_security_sessions_session ON security_sessions(session_id) WHERE is_active = true;

ALTER TABLE security_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "security_sessions_user_select" ON security_sessions FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "security_sessions_service_all" ON security_sessions FOR ALL USING (true);

-- Security events log (detailed, admin-visible)
CREATE TABLE IF NOT EXISTS security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type, created_at DESC);

ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "security_events_admin_select" ON security_events FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'support', 'finance', 'operations'))
);
CREATE POLICY "security_events_service_all" ON security_events FOR ALL USING (true);

-- Ensure last_login_at is indexed for reporting
CREATE INDEX IF NOT EXISTS idx_profiles_last_login ON profiles(last_login_at DESC) WHERE last_login_at IS NOT NULL;
