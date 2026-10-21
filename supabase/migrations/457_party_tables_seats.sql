-- 457: Party tables + seat assignments — Phase B1-2 (#661)
-- Creates party_tables for table/seating management.
-- Adds table_id and seat_number to event_invites with database-authoritative
-- capacity enforcement, party membership validation, and concurrency protection.
--
-- Concurrency strategy (matches M304 advisory-lock + M451 FOR UPDATE patterns):
--   ROW trigger:       validates party membership + business isolation (deterministic)
--   STATEMENT trigger:  FOR UPDATE on party_tables to serialize concurrent assignments,
--                       then counts actual seats. Rolls back on capacity breach.
--   RPCs:              assign_guest_to_table / bulk_assign_guests_to_table
--                       provide clean JSON API; triggers enforce invariants on ALL paths.

-- ═══════════════════════════════════════════════════════════
-- 1. party_tables — each row is a named table with a capacity
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.party_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  party_id UUID NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 10
    CHECK (capacity > 0 AND capacity <= 500),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(party_id, name)
);

ALTER TABLE public.party_tables ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business owners manage party tables"
  ON public.party_tables
  FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Admin reads party tables"
  ON public.party_tables
  FOR SELECT
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.party_tables TO authenticated;

CREATE INDEX IF NOT EXISTS idx_party_tables_party ON public.party_tables(party_id);
CREATE INDEX IF NOT EXISTS idx_party_tables_business ON public.party_tables(business_id);

-- ═══════════════════════════════════════════════════════════
-- 2. Add table_id and seat_number to event_invites
-- ═══════════════════════════════════════════════════════════
ALTER TABLE public.event_invites
  ADD COLUMN IF NOT EXISTS table_id UUID REFERENCES party_tables(id) ON DELETE SET NULL;

ALTER TABLE public.event_invites
  ADD COLUMN IF NOT EXISTS seat_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_event_invites_table ON public.event_invites(table_id)
  WHERE table_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════
-- 3. ROW trigger: party membership + business isolation
--    Deterministic checks — no concurrency concern.
--    Fires on ALL write paths (RPC, direct SQL, service_role).
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.validate_invite_table_membership()
RETURNS TRIGGER AS $$
DECLARE
  v_table_party_id UUID;
  v_table_business_id UUID;
BEGIN
  -- Unassign: always allowed, clear seat_number
  IF NEW.table_id IS NULL THEN
    NEW.seat_number := NULL;
    RETURN NEW;
  END IF;

  -- Skip if table_id unchanged (seat_number-only update)
  IF TG_OP = 'UPDATE' AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id THEN
    RETURN NEW;
  END IF;

  -- Fetch table's party and business
  SELECT party_id, business_id
  INTO v_table_party_id, v_table_business_id
  FROM party_tables WHERE id = NEW.table_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced party table does not exist'
      USING ERRCODE = '23503'; -- foreign_key_violation
  END IF;

  -- Party membership: guest must belong to same party as table
  IF NEW.party_id IS DISTINCT FROM v_table_party_id THEN
    RAISE EXCEPTION 'Guest and table belong to different parties'
      USING ERRCODE = '23514'; -- check_violation
  END IF;

  -- Business isolation
  IF NEW.business_id IS DISTINCT FROM v_table_business_id THEN
    RAISE EXCEPTION 'Cross-business table assignment denied'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_invite_table ON public.event_invites;
CREATE TRIGGER trg_validate_invite_table
  BEFORE INSERT OR UPDATE OF table_id ON public.event_invites
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_invite_table_membership();

-- ═══════════════════════════════════════════════════════════
-- 4. Capacity enforcement — three-layer strategy
--
--    Layer 1 (BEFORE ROW trigger): pg_advisory_xact_lock on
--    the affected table_id. Serializes ALL concurrent writes
--    (assignments + plus_ones changes) that affect the same
--    table. Matches M304 book_slot_atomic pattern.
--
--    Layer 2 (AFTER STATEMENT trigger): Post-hoc final-state
--    check. Catches violations from bulk operations within a
--    single statement. Blocked transactions get fresh snapshot
--    after advisory lock acquisition — sees committed counts.
--
--    Layer 3 (RPCs): Pre-validate capacity with advisory lock
--    for clean JSON error responses (application layer).
--
--    Attendee counting: SUM(1 + plus_ones) per table (#661 owner policy).
-- ═══════════════════════════════════════════════════════════

-- BEFORE ROW trigger: serialize on table_id via advisory lock (M304 pattern)
-- Fires on table_id changes AND plus_ones changes.
-- Guarantees that concurrent direct SQL mutations cannot bypass capacity.
CREATE OR REPLACE FUNCTION public.serialize_table_writes()
RETURNS TRIGGER AS $$
DECLARE
  v_lock_table_id UUID;
BEGIN
  -- Determine which table_id to serialize on
  IF TG_OP = 'INSERT' THEN
    v_lock_table_id := NEW.table_id;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Lock new table_id (assignment/reassignment)
    IF NEW.table_id IS NOT NULL AND (OLD.table_id IS DISTINCT FROM NEW.table_id) THEN
      v_lock_table_id := NEW.table_id;
    -- Lock current table_id when plus_ones change on an assigned guest
    ELSIF NEW.table_id IS NOT NULL AND (OLD.plus_ones IS DISTINCT FROM NEW.plus_ones) THEN
      v_lock_table_id := NEW.table_id;
    END IF;
    -- Also serialize on old table_id for reassignment (frees capacity there)
    IF OLD.table_id IS NOT NULL AND OLD.table_id IS DISTINCT FROM COALESCE(NEW.table_id, OLD.table_id) THEN
      PERFORM pg_advisory_xact_lock(hashtext(OLD.table_id::text));
    END IF;
  END IF;

  IF v_lock_table_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_lock_table_id::text));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER STATEMENT trigger: post-hoc capacity check
CREATE OR REPLACE FUNCTION public.enforce_table_capacity()
RETURNS TRIGGER AS $$
DECLARE
  v_over RECORD;
BEGIN
  -- Find any party table where attendees exceed capacity.
  -- Fires after all rows in the statement are modified AND after
  -- BEFORE triggers have acquired advisory locks. Blocked transactions
  -- get fresh snapshot after lock — sees committed counts.
  FOR v_over IN
    SELECT pt.name, pt.capacity,
           COALESCE(SUM(1 + COALESCE(ei.plus_ones, 0)), 0)::int AS attendees
    FROM party_tables pt
    JOIN event_invites ei ON ei.table_id = pt.id
    GROUP BY pt.id, pt.name, pt.capacity
    HAVING COALESCE(SUM(1 + COALESCE(ei.plus_ones, 0)), 0) > pt.capacity
    LIMIT 1
  LOOP
    RAISE EXCEPTION 'Table "%" capacity exceeded (% attendees / % seats)',
      v_over.name, v_over.attendees, v_over.capacity
      USING ERRCODE = '23514';
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_serialize_table_writes ON public.event_invites;
DROP TRIGGER IF EXISTS trg_enforce_table_capacity ON public.event_invites;
DROP TRIGGER IF EXISTS trg_enforce_table_capacity_assign ON public.event_invites;
DROP TRIGGER IF EXISTS trg_enforce_table_capacity_insert ON public.event_invites;
DROP TRIGGER IF EXISTS trg_enforce_table_capacity_plusones ON public.event_invites;

-- BEFORE ROW: acquire advisory lock to serialize concurrent writes
CREATE TRIGGER trg_serialize_table_writes
  BEFORE INSERT OR UPDATE OF table_id, plus_ones ON public.event_invites
  FOR EACH ROW
  EXECUTE FUNCTION public.serialize_table_writes();

-- AFTER STATEMENT: post-hoc capacity check with fresh snapshot
CREATE TRIGGER trg_enforce_table_capacity
  AFTER INSERT OR UPDATE ON public.event_invites
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enforce_table_capacity();

-- ═══════════════════════════════════════════════════════════
-- 5. RPC: assign_guest_to_table (single assignment)
--    Advisory lock serializes concurrent assignments to same table.
--    Pre-validates capacity before UPDATE (avoids trigger rollback).
--    STATEMENT trigger provides defense-in-depth for direct SQL.
--    SECURITY INVOKER: RLS on event_invites still applies.
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.assign_guest_to_table(
  p_invite_id UUID,
  p_table_id UUID,            -- NULL to unassign
  p_seat_number INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_count INTEGER;
  v_capacity INTEGER;
  v_current INTEGER;
  v_invite_plus_ones INTEGER;
BEGIN
  -- Unassign path: no capacity check needed
  IF p_table_id IS NULL THEN
    UPDATE event_invites
    SET table_id = NULL, seat_number = NULL
    WHERE id = p_invite_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Guest not found or access denied');
    END IF;
    RETURN jsonb_build_object('success', true);
  END IF;

  -- Serialize concurrent assignments to the same table (M304 pattern)
  PERFORM pg_advisory_xact_lock(hashtext(p_table_id::text));

  -- Pre-validate capacity (fresh snapshot after lock acquisition)
  SELECT capacity INTO v_capacity FROM party_tables WHERE id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Table not found');
  END IF;

  -- Get this invite's plus_ones (they count as attendees)
  SELECT COALESCE(plus_ones, 0) INTO v_invite_plus_ones
  FROM event_invites WHERE id = p_invite_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Guest not found');
  END IF;

  -- Count current attendees at this table (excluding this invite for reassignment)
  SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0) INTO v_current
  FROM event_invites
  WHERE table_id = p_table_id AND id != p_invite_id;

  -- This guest brings: 1 (self) + plus_ones
  IF v_current + 1 + v_invite_plus_ones > v_capacity THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Table capacity exceeded (%s attendees / %s seats)',
             v_current + 1 + v_invite_plus_ones, v_capacity));
  END IF;

  UPDATE event_invites
  SET table_id = p_table_id, seat_number = p_seat_number
  WHERE id = p_invite_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Guest not found or access denied');
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN check_violation THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  WHEN foreign_key_violation THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ═══════════════════════════════════════════════════════════
-- 6. RPC: bulk_assign_guests_to_table (all-or-nothing)
--    Advisory lock + pre-validation + single UPDATE.
--    STATEMENT trigger provides defense-in-depth.
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.bulk_assign_guests_to_table(
  p_invite_ids UUID[],
  p_table_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_count INTEGER;
  v_capacity INTEGER;
  v_current INTEGER;
  v_new_attendees INTEGER;
BEGIN
  IF p_invite_ids IS NULL OR array_length(p_invite_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', true, 'assigned', 0);
  END IF;

  -- Serialize on target table
  PERFORM pg_advisory_xact_lock(hashtext(p_table_id::text));

  SELECT capacity INTO v_capacity FROM party_tables WHERE id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Table not found');
  END IF;

  -- Count current attendees at target (excluding guests being reassigned)
  SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0) INTO v_current
  FROM event_invites
  WHERE table_id = p_table_id AND id != ALL(p_invite_ids);

  -- Count attendees being added (each invite + their plus_ones)
  SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0) INTO v_new_attendees
  FROM event_invites
  WHERE id = ANY(p_invite_ids);

  IF v_current + v_new_attendees > v_capacity THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Table capacity exceeded (%s attendees / %s seats)',
             v_current + v_new_attendees, v_capacity));
  END IF;

  UPDATE event_invites
  SET table_id = p_table_id, seat_number = NULL
  WHERE id = ANY(p_invite_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'assigned', v_count);
EXCEPTION
  WHEN check_violation THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  WHEN foreign_key_violation THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- GRANTs for RPCs
GRANT EXECUTE ON FUNCTION public.assign_guest_to_table(UUID, UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_assign_guests_to_table(UUID[], UUID) TO authenticated;

-- ═══════════════════════════════════════════════════════════
-- 7. Self-check (M451 pattern)
-- ═══════════════════════════════════════════════════════════
DO $$
BEGIN
  -- Verify ROW trigger exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_validate_invite_table'
      AND tgrelid = 'public.event_invites'::regclass
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: trg_validate_invite_table not found';
  END IF;

  -- Verify serialization BEFORE ROW trigger exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.event_invites'::regclass
      AND tgname = 'trg_serialize_table_writes'
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: trg_serialize_table_writes not found';
  END IF;

  -- Verify capacity AFTER STATEMENT trigger exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.event_invites'::regclass
      AND tgname = 'trg_enforce_table_capacity'
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: trg_enforce_table_capacity not found';
  END IF;

  -- Verify serialization function uses advisory lock (M304 pattern)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'serialize_table_writes'
      AND prosrc ILIKE '%pg_advisory_xact_lock%'
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: serialize_table_writes missing advisory lock';
  END IF;

  -- Verify capacity function uses attendee counting (SUM with plus_ones)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'enforce_table_capacity'
      AND prosrc ILIKE '%plus_ones%'
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: enforce_table_capacity missing attendee counting';
  END IF;

  -- Verify RPCs use advisory lock (M304 pattern)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'assign_guest_to_table'
      AND prosrc ILIKE '%pg_advisory_xact_lock%'
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: assign_guest_to_table missing advisory lock';
  END IF;

  -- Verify membership validation function checks party_id
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'validate_invite_table_membership'
      AND prosrc ILIKE '%party_id%'
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: validate_invite_table_membership missing party_id check';
  END IF;

  -- Verify RPC functions exist
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'assign_guest_to_table') THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: assign_guest_to_table RPC not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'bulk_assign_guests_to_table') THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: bulk_assign_guests_to_table RPC not found';
  END IF;

  RAISE NOTICE '457 SELF-CHECK PASSED: party_tables + triggers + RPCs verified';
END;
$$;
