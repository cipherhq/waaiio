-- ══════════════════════════════════════════════════════════
-- 550: Waaiio fee rounds to the cent/kobo in the database too
--
-- Owner decision (2026-11-18): round Waaiio's platform fee to the
-- cent/kobo (two decimals), never to whole units, for new payments. Rates
-- are unchanged and historical platform_fees rows are not rewritten.
-- PR #1122 did this in TypeScript (getPlatformFees). Three database sites
-- still rounded to whole units:
--
-- 1. public.bind_merchant_tax_fee_980 — legacy (fee_policy_version 0)
--    branch: round(net*pct/100)+flat. Now the same expression as its own
--    v1 branch and calculateFee: round(round(net*pct*100)/10000+flat, 2).
-- 2. public.finalize_stripe_recurring_charge — recorded fee:
--    ROUND(amount*pct/100)+flat. Now ROUND(ROUND(amount*pct*100)/10000
--    + flat, 2), as getPlatformFees. The token and Paystack recurring
--    finalizers already round to 2 decimals and are not touched.
-- 3. accounting_private.finalize_refund_accounting_modern — partial-refund
--    fee reduction for a payment without merchant tax: ROUND(x). Now
--    ROUND(x, 2). The merchant-tax branch already works in minor units and
--    is not touched. Full refunds still set the fee to 0.
--
-- Only that one statement changes in each function. Each is re-created from
-- its live pg_get_functiondef, so its schema, SECURITY DEFINER flag,
-- search_path, owner and ACL are kept (DB-002; same method as M525). The
-- migration fails if a function is missing, if the statement is not found
-- exactly once, or if any of those attributes differ afterwards. A function
-- that already carries the M550 marker is left alone, so a re-run is a no-op.
--
-- Not changed: fee rates, routing/custody (is_direct_transfer), payout
-- adjustments (they follow the refund amount, not the fee), the merchant-tax
-- refund branch, the other recurring finalizers, existing rows (no backfill).
--
-- Note for the accounting activation procedure (M501,
-- accounting_private.activate_merchant_accounting): it recognises recurring
-- finalizers by body hash. Since M525 it already reports an unknown Stripe
-- precursor and fails closed; this keeps it that way.
--
-- ROLLBACK: forward-only. A new migration would have to restore the
-- previous statements.
-- ══════════════════════════════════════════════════════════

DO $m550$
DECLARE
  v_fn RECORD;
  v_oid OID;
  v_count INTEGER;
  v_def TEXT;
  v_new_def TEXT;
  v_before RECORD;
  v_after RECORD;
  v_rewritten INTEGER := 0;
  c_marker CONSTANT TEXT := 'M550: cent rounding';
BEGIN
  FOR v_fn IN
    SELECT * FROM (VALUES
      ('public.bind_merchant_tax_fee_980(uuid)',
       'ELSE\s+fee\s*:=\s*round\(net\s*\*\s*pct\s*/\s*100\)\s*\+\s*effective_flat\s*;',
       'ELSE fee:=round(round(net*pct*100)/10000+effective_flat,2); /* M550: cent rounding, as v1 (Owner 2026-11-18) */'),
      ('public.finalize_stripe_recurring_charge(uuid,text,text,integer,text,text)',
       'v_fee_total\s*:=\s*ROUND\(v_amount\s*\*\s*v_fee_pct\s*/\s*100\)\s*\+\s*v_fee_flat\s*;',
       'v_fee_total := ROUND(ROUND(v_amount * v_fee_pct * 100) / 10000 + v_fee_flat, 2); /* M550: cent rounding, as getPlatformFees (Owner 2026-11-18) */'),
      ('accounting_private.finalize_refund_accounting_modern(uuid)',
       'v_fee_reduction\s*:=\s*ROUND\(\s*\(v_fee\.fee_percentage\s*/\s*100\.0\s*\*\s*v_refund\.amount\)\s*\+\s*\(v_fee\.fee_flat::NUMERIC\s*\*\s*v_refund\.amount\s*/\s*v_fee\.transaction_amount\)\s*\)\s*;',
       'v_fee_reduction := ROUND(
          (v_fee.fee_percentage / 100.0 * v_refund.amount)
          + (v_fee.fee_flat::NUMERIC * v_refund.amount / v_fee.transaction_amount), 2
        ); /* M550: cent rounding (Owner 2026-11-18) */')
    ) AS t(sig, pattern, replacement)
  LOOP
    v_oid := to_regprocedure(v_fn.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'M550: % is missing', v_fn.sig;
    END IF;

    -- Already rewritten by an earlier run: leave it.
    IF (SELECT prosrc FROM pg_proc WHERE oid = v_oid) LIKE '%' || c_marker || '%' THEN
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_count
      FROM regexp_matches((SELECT prosrc FROM pg_proc WHERE oid = v_oid), v_fn.pattern, 'g');
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'M550: % has % whole-unit fee statements, expected exactly 1', v_fn.sig, v_count;
    END IF;

    SELECT pronamespace, prosecdef, proconfig, proowner, proacl::text AS acl
      INTO v_before FROM pg_proc WHERE oid = v_oid;

    v_def := pg_get_functiondef(v_oid);
    v_new_def := regexp_replace(v_def, v_fn.pattern, v_fn.replacement);
    -- The Stripe finalizer's comments described the old whole-unit rounding.
    v_new_def := replace(v_new_def,
      '-- Uses ROUND(x) = integer rounding to match Math.round in getPlatformFees',
      '-- M550: rounds to the cent, as getPlatformFees (was whole units)');
    v_new_def := replace(v_new_def,
      '-- Integer rounding to match Math.round behavior',
      '-- M550: cent rounding (was whole units)');
    IF v_new_def = v_def THEN
      RAISE EXCEPTION 'M550: % definition did not change', v_fn.sig;
    END IF;
    EXECUTE v_new_def;

    SELECT pronamespace, prosecdef, proconfig, proowner, proacl::text AS acl
      INTO v_after FROM pg_proc WHERE oid = v_oid;
    IF v_after.pronamespace IS DISTINCT FROM v_before.pronamespace
       OR v_after.prosecdef IS DISTINCT FROM v_before.prosecdef
       OR v_after.proconfig IS DISTINCT FROM v_before.proconfig
       OR v_after.proowner IS DISTINCT FROM v_before.proowner
       OR v_after.acl IS DISTINCT FROM v_before.acl THEN
      RAISE EXCEPTION 'M550: % lost an attribute on rewrite', v_fn.sig;
    END IF;

    v_rewritten := v_rewritten + 1;
    RAISE NOTICE 'M550: % now rounds the fee to the cent', v_fn.sig;
  END LOOP;

  RAISE NOTICE 'M550: % function(s) rewritten', v_rewritten;
END $m550$;

-- ── Verification ──
DO $$
DECLARE
  v_sig TEXT;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.bind_merchant_tax_fee_980(uuid)',
    'public.finalize_stripe_recurring_charge(uuid,text,text,integer,text,text)',
    'accounting_private.finalize_refund_accounting_modern(uuid)'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure(v_sig)
                    AND prosrc LIKE '%M550: cent rounding%' AND prosecdef) THEN
      RAISE EXCEPTION 'M550: % does not carry the cent-rounding statement', v_sig;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
       OR has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'M550: % must not be executable by anon/authenticated', v_sig;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.bind_merchant_tax_fee_980(uuid)')
              AND prosrc ~ 'round\(net\s*\*\s*pct\s*/\s*100\)') THEN
    RAISE EXCEPTION 'M550: bind_merchant_tax_fee_980 still rounds the fee to whole units';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.finalize_stripe_recurring_charge(uuid,text,text,integer,text,text)')
              AND prosrc ~ 'ROUND\(v_amount\s*\*\s*v_fee_pct\s*/\s*100\)') THEN
    RAISE EXCEPTION 'M550: finalize_stripe_recurring_charge still rounds the fee to whole units';
  END IF;

  RAISE NOTICE 'M550: cent rounding verified';
END $$;
