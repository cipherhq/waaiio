-- 444_reject_payout_release_adjustments.sql
-- Additive, safe before or after the app deploy, unapplied until Owner authorization.
--
-- Adds reject_payout_and_release_adjustments(): atomically rejects a payout,
-- releases any linked payout_adjustments, and respects the linkage guard
-- rules (R1-R5) from 440_payout_linkage_guard.sql.
--
-- SECURITY INVOKER, service_role-only EXECUTE.

-- ============================================================
-- 1. reject_payout_and_release_adjustments
-- ============================================================
CREATE OR REPLACE FUNCTION public.reject_payout_and_release_adjustments(
  p_payout_id        uuid,
  p_reason           text,
  p_rejected_by      uuid,
  p_rejected_at      timestamptz DEFAULT now()
)
RETURNS TABLE (
  rejected_id             uuid,
  adjustments_released    int
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payout          record;
  v_has_pending     boolean;
  v_has_failed      boolean;
  v_released        int := 0;
BEGIN
  -- Lock the payout row to prevent concurrent modifications
  SELECT id, status, flags
    INTO v_payout
    FROM public.business_payouts
   WHERE id = p_payout_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout_not_found';
  END IF;

  -- Only eligible statuses can be rejected
  IF v_payout.status NOT IN ('pending', 'approved', 'held') THEN
    RAISE EXCEPTION 'ineligible_status: %', v_payout.status;
  END IF;

  -- Check adjustment linkage flags (compliant with R1-R5).
  -- R3 says adjustment_link_failed cannot be cleared. We do not clear flags
  -- on rejection, so R3 is satisfied. However, a payout with a pending or
  -- failed linkage flag represents an unresolved adjustment state: rejecting
  -- it would orphan the deductions. Block rejection until linkage resolves.
  v_has_pending := payout_flag_present(v_payout.flags, 'adjustment_link_pending');
  v_has_failed  := payout_flag_present(v_payout.flags, 'adjustment_link_failed');

  IF v_has_pending OR v_has_failed THEN
    RAISE EXCEPTION 'linkage_flag_blocks_rejection: %',
      CASE WHEN v_has_failed THEN 'adjustment_link_failed'
           ELSE 'adjustment_link_pending'
      END;
  END IF;

  -- Reject the payout. The trigger fn_payout_linkage_guard fires on this
  -- UPDATE. Since we are not changing flags and the target status is
  -- 'rejected' (not in R1's blocked set), the trigger will allow it.
  UPDATE public.business_payouts
     SET status          = 'rejected',
         rejected_reason = p_reason,
         rejected_by     = p_rejected_by,
         rejected_at     = p_rejected_at,
         updated_at      = p_rejected_at
   WHERE id = p_payout_id;

  -- Release linked adjustments so they roll into the next payout
  UPDATE public.payout_adjustments
     SET applied_to_payout_id = NULL
   WHERE applied_to_payout_id = p_payout_id;

  GET DIAGNOSTICS v_released = ROW_COUNT;

  RETURN QUERY SELECT p_payout_id, v_released;
END;
$$;

-- ============================================================
-- 2. Permissions: service_role only
-- ============================================================
REVOKE ALL ON FUNCTION public.reject_payout_and_release_adjustments(uuid, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_payout_and_release_adjustments(uuid, text, uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.reject_payout_and_release_adjustments(uuid, text, uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reject_payout_and_release_adjustments(uuid, text, uuid, timestamptz) TO service_role;

-- ============================================================
-- 3. Self-verification
-- ============================================================
DO $$
DECLARE
  fn_exists boolean;
  fn_invoker boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'reject_payout_and_release_adjustments'
  ) INTO fn_exists;

  SELECT NOT p.prosecdef
    INTO fn_invoker
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'public'
     AND p.proname = 'reject_payout_and_release_adjustments';

  IF fn_exists AND fn_invoker THEN
    RAISE NOTICE '444_reject_payout_release_adjustments: PASS — function present, SECURITY INVOKER';
  ELSE
    RAISE EXCEPTION '444_reject_payout_release_adjustments: FAIL — fn=%, invoker=%',
      fn_exists, COALESCE(fn_invoker, false);
  END IF;
END;
$$;
