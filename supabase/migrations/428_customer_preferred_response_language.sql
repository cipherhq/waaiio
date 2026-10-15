-- 428: Durable customer response-language preference (#524)
--
-- The preference is optional and is written only by trusted server-side flows.
-- Existing profile RLS policies and the M353 authenticated named-column grants
-- remain unchanged.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS preferred_response_language TEXT
  CONSTRAINT profiles_preferred_response_language_check
  CHECK (preferred_response_language IN ('en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es'));

-- Converge an environment where the column was created out of band without the
-- repository constraint. The named check makes repeated application a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_preferred_response_language_check'
      AND contype = 'c'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_preferred_response_language_check
      CHECK (preferred_response_language IN ('en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es'));
  END IF;
END
$$;

-- M353 deliberately grants authenticated UPDATE on an explicit set of profile
-- columns. Keep this new server-owned column outside that set, including any
-- inherited PUBLIC privilege.
REVOKE UPDATE (preferred_response_language) ON TABLE public.profiles FROM PUBLIC;
REVOKE UPDATE (preferred_response_language) ON TABLE public.profiles FROM anon;
REVOKE UPDATE (preferred_response_language) ON TABLE public.profiles FROM authenticated;

-- Trusted server operations retain full profile authority.
GRANT ALL ON TABLE public.profiles TO service_role;

-- Fail loudly if schema drift defeats the intended storage or ACL contract.
DO $$
DECLARE
  v_is_nullable TEXT;
  v_column_default TEXT;
BEGIN
  SELECT is_nullable, column_default
    INTO v_is_nullable, v_column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'profiles'
    AND column_name = 'preferred_response_language';

  IF v_is_nullable IS DISTINCT FROM 'YES' OR v_column_default IS NOT NULL THEN
    RAISE EXCEPTION 'M428: response-language preference must be optional and have no automatic value';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_preferred_response_language_check'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'M428: response-language allowlist check is missing';
  END IF;

  -- Both login roles inherit PUBLIC, so these effective-privilege checks also
  -- prove that PUBLIC cannot supply UPDATE indirectly.
  IF has_column_privilege('anon', 'public.profiles', 'preferred_response_language', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'preferred_response_language', 'UPDATE') THEN
    RAISE EXCEPTION 'M428: untrusted roles must not update the response-language preference';
  END IF;

  IF NOT has_column_privilege('service_role', 'public.profiles', 'preferred_response_language', 'UPDATE') THEN
    RAISE EXCEPTION 'M428: service_role must be able to update the response-language preference';
  END IF;
END
$$;
