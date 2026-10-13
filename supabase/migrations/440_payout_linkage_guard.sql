-- 440_payout_linkage_guard.sql
-- Additive, safe before or after the app deploy, unapplied until Owner authorization.
--
-- Adds two helper functions and a BEFORE INSERT OR UPDATE trigger on
-- business_payouts that enforces adjustment-linkage invariants at the
-- database level (R1-R5).  All functions are SECURITY INVOKER with
-- SET search_path = public, pg_temp.

-- ============================================================
-- 1. payout_flag_present(flags jsonb, flag_type text) -> boolean
-- ============================================================
CREATE OR REPLACE FUNCTION public.payout_flag_present(
  flags jsonb,
  flag_type text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  elem jsonb;
BEGIN
  -- NULL or non-array input -> false
  IF flags IS NULL OR jsonb_typeof(flags) <> 'array' THEN
    RETURN false;
  END IF;

  FOR elem IN SELECT jsonb_array_elements(flags)
  LOOP
    -- Only inspect JSON objects; skip strings and malformed elements
    IF jsonb_typeof(elem) = 'object'
       AND elem ? 'type'
       AND jsonb_typeof(elem -> 'type') = 'string'
       AND (elem ->> 'type') = flag_type
    THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$$;

-- ============================================================
-- 2. payout_flag_adjustment_ids(flags jsonb, flag_type text) -> uuid[]
-- ============================================================
CREATE OR REPLACE FUNCTION public.payout_flag_adjustment_ids(
  flags jsonb,
  flag_type text
)
RETURNS uuid[]
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  elem       jsonb;
  ids_jsonb  jsonb;
  result     uuid[];
  id_text    text;
BEGIN
  -- NULL or non-array input -> NULL
  IF flags IS NULL OR jsonb_typeof(flags) <> 'array' THEN
    RETURN NULL;
  END IF;

  FOR elem IN SELECT jsonb_array_elements(flags)
  LOOP
    IF jsonb_typeof(elem) = 'object'
       AND elem ? 'type'
       AND jsonb_typeof(elem -> 'type') = 'string'
       AND (elem ->> 'type') = flag_type
    THEN
      -- Found the matching flag; extract adjustment_ids
      IF NOT (elem ? 'adjustment_ids')
         OR jsonb_typeof(elem -> 'adjustment_ids') <> 'array'
      THEN
        RETURN NULL;
      END IF;

      ids_jsonb := elem -> 'adjustment_ids';
      result := ARRAY[]::uuid[];

      FOR id_text IN SELECT jsonb_array_elements_text(ids_jsonb)
      LOOP
        BEGIN
          result := result || id_text::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          -- Skip malformed UUID strings
          NULL;
        END;
      END LOOP;

      IF array_length(result, 1) IS NULL THEN
        RETURN NULL;
      END IF;

      RETURN result;
    END IF;
  END LOOP;

  -- Flag not found
  RETURN NULL;
END;
$$;

-- ============================================================
-- 3. Trigger function: fn_payout_linkage_guard()
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_payout_linkage_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  has_pending_new   boolean;
  has_failed_new    boolean;
  has_pending_old   boolean;
  has_failed_old    boolean;
  ids_pending_new   uuid[];
  ids_pending_old   uuid[];
  linked_count      int;
BEGIN
  -- Pre-compute flag presence for NEW
  has_pending_new := payout_flag_present(NEW.flags, 'adjustment_link_pending');
  has_failed_new  := payout_flag_present(NEW.flags, 'adjustment_link_failed');

  -- ----------------------------------------------------------------
  -- R1: No advancing to approved/processing/paid while carrying
  --     a pending or failed adjustment-link flag.
  -- ----------------------------------------------------------------
  IF NEW.status IN ('approved', 'processing', 'paid')
     AND (has_pending_new OR has_failed_new)
  THEN
    RAISE EXCEPTION 'linkage_guard_r1: cannot set status to % while adjustment_link_pending or adjustment_link_failed flag is present',
      NEW.status;
  END IF;

  -- ----------------------------------------------------------------
  -- R2: A pending flag must always carry a non-empty adjustment_ids.
  --     Applies to both INSERT and UPDATE.
  -- ----------------------------------------------------------------
  IF has_pending_new THEN
    ids_pending_new := payout_flag_adjustment_ids(NEW.flags, 'adjustment_link_pending');
    IF ids_pending_new IS NULL OR array_length(ids_pending_new, 1) IS NULL OR array_length(ids_pending_new, 1) = 0 THEN
      RAISE EXCEPTION 'linkage_guard_r2: adjustment_link_pending flag must carry a non-empty adjustment_ids array';
    END IF;
  END IF;

  -- Remaining rules apply to UPDATE only
  IF TG_OP = 'UPDATE' THEN
    has_pending_old := payout_flag_present(OLD.flags, 'adjustment_link_pending');
    has_failed_old  := payout_flag_present(OLD.flags, 'adjustment_link_failed');

    -- ----------------------------------------------------------------
    -- R3: Once adjustment_link_failed is set, it cannot be removed.
    --     Recovery is a future audited operation (#620).
    -- ----------------------------------------------------------------
    IF has_failed_old AND NOT has_failed_new THEN
      RAISE EXCEPTION 'linkage_guard_r3: adjustment_link_failed flag cannot be cleared; recovery requires audited operation (#620)';
    END IF;

    -- ----------------------------------------------------------------
    -- R4: Clearing adjustment_link_pending requires either:
    --     (a) NEW has adjustment_link_failed (the blocked swap), OR
    --     (b) Every id in OLD's pending adjustment_ids exists in
    --         payout_adjustments with applied_to_payout_id = NEW.id.
    -- ----------------------------------------------------------------
    IF has_pending_old AND NOT has_pending_new THEN
      -- Path (a): swap to failed is allowed
      IF NOT has_failed_new THEN
        -- Path (b): verify all adjustments are linked
        ids_pending_old := payout_flag_adjustment_ids(OLD.flags, 'adjustment_link_pending');
        IF ids_pending_old IS NULL OR array_length(ids_pending_old, 1) IS NULL THEN
          RAISE EXCEPTION 'linkage_guard_r4: cannot clear adjustment_link_pending — OLD flag has no adjustment_ids to verify';
        END IF;

        SELECT count(DISTINCT id)
          INTO linked_count
          FROM public.payout_adjustments
         WHERE id = ANY(ids_pending_old)
           AND applied_to_payout_id = NEW.id;

        IF linked_count <> array_length(ids_pending_old, 1) THEN
          RAISE EXCEPTION 'linkage_guard_r4: cannot clear adjustment_link_pending — only %/% adjustment(s) are linked to this payout',
            linked_count, array_length(ids_pending_old, 1);
        END IF;
      END IF;
      -- If has_failed_new is true, path (a) allows the clear — fall through
    END IF;

    -- ----------------------------------------------------------------
    -- R5: If both OLD and NEW carry adjustment_link_pending, the
    --     adjustment_ids must be identical (no silent mutation).
    -- ----------------------------------------------------------------
    IF has_pending_old AND has_pending_new THEN
      ids_pending_old := payout_flag_adjustment_ids(OLD.flags, 'adjustment_link_pending');
      -- ids_pending_new was already computed in R2 if has_pending_new
      IF ids_pending_new IS NULL THEN
        ids_pending_new := payout_flag_adjustment_ids(NEW.flags, 'adjustment_link_pending');
      END IF;

      IF ids_pending_old IS DISTINCT FROM ids_pending_new THEN
        RAISE EXCEPTION 'linkage_guard_r5: adjustment_ids in adjustment_link_pending flag cannot be changed once set';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================
-- 4. Trigger on business_payouts (idempotent)
-- ============================================================
DROP TRIGGER IF EXISTS trg_payout_linkage_guard ON public.business_payouts;

CREATE TRIGGER trg_payout_linkage_guard
  BEFORE INSERT OR UPDATE
  ON public.business_payouts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_payout_linkage_guard();

-- No GRANT/REVOKE changes — trigger fires for all roles including
-- service_role (this is a data integrity constraint, not access control).

-- ============================================================
-- 5. Self-verification
-- ============================================================
DO $$
DECLARE
  fn1_exists boolean;
  fn2_exists boolean;
  trg_exists boolean;
BEGIN
  -- Check payout_flag_present function
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'payout_flag_present'
  ) INTO fn1_exists;

  -- Check payout_flag_adjustment_ids function
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'payout_flag_adjustment_ids'
  ) INTO fn2_exists;

  -- Check trigger on business_payouts
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'business_payouts'
      AND t.tgname = 'trg_payout_linkage_guard'
  ) INTO trg_exists;

  IF fn1_exists AND fn2_exists AND trg_exists THEN
    RAISE NOTICE '440_payout_linkage_guard: PASS — payout_flag_present, payout_flag_adjustment_ids, trg_payout_linkage_guard all present';
  ELSE
    RAISE EXCEPTION '440_payout_linkage_guard: FAIL — fn1=%, fn2=%, trg=%',
      fn1_exists, fn2_exists, trg_exists;
  END IF;
END;
$$;
