-- Short-lived encrypted Meta authorization sessions. Staging rollout first.
CREATE TABLE public.whatsapp_signup_sessions (
  session_key text PRIMARY KEY CHECK (session_key ~ '^[a-f0-9]{64}$'),
  payload text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX whatsapp_signup_sessions_expiry_idx ON public.whatsapp_signup_sessions (expires_at);
ALTER TABLE public.whatsapp_signup_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_signup_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.whatsapp_signup_sessions TO service_role;
COMMENT ON TABLE public.whatsapp_signup_sessions IS 'AES-GCM encrypted, tenant/app/user-bound signup sessions; atomic DELETE RETURNING consumption; ten-minute expiry.';
