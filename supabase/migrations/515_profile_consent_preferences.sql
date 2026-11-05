-- ═══════════════════════════════════════════════════════
-- Migration 515: server-only owner consent answers on profiles (#878 Bug 2)
--
-- Why: /api/account/consent and /api/onboarding/activate-admin-invite read and
-- write profiles.metadata.consent_preferences, but profiles.metadata has never
-- existed on staging or production. Settings -> Account privacy preferences,
-- the cookie banner's account sync and admin-assisted activation (#551) have
-- therefore always failed (PostgREST 42703 -> HTTP 500 / 409).
--
-- Owner decision 2026-11-04 (#878, Option A): store each owner's latest consent
-- answers (terms accepted, marketing, analytics, AI processing) in a new
-- server-only column, profiles.consent_preferences. Owners may read their own
-- row (existing SELECT grant + RLS) but cannot write the column. No history.
--
-- What it changes:
--   * adds profiles.consent_preferences JSONB, nullable, no default;
--   * a named CHECK: NULL or a JSON object;
--   * no INSERT/UPDATE on the column for PUBLIC, anon or authenticated, the
--     same pattern as M428 preferred_response_language. M353's authenticated
--     named-column UPDATE grants and every RLS policy stay unchanged;
--   * service_role keeps ALL on profiles (trusted server code writes it);
--   * a self-check that fails the migration if drift defeats this contract.
--
-- Compatible with the live app: no current code selects or writes this
-- column, and no code selects profiles '*' and writes the row back. The app
-- change that uses it ships separately, after this migration is applied.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded constraint, REVOKE/GRANT and
-- COMMENT are repeatable. No BEGIN/COMMIT: applied as one whole-file statement.
-- ═══════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS consent_preferences JSONB;

-- Named check so a re-run (or a column created out of band) converges.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_consent_preferences_object_check'
      AND contype = 'c'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_consent_preferences_object_check
      CHECK (consent_preferences IS NULL OR jsonb_typeof(consent_preferences) = 'object');
  END IF;
END
$$;

COMMENT ON COLUMN public.profiles.consent_preferences IS
  'Owner''s latest account consent answers (M515, #878). Written only by trusted server code.';

-- Keep the column outside M353's authenticated named-column UPDATE set,
-- including anything inherited from PUBLIC.
REVOKE INSERT (consent_preferences), UPDATE (consent_preferences) ON TABLE public.profiles FROM PUBLIC;
REVOKE INSERT (consent_preferences), UPDATE (consent_preferences) ON TABLE public.profiles FROM anon;
REVOKE INSERT (consent_preferences), UPDATE (consent_preferences) ON TABLE public.profiles FROM authenticated;

-- Trusted server operations retain full profile authority.
GRANT ALL ON TABLE public.profiles TO service_role;

-- Fail loudly if schema drift defeats the storage or ACL contract.
DO $$
DECLARE
  v_type TEXT;
  v_is_nullable TEXT;
  v_column_default TEXT;
  v_role TEXT;
  v_priv TEXT;
BEGIN
  SELECT data_type, is_nullable, column_default
    INTO v_type, v_is_nullable, v_column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'profiles'
    AND column_name = 'consent_preferences';

  IF v_type IS DISTINCT FROM 'jsonb' OR v_is_nullable IS DISTINCT FROM 'YES' OR v_column_default IS NOT NULL THEN
    RAISE EXCEPTION 'M515: consent_preferences must be a nullable jsonb column with no default';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_consent_preferences_object_check'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'M515: consent_preferences object check is missing';
  END IF;

  -- has_column_privilege includes table-level and PUBLIC-inherited privileges,
  -- so this also proves no table-wide INSERT/UPDATE reaches the column.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE'] LOOP
      IF has_column_privilege(v_role, 'public.profiles', 'consent_preferences', v_priv) THEN
        RAISE EXCEPTION 'M515: % must not have % on profiles.consent_preferences', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT has_column_privilege('service_role', 'public.profiles', 'consent_preferences', 'UPDATE')
     OR NOT has_column_privilege('service_role', 'public.profiles', 'consent_preferences', 'SELECT') THEN
    RAISE EXCEPTION 'M515: service_role must be able to read and write profiles.consent_preferences';
  END IF;
END
$$;
