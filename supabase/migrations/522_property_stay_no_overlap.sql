-- ═══════════════════════════════════════════════════════
-- Migration 522: two live stays can never share a night at one property (#922, from #921 item 3)
--
-- Why: the WhatsApp bot checks for overlapping stays and then inserts in a
-- separate statement, and skips the check after the terms step. Nothing in
-- the database stops two overlapping stays, so two customers can both get
-- the same nights.
--
-- What it changes:
--   * adds the exclusion constraint reservations_no_overlapping_stay on
--     public.reservations, keyed on (business_id, property_id, nights):
--     within one business and one property, no two stays whose status is
--     NOT cancelled, no_show, checked_out or completed may share a night.
--     The status rule is a deny-list, so any other status (including ones
--     added later) holds its nights. Nights are half-open
--     [check_in, check_out): a stay that checks out on the 5th and one that
--     checks in on the 5th are both allowed. A refused write fails with
--     SQLSTATE 23P01 (exclusion_violation);
--   * rows with property_id NULL (legacy rows that only carry service_id;
--     2 in production on 2026-11-05, both ended) are outside the constraint;
--   * no new function, no grants, no RLS, policy or trigger change;
--   * fails closed: it raises an error and installs nothing if btree_gist is
--     missing, if existing live stays already overlap, or if a constraint
--     with this name exists with a different definition.
--
-- Compatible with the live app: the bot is the only app code that creates
-- stays, and nothing changes check_in/check_out after creation. Status
-- changes from the dashboard and check-in that turn a finished stay back
-- into a live one over taken nights are now refused (23P01). Live
-- production and staging had 0 overlapping live stays under this key on
-- 2026-11-05 (read-only count).
--
-- Idempotent: a re-run finds the identical constraint and does nothing.
-- No BEGIN/COMMIT: applied as one whole-file statement.
-- ═══════════════════════════════════════════════════════

DO $$
DECLARE
  v_expected CONSTANT text :=
    'EXCLUDE USING gist (business_id WITH =, property_id WITH =, daterange(check_in, check_out, ''[)''::text) WITH &&) '
    || 'WHERE (((property_id IS NOT NULL) AND (status <> ALL (ARRAY[''cancelled''::reservation_status, '
    || '''no_show''::reservation_status, ''checked_out''::reservation_status, ''completed''::reservation_status]))))';
  v_existing text;
BEGIN
  -- business_id / property_id WITH = need the btree_gist operator classes for uuid.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION 'Migration 522 blocked: extension btree_gist is not installed';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_existing
  FROM pg_constraint
  WHERE conrelid = 'public.reservations'::regclass
    AND conname = 'reservations_no_overlapping_stay';

  IF v_existing IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.reservations a
      JOIN public.reservations b
        ON a.business_id = b.business_id
       AND a.property_id = b.property_id
       AND a.id < b.id
       AND daterange(a.check_in, a.check_out, '[)') && daterange(b.check_in, b.check_out, '[)')
      WHERE a.status <> ALL (ARRAY['cancelled', 'no_show', 'checked_out', 'completed']::public.reservation_status[])
        AND b.status <> ALL (ARRAY['cancelled', 'no_show', 'checked_out', 'completed']::public.reservation_status[])
    ) THEN
      RAISE EXCEPTION 'Migration 522 blocked: existing live stays overlap at the same property'
        USING HINT = 'Find reservations with the same business_id and property_id, a status other than cancelled/no_show/checked_out/completed and overlapping [check_in, check_out). Resolve them, then re-run.';
    END IF;

    ALTER TABLE public.reservations
      ADD CONSTRAINT reservations_no_overlapping_stay
      EXCLUDE USING gist (
        business_id WITH =,
        property_id WITH =,
        daterange(check_in, check_out, '[)') WITH &&
      ) WHERE (
        property_id IS NOT NULL
        AND status <> ALL (ARRAY['cancelled', 'no_show', 'checked_out', 'completed']::public.reservation_status[])
      );

    SELECT pg_get_constraintdef(oid) INTO v_existing
    FROM pg_constraint
    WHERE conrelid = 'public.reservations'::regclass
      AND conname = 'reservations_no_overlapping_stay';
  END IF;

  IF v_existing IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Migration 522 blocked: reservations_no_overlapping_stay has an unexpected definition: %', v_existing;
  END IF;
END
$$;

COMMENT ON CONSTRAINT reservations_no_overlapping_stay ON public.reservations IS
  'M522 (#922): within one business and property, two stays that are not cancelled/no_show/checked_out/completed cannot share a night [check_in, check_out). Refusals raise 23P01; the bot answers with Choose New Dates.';
