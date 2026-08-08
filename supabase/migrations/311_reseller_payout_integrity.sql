-- ═══════════════════════════════════════════════════════
-- 311: Reseller Payout Financial Integrity
--
-- A. Fix RLS: Finance = SELECT only; Admin = full CRUD.
-- B. mark_reseller_payout_paid RPC: serialized overspend prevention.
-- C. Overlapping period prevention: exclusion constraint.
--
-- Convention: period_end is EXCLUSIVE — [period_start, period_end).
-- If existing non-rejected overlapping data exists, migration FAILS
-- and rolls back ALL changes (entire file is one transaction).
-- ═══════════════════════════════════════════════════════

-- btree_gist must be created OUTSIDE the transaction (extension creation
-- is non-transactional in some PostgreSQL configurations)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Entire migration is atomic: if the overlap check fails, ALL DDL
-- (policies, function, grants, constraint) rolls back cleanly.
BEGIN;

-- ══════════════════════════════════════════════════════════
-- A0. Create is_admin_or_finance() helper
--     Exact Admin+Finance boundary — does NOT include Support/Operations.
--     Uses raw_app_meta_data (same trusted authority as is_admin).
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.is_admin_or_finance()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT raw_app_meta_data ->> 'role'
  INTO v_role
  FROM auth.users
  WHERE id = auth.uid();

  RETURN COALESCE(v_role IN ('admin', 'finance'), false);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.is_admin_or_finance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_or_finance() TO authenticated, service_role;

-- ══════════════════════════════════════════════════════════
-- A. Fix reseller_payouts RLS policies + table grants
-- ══════════════════════════════════════════════════════════

-- Grant table-level access to authenticated role (required for RLS to work)
-- Without this GRANT, SET ROLE authenticated gets "permission denied" before
-- RLS policies are even evaluated.
GRANT SELECT, INSERT, UPDATE, DELETE ON reseller_payouts TO authenticated;

-- Drop the old broad policy that gave Finance full CRUD
DROP POLICY IF EXISTS "Admin manages reseller payouts" ON reseller_payouts;

-- Admin: full CRUD (uses is_admin() which reads raw_app_meta_data)
CREATE POLICY "admin_manages_reseller_payouts"
  ON reseller_payouts FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Finance: SELECT only (exact Admin+Finance boundary, excludes Support/Operations)
CREATE POLICY "finance_reads_reseller_payouts"
  ON reseller_payouts FOR SELECT
  USING (public.is_admin_or_finance());

-- ══════════════════════════════════════════════════════════
-- B. mark_reseller_payout_paid RPC
--    Serializes concurrent mark_paid requests on the same reseller
--    to prevent cross-payout overspend.
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION mark_reseller_payout_paid(
  p_payout_id uuid,
  p_admin_id uuid
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payout RECORD;
  v_total_earned numeric;
  v_total_paid numeric;
  v_available numeric;
  v_lock_key bigint;
BEGIN
  -- 1. Load and validate the target payout
  SELECT * INTO v_payout FROM reseller_payouts
    WHERE id = p_payout_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_found');
  END IF;

  -- CAS: only approved payouts can be marked paid
  IF v_payout.status != 'approved' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_approved', 'status', v_payout.status);
  END IF;

  -- 2. Serialize on the reseller's payout balance domain
  --    This advisory lock prevents two concurrent mark_paid requests
  --    for different payouts of the same reseller from both succeeding
  --    when the combined amount exceeds available balance.
  v_lock_key := abs(hashtext('reseller_payout_balance:' || v_payout.reseller_id::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- 3. Calculate authoritative available balance inside the lock
  SELECT COALESCE(SUM(pf.reseller_commission), 0)
    INTO v_total_earned
    FROM platform_fees pf
    WHERE pf.reseller_id = v_payout.reseller_id;

  SELECT COALESCE(SUM(rp.net_amount), 0)
    INTO v_total_paid
    FROM reseller_payouts rp
    WHERE rp.reseller_id = v_payout.reseller_id
      AND rp.status = 'paid';

  v_available := v_total_earned - v_total_paid;

  IF v_payout.net_amount > v_available THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'insufficient_balance',
      'total_earned', v_total_earned,
      'total_paid', v_total_paid,
      'available', v_available,
      'requested', v_payout.net_amount
    );
  END IF;

  -- 4. Transition the payout — CAS guard on status
  UPDATE reseller_payouts
    SET status = 'paid',
        paid_at = NOW(),
        approved_by = COALESCE(approved_by, p_admin_id)
    WHERE id = p_payout_id
      AND status = 'approved';

  IF NOT FOUND THEN
    -- Another concurrent request already changed the status
    RETURN jsonb_build_object('success', false, 'reason', 'status_changed');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'available_after', v_available - v_payout.net_amount
  );
END;
$$;

-- Restrict execution
REVOKE EXECUTE ON FUNCTION mark_reseller_payout_paid(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_reseller_payout_paid(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION mark_reseller_payout_paid(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION mark_reseller_payout_paid(uuid, uuid) TO service_role;

-- ══════════════════════════════════════════════════════════
-- C. Overlapping period prevention
--    Uses btree_gist extension + exclusion constraint.
--
--    Convention: period_end is EXCLUSIVE.
--    [period_start, period_end) — period_end itself is NOT included.
--
--    Adjacent periods [Aug 1, Aug 15) + [Aug 15, Aug 31) are allowed.
--    Overlapping periods [Aug 1, Aug 15) + [Aug 10, Aug 20) are blocked.
--    Only enforced for non-rejected payouts (rejected can be re-created).
--
--    FAIL-CLOSED: If existing non-rejected overlapping periods exist,
--    this migration RAISES EXCEPTION and rolls back — never skips
--    the constraint or silently continues without it installed.
-- ══════════════════════════════════════════════════════════

-- Fail-closed: RAISE EXCEPTION if existing data has overlapping periods
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM reseller_payouts a
    JOIN reseller_payouts b ON a.reseller_id = b.reseller_id
      AND a.id < b.id
      AND a.status != 'rejected'
      AND b.status != 'rejected'
      AND daterange(a.period_start, a.period_end, '[)') && daterange(b.period_start, b.period_end, '[)')
  ) THEN
    RAISE EXCEPTION 'Migration 311 blocked: existing non-rejected reseller payouts have overlapping periods. Manual reconciliation required before the exclusion constraint can be installed.'
      USING HINT = 'Inspect reseller_payouts for overlapping period_start/period_end ranges where status != rejected. Resolve conflicts, then re-run.';
  END IF;
END $$;

-- Install the exclusion constraint — period_end is exclusive, no +1 needed
ALTER TABLE reseller_payouts
  ADD CONSTRAINT reseller_payouts_no_overlap
  EXCLUDE USING gist (
    reseller_id WITH =,
    daterange(period_start, period_end, '[)') WITH &&
  ) WHERE (status != 'rejected');

COMMIT;
