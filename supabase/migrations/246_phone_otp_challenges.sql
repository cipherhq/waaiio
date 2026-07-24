-- Phone OTP challenge table: server-side, single-use, opaque challenge system.
-- Replaces the stateless HMAC token that embedded the OTP in the client-visible pin_id.

CREATE TABLE IF NOT EXISTS public.phone_otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id varchar(64) NOT NULL UNIQUE,  -- UNIQUE constraint provides the index
  phone_hash varchar(128) NOT NULL,
  otp_hash varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz
);

-- Index for cleanup of expired records
CREATE INDEX idx_phone_otp_challenges_expires_at ON public.phone_otp_challenges (expires_at);

-- Enable RLS — no anonymous or authenticated client access
ALTER TABLE public.phone_otp_challenges ENABLE ROW LEVEL SECURITY;

-- Only service role can access this table
CREATE POLICY "service_role_full_access" ON public.phone_otp_challenges
  FOR ALL USING (auth.role() = 'service_role');

-- Explicit least-privilege table grants.
-- service_role needs SELECT (challenge lookup) and INSERT (challenge creation).
-- UPDATE and DELETE are performed only through SECURITY DEFINER RPCs which
-- execute as the function owner, so direct UPDATE/DELETE grants are not needed.
REVOKE ALL ON TABLE public.phone_otp_challenges FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.phone_otp_challenges TO service_role;

-- ══════════════════════════════════════════════════════════
-- Atomic failed-attempt increment
-- Increments using the database's current value (not read-modify-write).
-- Rejects consumed, expired, and already-locked challenges.
-- Returns the new failed_attempts count, or -1 if no row was updated.
-- ══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.otp_record_failed_attempt(p_challenge_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_count integer;
BEGIN
  UPDATE public.phone_otp_challenges
  SET
    failed_attempts = failed_attempts + 1,
    last_attempt_at = now()
  WHERE
    id = p_challenge_id
    AND consumed_at IS NULL
    AND expires_at > now()
    AND failed_attempts < 5
  RETURNING failed_attempts INTO v_new_count;

  RETURN COALESCE(v_new_count, -1);
END;
$$;

-- Restrict execution: service_role only
REVOKE EXECUTE ON FUNCTION public.otp_record_failed_attempt(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.otp_record_failed_attempt(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.otp_record_failed_attempt(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.otp_record_failed_attempt(uuid) TO service_role;

-- ══════════════════════════════════════════════════════════
-- Atomic challenge consumption
-- Atomically validates: not consumed, not expired, not locked.
-- Returns the consumed row id, or NULL if consumption failed.
-- ══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.otp_consume_challenge(p_challenge_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE public.phone_otp_challenges
  SET consumed_at = now()
  WHERE
    id = p_challenge_id
    AND consumed_at IS NULL
    AND expires_at > now()
    AND failed_attempts < 5
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Restrict execution: service_role only
REVOKE EXECUTE ON FUNCTION public.otp_consume_challenge(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.otp_consume_challenge(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.otp_consume_challenge(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.otp_consume_challenge(uuid) TO service_role;

-- ══════════════════════════════════════════════════════════
-- Cleanup function: remove expired challenges older than 1 hour
-- ══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cleanup_expired_otp_challenges()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.phone_otp_challenges
  WHERE expires_at < now() - interval '1 hour';
END;
$$;

-- Restrict execution: service_role only
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_otp_challenges() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_otp_challenges() FROM anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_otp_challenges() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_otp_challenges() TO service_role;
