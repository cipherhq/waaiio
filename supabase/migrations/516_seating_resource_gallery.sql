-- ═══════════════════════════════════════════════════════
-- Migration 516: optional photos for tables and sections (#892)
--
-- Why: merchants want to show customers what a table or section looks like
-- before they book. Owner decisions 2026-11-05 (#892): up to 3 optional
-- photos per seating resource, stored in a dedicated column with the limit
-- enforced by the database (same shape as products.gallery_urls, M462, and
-- services.gallery_urls). The WhatsApp bot shows them after the customer
-- taps the seat; that app change ships separately, after this is applied.
--
-- What it changes:
--   * adds seating_resources.gallery_urls TEXT[] NOT NULL DEFAULT '{}'
--     (existing rows read '{}');
--   * a named CHECK: at most 3 photos;
--   * no grant or policy change. The existing table-level grants
--     (authenticated SELECT/INSERT/UPDATE, service_role) and the owner/admin
--     RLS policies cover the new column, so owners can only set photos on
--     their own business's seats;
--   * a self-check that fails the migration if the column or check drifts.
--
-- Compatible with the live app: no current code selects this column, and the
-- dashboard PATCH route only writes allowlisted columns.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded constraint and COMMENT are
-- repeatable. No BEGIN/COMMIT: applied as one whole-file statement.
-- ═══════════════════════════════════════════════════════

ALTER TABLE public.seating_resources
  ADD COLUMN IF NOT EXISTS gallery_urls TEXT[] NOT NULL DEFAULT '{}';

-- Named check so a re-run (or a column created out of band) converges.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.seating_resources'::regclass
      AND conname = 'seating_resources_gallery_max_3'
      AND contype = 'c'
  ) THEN
    ALTER TABLE public.seating_resources
      ADD CONSTRAINT seating_resources_gallery_max_3
      CHECK (cardinality(gallery_urls) <= 3);
  END IF;
END
$$;

COMMENT ON COLUMN public.seating_resources.gallery_urls IS
  'Optional photos of this table or section, at most 3 (M516, #892). Shown in the WhatsApp table booking.';

-- Fail loudly if schema drift defeats the storage contract.
DO $$
DECLARE
  v_type TEXT;
  v_is_nullable TEXT;
  v_column_default TEXT;
BEGIN
  SELECT udt_name, is_nullable, column_default
    INTO v_type, v_is_nullable, v_column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'seating_resources'
    AND column_name = 'gallery_urls';

  IF v_type IS DISTINCT FROM '_text'
     OR v_is_nullable IS DISTINCT FROM 'NO'
     OR v_column_default IS DISTINCT FROM '''{}''::text[]' THEN
    RAISE EXCEPTION 'M516: gallery_urls must be text[] NOT NULL DEFAULT ''{}''';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.seating_resources'::regclass
      AND conname = 'seating_resources_gallery_max_3'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'M516: gallery_urls max-3 check is missing';
  END IF;

  -- Owners save photos through the dashboard (authenticated + RLS).
  IF NOT has_column_privilege('authenticated', 'public.seating_resources', 'gallery_urls', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.seating_resources', 'gallery_urls', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.seating_resources', 'gallery_urls', 'INSERT') THEN
    RAISE EXCEPTION 'M516: authenticated must be able to read and write seating_resources.gallery_urls (RLS limits rows)';
  END IF;
  -- Deliberately no anon ACL assertion: any excess anon/PUBLIC grant on this
  -- table is #789's (M487) scope, and the owner RLS policies already return
  -- no rows for a caller without auth.uid().
END
$$;
