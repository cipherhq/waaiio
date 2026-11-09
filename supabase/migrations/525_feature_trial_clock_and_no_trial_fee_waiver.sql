-- ══════════════════════════════════════════════════════════
-- 525: Feature-trial clock from sign-up; the trial never waives the fee
--
-- Owner pricing decisions (2026-11-08):
--   * The Waaiio fee (Starter 3% / Pro 1.5% / Premium 1%) applies from
--     sign-up. The free trial never waives it.
--   * The 14-day free trial is for Pro and Premium features. It starts at
--     sign-up for every new business, independent of the free messaging
--     credit and of messaging_financial_gate.
--
-- 1. businesses.feature_trial_ends_at — the feature-trial clock.
--    It is separate from businesses.trial_ends_at, which stays the clock of
--    the free messaging credit (set only by activate_trial_if_eligible,
--    M465). Keeping the two apart means the credit claim (#955) is
--    unchanged: no split state, no double grant.
-- 2. A BEFORE INSERT trigger sets the clock for every new business to
--    now() + platform_settings.trial_days. A caller-supplied value is
--    ignored. A missing or invalid trial_days leaves it NULL (no trial)
--    instead of blocking sign-up.
-- 3. A BEFORE UPDATE trigger keeps the clock server-managed: only
--    service_role and the function owner may change it (same allow rule
--    as guard_server_managed_columns, M508).
-- 4. The recurring-charge SQL fee path waived the fee while
--    trial_ends_at > now(). Every live public function that assigns
--    v_is_in_trial is rewritten in place so the assignment is `false`.
--    Only that one statement changes; the rest of each live body, its
--    SECURITY DEFINER flag, search_path, owner and ACL are kept (the
--    function is re-created from pg_get_functiondef). Each function must
--    contain exactly one assignment or the migration fails.
--    This is version-agnostic on purpose: the live bodies differ between
--    environments (M335/M339/M452/M503 lineages).
--
-- Not changed: fee rates, payment routing/custody, BYO routing, gateway
-- fees, activate_trial_if_eligible, the messaging credit, existing rows
-- (no backfill: existing businesses do not get a trial).
--
-- Note for the accounting activation procedure (M501,
-- accounting_private.activate_merchant_accounting): it recognises recurring
-- finalizers by body hash. After this migration it reports an unknown
-- recurring precursor and fails closed, so it cannot re-install the older
-- bodies that still waive the fee. Its precursor table must be updated in
-- that lane before any activation.
--
-- ROLLBACK: forward-only. To restore the waiver a new migration would have
-- to re-create the previous bodies; dropping the column/triggers is safe.
-- ══════════════════════════════════════════════════════════

-- ── 1. Column ──
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS feature_trial_ends_at TIMESTAMPTZ;

COMMENT ON COLUMN public.businesses.feature_trial_ends_at IS
  'End of the Pro/Premium feature trial. Set at sign-up (M525 trigger) to now() + platform_settings.trial_days. Never waives the Waaiio fee. Separate from trial_ends_at (free messaging credit clock).';

-- ── 2. Sign-up clock ──
CREATE OR REPLACE FUNCTION public.set_feature_trial_clock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_raw JSONB;
  v_days NUMERIC;
BEGIN
  -- The clock is never client-supplied.
  NEW.feature_trial_ends_at := NULL;

  SELECT value INTO v_raw
    FROM public.platform_settings
   WHERE key = 'trial_days';

  IF v_raw IS NOT NULL AND jsonb_typeof(v_raw) = 'number' THEN
    v_days := (v_raw #>> '{}')::NUMERIC;
    IF v_days > 0 AND v_days = FLOOR(v_days) THEN
      NEW.feature_trial_ends_at := now() + (v_days::INTEGER * INTERVAL '1 day');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_feature_trial_clock() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_feature_trial_clock() FROM anon;
REVOKE ALL ON FUNCTION public.set_feature_trial_clock() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_feature_trial_clock() TO service_role;

DROP TRIGGER IF EXISTS trg_set_feature_trial_clock ON public.businesses;
CREATE TRIGGER trg_set_feature_trial_clock
  BEFORE INSERT ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.set_feature_trial_clock();

-- ── 3. Server-managed on update ──
CREATE OR REPLACE FUNCTION public.guard_feature_trial_clock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_db_owner TEXT;
BEGIN
  IF NEW.feature_trial_ends_at IS NOT DISTINCT FROM OLD.feature_trial_ends_at THEN
    RETURN NEW;
  END IF;

  -- Allow service_role (API routes and cron via PostgREST)
  IF current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Allow the function owner (SECURITY DEFINER functions run as the owner)
  SELECT r.rolname INTO v_db_owner
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_roles r ON p.proowner = r.oid
   WHERE n.nspname = 'public'
     AND p.proname = 'guard_feature_trial_clock'
   LIMIT 1;

  IF v_db_owner IS NOT NULL AND current_user = v_db_owner THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'feature_trial_ends_at can only be modified by the server';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_feature_trial_clock() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_feature_trial_clock() FROM anon;
REVOKE ALL ON FUNCTION public.guard_feature_trial_clock() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.guard_feature_trial_clock() TO service_role;

DROP TRIGGER IF EXISTS trg_guard_feature_trial_clock ON public.businesses;
CREATE TRIGGER trg_guard_feature_trial_clock
  BEFORE UPDATE OF feature_trial_ends_at ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.guard_feature_trial_clock();

-- ── 4. Remove the trial fee waiver from the recurring SQL fee path ──
DO $waiver$
DECLARE
  v_fn RECORD;
  v_count INTEGER;
  v_def TEXT;
  v_new_def TEXT;
  v_before RECORD;
  v_after RECORD;
  v_rewritten INTEGER := 0;
  c_assign CONSTANT TEXT := 'v_is_in_trial\s*:=\s*[^;]*;';
  c_neutral CONSTANT TEXT := 'v_is_in_trial := false; /* M525: the trial never waives the Waaiio fee (Owner 2026-11-08) */';
BEGIN
  FOR v_fn IN
    SELECT p.oid, p.oid::regprocedure::text AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prosrc ~ 'v_is_in_trial\s*:='
       -- Already neutralised by an earlier run: leave it (idempotent re-run).
       AND NOT p.prosrc ~ 'v_is_in_trial := false; /\* M525:'
     ORDER BY 2
  LOOP
    SELECT count(*) INTO v_count
      FROM regexp_matches((SELECT prosrc FROM pg_proc WHERE oid = v_fn.oid), c_assign, 'g');
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'M525: % has % v_is_in_trial assignments, expected exactly 1', v_fn.sig, v_count;
    END IF;

    SELECT prosecdef, proconfig, proowner, proacl::text AS acl
      INTO v_before FROM pg_proc WHERE oid = v_fn.oid;

    v_def := pg_get_functiondef(v_fn.oid);
    v_new_def := regexp_replace(v_def, c_assign, c_neutral);
    IF v_new_def = v_def THEN
      RAISE EXCEPTION 'M525: % definition did not change', v_fn.sig;
    END IF;
    EXECUTE v_new_def;

    SELECT prosecdef, proconfig, proowner, proacl::text AS acl, prosrc
      INTO v_after FROM pg_proc WHERE oid = v_fn.oid;
    IF v_after.prosecdef IS DISTINCT FROM v_before.prosecdef
       OR v_after.proconfig IS DISTINCT FROM v_before.proconfig
       OR v_after.proowner IS DISTINCT FROM v_before.proowner
       OR v_after.acl IS DISTINCT FROM v_before.acl THEN
      RAISE EXCEPTION 'M525: % lost an attribute on rewrite', v_fn.sig;
    END IF;

    v_rewritten := v_rewritten + 1;
    RAISE NOTICE 'M525: trial fee waiver removed from %', v_fn.sig;
  END LOOP;

  RAISE NOTICE 'M525: % recurring fee function(s) rewritten', v_rewritten;
END $waiver$;

-- ── Verification ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'businesses'
       AND column_name = 'feature_trial_ends_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'M525: businesses.feature_trial_ends_at missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_feature_trial_clock'
                  AND tgrelid = 'public.businesses'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M525: sign-up clock trigger missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_feature_trial_clock'
                  AND tgrelid = 'public.businesses'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M525: feature trial guard trigger missing';
  END IF;

  -- No public function may still compute a live trial waiver: every
  -- v_is_in_trial assignment must be the neutral M525 one.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.prosrc ~ 'v_is_in_trial\s*:='
       AND (SELECT count(*) FROM regexp_matches(p.prosrc, 'v_is_in_trial\s*:=', 'g'))
           <> (SELECT count(*) FROM regexp_matches(p.prosrc, 'v_is_in_trial := false; /\* M525:', 'g'))
  ) THEN
    RAISE EXCEPTION 'M525: a public function still assigns a live trial waiver';
  END IF;

  -- The recurring fee finalizers must not keep a trial waiver of any other
  -- shape: where present and reading trial_ends_at, each must carry the M525
  -- neutral assignment. A production-only body that waives differently makes
  -- this migration fail instead of passing silently.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.proname IN ('finalize_token_recurring_charge', 'finalize_stripe_recurring_charge',
                         'finalize_paystack_recurring_charge', 'process_recurring_charge')
       AND p.prosrc ~ 'trial_ends_at'
       AND NOT p.prosrc ~ 'v_is_in_trial := false; /\* M525:'
  ) THEN
    RAISE EXCEPTION 'M525: a recurring fee finalizer reads trial_ends_at without the M525 neutral assignment';
  END IF;

  IF has_function_privilege('anon', 'public.set_feature_trial_clock()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.set_feature_trial_clock()', 'EXECUTE') THEN
    RAISE EXCEPTION 'M525: set_feature_trial_clock must not be executable by anon/authenticated';
  END IF;

  RAISE NOTICE 'M525: feature trial clock and fee waiver removal verified';
END $$;
