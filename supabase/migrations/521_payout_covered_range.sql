-- ═══════════════════════════════════════════════════════
-- Migration 521: record the exact time range each payout covered (#796)
--
-- Why: payout generation counts platform_fees rows by created_at inside one
-- week's UTC range. PR #796 works that range out in the merchant's timezone.
-- Nothing links a fee row to the payout that paid it, and payouts are
-- de-duplicated only by their date labels (M468). So if a business's timezone
-- changes between two weekly runs, consecutive ranges can overlap (fees paid
-- twice) or leave a gap (fees never paid). Owner decision 2026-11-05 (#796,
-- Option A): store on each payout the exact UTC range it covered, so the next
-- week starts where the previous one ended.
--
-- What it changes:
--   * adds business_payouts.covered_from and covered_to, TIMESTAMPTZ, nullable,
--     no default. They mean "this payout counted fee rows with
--     covered_from <= created_at < covered_to" (half-open);
--   * a named CHECK: both NULL (rows written before this change, and the 11
--     existing production rows) or both set with covered_from < covered_to;
--   * no new grants. The table ACL already gives anon and authenticated no
--     INSERT or UPDATE (M439) and service_role full access; the new columns
--     inherit that. Read access stays as today (table SELECT + RLS: admins
--     and the owning business only);
--   * a self-check that fails the migration if drift defeats this contract.
--
-- Compatible with the live app: no current code selects or writes these
-- columns. Existing rows stay valid (both NULL). The app change that writes
-- and reads them (#796) ships after this migration is applied.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded constraint, repeatable
-- COMMENT. No BEGIN/COMMIT: applied as one whole-file statement.
-- ═══════════════════════════════════════════════════════

ALTER TABLE public.business_payouts
  ADD COLUMN IF NOT EXISTS covered_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS covered_to TIMESTAMPTZ;

-- Named check so a re-run (or columns created out of band) converges.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.business_payouts'::regclass
      AND conname = 'business_payouts_covered_range_check'
      AND contype = 'c'
  ) THEN
    ALTER TABLE public.business_payouts
      ADD CONSTRAINT business_payouts_covered_range_check
      CHECK (
        (covered_from IS NULL AND covered_to IS NULL)
        OR (covered_from IS NOT NULL AND covered_to IS NOT NULL AND covered_from < covered_to)
      );
  END IF;
END
$$;

COMMENT ON COLUMN public.business_payouts.covered_from IS
  'Start (inclusive) of the platform_fees.created_at range this payout counted (M521, #796). NULL on rows written before M521. Written only by trusted server code.';
COMMENT ON COLUMN public.business_payouts.covered_to IS
  'End (exclusive) of the platform_fees.created_at range this payout counted (M521, #796). The next week starts here. NULL on rows written before M521.';

-- Fail loudly if schema drift defeats the storage or ACL contract.
DO $$
DECLARE
  v_col TEXT;
  v_type TEXT;
  v_is_nullable TEXT;
  v_column_default TEXT;
  v_role TEXT;
  v_priv TEXT;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['covered_from', 'covered_to'] LOOP
    SELECT data_type, is_nullable, column_default
      INTO v_type, v_is_nullable, v_column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'business_payouts'
      AND column_name = v_col;

    IF v_type IS DISTINCT FROM 'timestamp with time zone'
       OR v_is_nullable IS DISTINCT FROM 'YES'
       OR v_column_default IS NOT NULL THEN
      RAISE EXCEPTION 'M521: business_payouts.% must be a nullable timestamptz column with no default', v_col;
    END IF;

    -- has_column_privilege includes table-level and PUBLIC-inherited
    -- privileges, so this also proves no table-wide INSERT/UPDATE reaches it.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE'] LOOP
        IF has_column_privilege(v_role, 'public.business_payouts', v_col, v_priv) THEN
          RAISE EXCEPTION 'M521: % must not have % on business_payouts.%', v_role, v_priv, v_col;
        END IF;
      END LOOP;
    END LOOP;

    IF NOT has_column_privilege('service_role', 'public.business_payouts', v_col, 'INSERT')
       OR NOT has_column_privilege('service_role', 'public.business_payouts', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'M521: service_role must be able to write and read business_payouts.%', v_col;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.business_payouts'::regclass
      AND conname = 'business_payouts_covered_range_check'
      AND contype = 'c'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'M521: business_payouts_covered_range_check is missing or not validated';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.business_payouts'::regclass) THEN
    RAISE EXCEPTION 'M521: RLS must stay enabled on business_payouts';
  END IF;
END
$$;
