-- 445_bot_translation_overrides.sql
-- Platform-level and per-business bot translation overrides.

-- =============================================================================
-- 1. bot_translation_platform_overrides (admin-editable, no deploy needed)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.bot_translation_platform_overrides (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lang       TEXT        NOT NULL
    CHECK (lang IN ('en','pcm','yo','ig','ha','tw','fr','es')),
  key        TEXT        NOT NULL,
  value      TEXT        NOT NULL
    CHECK (char_length(trim(value)) > 0)
    CHECK (char_length(value) <= 4096),
  updated_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lang, key)
);

ALTER TABLE public.bot_translation_platform_overrides ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 2. bot_translation_overrides (per-business)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.bot_translation_overrides (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  lang        TEXT        NOT NULL
    CHECK (lang IN ('en','pcm','yo','ig','ha','tw','fr','es')),
  key         TEXT        NOT NULL,
  value       TEXT        NOT NULL
    CHECK (char_length(trim(value)) > 0)
    CHECK (char_length(value) <= 4096),
  updated_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, lang, key)
);

ALTER TABLE public.bot_translation_overrides ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 3. Indexes
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_bto_business_lang
  ON public.bot_translation_overrides (business_id, lang);

-- =============================================================================
-- 4. GRANTs — explicit, never rely on default privileges (#622)
-- =============================================================================

-- Revoke everything first
REVOKE ALL ON public.bot_translation_platform_overrides FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.bot_translation_overrides           FROM PUBLIC, anon, authenticated;

-- service_role: full DML on both tables
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_translation_platform_overrides TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_translation_overrides           TO service_role;

-- authenticated: SELECT only on business overrides (RLS enforces owner check)
GRANT SELECT ON public.bot_translation_overrides TO authenticated;

-- anon: nothing (already revoked above, explicit for clarity)
-- No GRANT to anon on either table.

-- =============================================================================
-- 5. RLS Policies
-- =============================================================================

-- service_role bypasses RLS; explicit policies for it are unnecessary.
-- GRANTs above provide the required DML permissions.

CREATE POLICY owners_read
  ON public.bot_translation_overrides
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.businesses b
       WHERE b.id = bot_translation_overrides.business_id
         AND b.owner_id = auth.uid()
    )
  );

-- =============================================================================
-- 6. preferred_language on customer_profiles (picker choice persistence)
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customer_profiles') THEN
    ALTER TABLE public.customer_profiles
      ADD COLUMN IF NOT EXISTS preferred_language TEXT
        CHECK (preferred_language IN ('en','pcm','yo','ig','ha','tw','fr','es'));
    COMMENT ON COLUMN public.customer_profiles.preferred_language
      IS 'Language chosen via the first-contact picker. Persists across sessions for non-auth customers.';
  END IF;
END $$;
