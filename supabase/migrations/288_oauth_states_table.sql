-- ═══════════════════════════════════════════════════════
-- 288: Dedicated OAuth states table with atomic consumption
--
-- Replaces platform_settings-based OAuth nonce storage with
-- a purpose-built table and a SECURITY DEFINER RPC that
-- atomically consumes state in a single UPDATE...RETURNING.
-- ═══════════════════════════════════════════════════════

CREATE TABLE public.oauth_states (
  nonce TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT false,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for cleanup cron (expired unconsumed states)
CREATE INDEX idx_oauth_states_expires ON public.oauth_states (expires_at) WHERE consumed = false;

-- RLS: only service_role should touch this table
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
-- No policies = deny all for anon/authenticated

-- Atomic consume function: UPDATE WHERE consumed=false RETURNING
-- Returns true only for the first caller; all others get false.
CREATE OR REPLACE FUNCTION public.consume_oauth_state(p_nonce TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_found BOOLEAN;
BEGIN
  UPDATE public.oauth_states
  SET consumed = true, consumed_at = NOW()
  WHERE nonce = p_nonce
    AND consumed = false
    AND expires_at > NOW()
  RETURNING true INTO v_found;

  RETURN COALESCE(v_found, false);
END;
$$;

-- Restrict to service_role only
REVOKE ALL ON FUNCTION public.consume_oauth_state(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_oauth_state(TEXT) TO service_role;

REVOKE ALL ON TABLE public.oauth_states FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.oauth_states TO service_role;
