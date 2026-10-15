-- 423: Add channel column to phone_otp_challenges for email/recurring OTP reuse
--
-- Extends the existing M246 phone OTP challenge pattern to support email
-- and recurring verification channels without renaming the physical
-- phone_hash column (per CTO direction — cosmetic rename deferred).
--
-- The phone_hash column stores an HMAC of the channel identifier:
-- - channel='phone': HMAC of the phone number
-- - channel='email': HMAC of the email address
-- - channel='recurring': HMAC of the phone number (recurring subscription verify)
--
-- Existing RPCs (otp_consume_challenge, otp_record_failed_attempt,
-- cleanup_expired_otp_challenges) are channel-agnostic and require zero changes.

-- Add channel column with default 'phone' for backward compatibility
ALTER TABLE public.phone_otp_challenges
  ADD COLUMN IF NOT EXISTS channel varchar(16) NOT NULL DEFAULT 'phone';

-- Index for efficient per-channel lookups
CREATE INDEX IF NOT EXISTS idx_phone_otp_challenges_channel_hash
  ON public.phone_otp_challenges (channel, phone_hash);

-- ══════════════════════════════════════════════════════════
-- Verification
-- ══════════════════════════════════════════════════════════
DO $$
BEGIN
  -- 1. channel column exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'phone_otp_challenges'
      AND column_name = 'channel'
  ) THEN
    RAISE EXCEPTION 'M423: phone_otp_challenges must have a channel column';
  END IF;

  -- 2. RLS still enabled
  IF NOT (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'phone_otp_challenges') THEN
    RAISE EXCEPTION 'M423: RLS must remain enabled on phone_otp_challenges';
  END IF;

  -- 3. service_role has SELECT + INSERT (from M246)
  IF NOT has_table_privilege('service_role', 'public.phone_otp_challenges', 'SELECT') THEN
    RAISE EXCEPTION 'M423: service_role must have SELECT on phone_otp_challenges';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.phone_otp_challenges', 'INSERT') THEN
    RAISE EXCEPTION 'M423: service_role must have INSERT on phone_otp_challenges';
  END IF;

  -- 4. anon/authenticated have NO access (from M246)
  IF has_table_privilege('anon', 'public.phone_otp_challenges', 'SELECT') THEN
    RAISE EXCEPTION 'M423: anon must NOT have SELECT on phone_otp_challenges';
  END IF;
  IF has_table_privilege('authenticated', 'public.phone_otp_challenges', 'SELECT') THEN
    RAISE EXCEPTION 'M423: authenticated must NOT have SELECT on phone_otp_challenges';
  END IF;

  RAISE NOTICE 'M423: All checks passed — phone_otp_challenges channel support added';
END $$;
