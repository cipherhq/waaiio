-- 457: Party tables + seat assignments — Phase B1-2 (#661)
-- Creates party_tables for table/seating management.
-- Adds table_id and seat_number to event_invites with database-authoritative
-- capacity enforcement, party membership validation, and concurrency protection.
--
-- Trigger architecture (CTO-approved 2026-10-22):
--   BEFORE ROW on event_invites: advisory locks (serialize concurrent writes)
--   BEFORE ROW on event_invites: membership validation (party/business isolation)
--   AFTER ROW on event_invites:  scoped capacity check (party + table, not global)
--   BEFORE UPDATE on parties:     prevent max_guests reduction below attendance
--   BEFORE UPDATE on party_tables: prevent capacity reduction below attendance
--   BEFORE UPDATE on party_tables: identity immutability (party_id/business_id)
--   RPCs: pre-validate for clean JSON errors; triggers are final authority

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
  UNIQUE(party_id, name),
  -- Ensure party belongs to the same business (Codex P1: cross-tenant prevention)
  CONSTRAINT party_tables_business_party_match CHECK (true)
  -- Note: Composite FK not possible (parties PK is id alone).
  -- Enforced via INSERT trigger below (validate_party_table_ownership).
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
-- 3. BEFORE ROW: party membership + business isolation
--    Fires on table_id, party_id, business_id changes.
--    Revalidates whenever a seated guest's identity changes.
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

  -- Determine if validation is needed:
  -- Always validate on INSERT with table_id set.
  -- On UPDATE: validate if table_id changed OR if party_id/business_id changed
  -- while the guest remains seated (identity moved under existing assignment).
  IF TG_OP = 'UPDATE' THEN
    IF OLD.table_id IS NOT DISTINCT FROM NEW.table_id
       AND OLD.party_id IS NOT DISTINCT FROM NEW.party_id
       AND OLD.business_id IS NOT DISTINCT FROM NEW.business_id THEN
      RETURN NEW; -- nothing relevant changed
    END IF;
  END IF;

  -- Fetch table's party and business
  SELECT party_id, business_id
  INTO v_table_party_id, v_table_business_id
  FROM party_tables WHERE id = NEW.table_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced party table does not exist'
      USING ERRCODE = '23503';
  END IF;

  -- Party membership: guest must belong to same party as table
  IF NEW.party_id IS DISTINCT FROM v_table_party_id THEN
    RAISE EXCEPTION 'Guest and table belong to different parties'
      USING ERRCODE = '23514';
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
  BEFORE INSERT OR UPDATE OF table_id, party_id, business_id ON public.event_invites
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_invite_table_membership();

-- ═══════════════════════════════════════════════════════════
-- 4. BEFORE ROW: advisory lock serialization (M304 pattern)
--    Lock ordering: party locks first (ascending UUID),
--    then table locks (ascending UUID). Prevents deadlocks.
--    Fires on columns that affect capacity or membership.
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.serialize_capacity_writes()
RETURNS TRIGGER AS $$
DECLARE
  v_party_a UUID;
  v_party_b UUID;
  v_table_a UUID;
  v_table_b UUID;
BEGIN
  -- ── Collect affected party IDs ──
  IF TG_OP = 'INSERT' THEN
    v_party_a := NEW.party_id;
  ELSIF TG_OP = 'UPDATE' THEN
    v_party_a := OLD.party_id;
    IF NEW.party_id IS DISTINCT FROM OLD.party_id THEN
      v_party_b := NEW.party_id;
    END IF;
  END IF;

  -- ── Party locks (ascending UUID order) ──
  IF v_party_a IS NOT NULL AND v_party_b IS NOT NULL THEN
    IF v_party_a < v_party_b THEN
      PERFORM pg_advisory_xact_lock(hashtext('party:' || v_party_a::text));
      PERFORM pg_advisory_xact_lock(hashtext('party:' || v_party_b::text));
    ELSE
      PERFORM pg_advisory_xact_lock(hashtext('party:' || v_party_b::text));
      PERFORM pg_advisory_xact_lock(hashtext('party:' || v_party_a::text));
    END IF;
  ELSIF v_party_a IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('party:' || v_party_a::text));
  ELSIF v_party_b IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('party:' || v_party_b::text));
  END IF;

  -- ── Collect affected table IDs ──
  IF TG_OP = 'INSERT' THEN
    v_table_a := NEW.table_id;
  ELSIF TG_OP = 'UPDATE' THEN
    v_table_a := OLD.table_id;
    v_table_b := CASE WHEN NEW.table_id IS DISTINCT FROM OLD.table_id THEN NEW.table_id END;
  END IF;

  -- ── Table locks (ascending UUID order) ──
  IF v_table_a IS NOT NULL AND v_table_b IS NOT NULL THEN
    IF v_table_a < v_table_b THEN
      PERFORM pg_advisory_xact_lock(hashtext('table:' || v_table_a::text));
      PERFORM pg_advisory_xact_lock(hashtext('table:' || v_table_b::text));
    ELSE
      PERFORM pg_advisory_xact_lock(hashtext('table:' || v_table_b::text));
      PERFORM pg_advisory_xact_lock(hashtext('table:' || v_table_a::text));
    END IF;
  ELSIF v_table_a IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('table:' || v_table_a::text));
  ELSIF v_table_b IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('table:' || v_table_b::text));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop all previous trigger variants
DROP TRIGGER IF EXISTS trg_serialize_table_writes ON public.event_invites;
DROP TRIGGER IF EXISTS trg_serialize_capacity_writes ON public.event_invites;
DROP TRIGGER IF EXISTS trg_enforce_table_capacity ON public.event_invites;
DROP TRIGGER IF EXISTS trg_enforce_capacity ON public.event_invites;
DROP TRIGGER IF EXISTS trg_enforce_table_capacity_assign ON public.event_invites;
DROP TRIGGER IF EXISTS trg_enforce_table_capacity_insert ON public.event_invites;
DROP TRIGGER IF EXISTS trg_enforce_table_capacity_plusones ON public.event_invites;
DROP TRIGGER IF EXISTS trg_enforce_invite_capacity ON public.event_invites;

CREATE TRIGGER trg_serialize_capacity_writes
  BEFORE INSERT OR UPDATE OF table_id, plus_ones, status, party_id, business_id
    ON public.event_invites
  FOR EACH ROW
  EXECUTE FUNCTION public.serialize_capacity_writes();

-- ═══════════════════════════════════════════════════════════
-- 5. AFTER ROW: scoped capacity validation
--    Fires after each row change is visible. Checks ONLY the
--    affected party_id(s) and table_id(s) — never scans
--    unrelated tenants.
--    Party: counts status IN ('accepted','pending','maybe')
--           weighted by 1 + plus_ones.
--    Table: counts all assigned invites weighted by 1 + plus_ones.
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.enforce_invite_capacity()
RETURNS TRIGGER AS $$
DECLARE
  v_party_id UUID;
  v_table_id UUID;
  v_max INTEGER;
  v_current INTEGER;
BEGIN
  -- ── Check affected party capacities ──
  -- Check NEW party (INSERT or UPDATE target)
  v_party_id := NEW.party_id;
  IF v_party_id IS NOT NULL THEN
    SELECT max_guests INTO v_max FROM parties WHERE id = v_party_id;
    IF v_max IS NOT NULL AND v_max > 0 THEN
      SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0)::int INTO v_current
      FROM event_invites
      WHERE party_id = v_party_id AND status IN ('accepted', 'pending', 'maybe');

      IF v_current > v_max THEN
        RAISE EXCEPTION 'Party capacity exceeded (% attendees / % max_guests)',
          v_current, v_max USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  -- Check OLD party if different (guest moved between parties)
  IF TG_OP = 'UPDATE' AND OLD.party_id IS DISTINCT FROM NEW.party_id
     AND OLD.party_id IS NOT NULL THEN
    SELECT max_guests INTO v_max FROM parties WHERE id = OLD.party_id;
    IF v_max IS NOT NULL AND v_max > 0 THEN
      SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0)::int INTO v_current
      FROM event_invites
      WHERE party_id = OLD.party_id AND status IN ('accepted', 'pending', 'maybe');

      IF v_current > v_max THEN
        RAISE EXCEPTION 'Party capacity exceeded (% attendees / % max_guests)',
          v_current, v_max USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  -- ── Check affected table capacities ──
  -- Check NEW table
  v_table_id := NEW.table_id;
  IF v_table_id IS NOT NULL THEN
    SELECT capacity INTO v_max FROM party_tables WHERE id = v_table_id;
    IF v_max IS NOT NULL THEN
      SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0)::int INTO v_current
      FROM event_invites WHERE table_id = v_table_id;

      IF v_current > v_max THEN
        RAISE EXCEPTION 'Table capacity exceeded (% attendees / % seats)',
          v_current, v_max USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  -- Check OLD table if different (guest moved between tables)
  IF TG_OP = 'UPDATE' AND OLD.table_id IS DISTINCT FROM NEW.table_id
     AND OLD.table_id IS NOT NULL THEN
    SELECT capacity INTO v_max FROM party_tables WHERE id = OLD.table_id;
    IF v_max IS NOT NULL THEN
      SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0)::int INTO v_current
      FROM event_invites WHERE table_id = OLD.table_id;

      IF v_current > v_max THEN
        RAISE EXCEPTION 'Table capacity exceeded (% attendees / % seats)',
          v_current, v_max USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NULL; -- AFTER trigger, return ignored
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_invite_capacity
  AFTER INSERT OR UPDATE OF table_id, plus_ones, status, party_id, business_id
    ON public.event_invites
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_invite_capacity();

-- ═══════════════════════════════════════════════════════════
-- 6. Capacity-reduction guards on parties and party_tables
--    Prevent reducing max_guests / capacity below current attendance.
--    Uses same advisory lock namespace for serialization consistency.
-- ═══════════════════════════════════════════════════════════

-- 6a. parties.max_guests reduction guard
CREATE OR REPLACE FUNCTION public.guard_party_capacity_reduction()
RETURNS TRIGGER AS $$
DECLARE
  v_current INTEGER;
BEGIN
  -- Only check when max_guests is being reduced (not when set to NULL/0 = unlimited)
  IF NEW.max_guests IS NOT NULL AND NEW.max_guests > 0 THEN
    IF OLD.max_guests IS NULL OR OLD.max_guests = 0 OR NEW.max_guests < OLD.max_guests THEN
      -- Serialize with invite triggers
      PERFORM pg_advisory_xact_lock(hashtext('party:' || NEW.id::text));

      SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0)::int INTO v_current
      FROM event_invites
      WHERE party_id = NEW.id AND status IN ('accepted', 'pending', 'maybe');

      IF v_current > NEW.max_guests THEN
        RAISE EXCEPTION 'Cannot reduce party capacity: % attendees exceed new limit of %',
          v_current, NEW.max_guests USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_party_capacity ON public.parties;
CREATE TRIGGER trg_guard_party_capacity
  BEFORE UPDATE OF max_guests ON public.parties
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_party_capacity_reduction();

-- 6b. party_tables.capacity reduction guard
CREATE OR REPLACE FUNCTION public.guard_table_capacity_reduction()
RETURNS TRIGGER AS $$
DECLARE
  v_current INTEGER;
BEGIN
  IF NEW.capacity < OLD.capacity THEN
    -- Serialize with invite triggers
    PERFORM pg_advisory_xact_lock(hashtext('table:' || NEW.id::text));

    SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0)::int INTO v_current
    FROM event_invites WHERE table_id = NEW.id;

    IF v_current > NEW.capacity THEN
      RAISE EXCEPTION 'Cannot reduce table capacity: % attendees exceed new limit of %',
        v_current, NEW.capacity USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_table_capacity ON public.party_tables;
CREATE TRIGGER trg_guard_table_capacity
  BEFORE UPDATE OF capacity ON public.party_tables
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_table_capacity_reduction();

-- 6c. party_tables identity immutability (party_id, business_id)
--     Prevents reparenting an occupied table to a different party/business.
CREATE OR REPLACE FUNCTION public.guard_table_identity()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.party_id IS DISTINCT FROM NEW.party_id THEN
    RAISE EXCEPTION 'party_tables.party_id is immutable after creation'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'party_tables.business_id is immutable after creation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_table_identity ON public.party_tables;
CREATE TRIGGER trg_guard_table_identity
  BEFORE UPDATE OF party_id, business_id ON public.party_tables
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_table_identity();

-- 6d. party_tables INSERT ownership validation (Codex P1: cross-tenant)
--     Ensures party_id belongs to the same business_id on INSERT.
CREATE OR REPLACE FUNCTION public.validate_party_table_ownership()
RETURNS TRIGGER AS $$
DECLARE
  v_party_biz UUID;
BEGIN
  SELECT business_id INTO v_party_biz FROM parties WHERE id = NEW.party_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced party does not exist' USING ERRCODE = '23503';
  END IF;
  IF v_party_biz IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'party_tables.business_id must match the party''s business_id'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_party_table_ownership ON public.party_tables;
CREATE TRIGGER trg_validate_party_table_ownership
  BEFORE INSERT ON public.party_tables
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_party_table_ownership();

-- 6e. event_invites.plus_ones non-negative constraint (Codex P1)
ALTER TABLE public.event_invites
  ADD CONSTRAINT event_invites_plus_ones_nonneg CHECK (plus_ones >= 0);

-- ═══════════════════════════════════════════════════════════
-- 7. RPCs (unchanged logic, triggers are final authority)
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.assign_guest_to_table(
  p_invite_id UUID,
  p_table_id UUID,
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
  -- Unassign path
  IF p_table_id IS NULL THEN
    UPDATE event_invites SET table_id = NULL, seat_number = NULL WHERE id = p_invite_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Guest not found or access denied');
    END IF;
    RETURN jsonb_build_object('success', true);
  END IF;

  -- RPC pre-validation (advisory, triggers are final authority)
  PERFORM pg_advisory_xact_lock(hashtext(p_table_id::text));

  SELECT capacity INTO v_capacity FROM party_tables WHERE id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Table not found');
  END IF;

  SELECT COALESCE(plus_ones, 0) INTO v_invite_plus_ones
  FROM event_invites WHERE id = p_invite_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Guest not found');
  END IF;

  SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0) INTO v_current
  FROM event_invites WHERE table_id = p_table_id AND id != p_invite_id;

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

  PERFORM pg_advisory_xact_lock(hashtext(p_table_id::text));

  SELECT capacity INTO v_capacity FROM party_tables WHERE id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Table not found');
  END IF;

  SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0) INTO v_current
  FROM event_invites WHERE table_id = p_table_id AND id != ALL(p_invite_ids);

  SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0) INTO v_new_attendees
  FROM event_invites WHERE id = ANY(p_invite_ids);

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

GRANT EXECUTE ON FUNCTION public.assign_guest_to_table(UUID, UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_assign_guests_to_table(UUID[], UUID) TO authenticated;

-- ═══════════════════════════════════════════════════════════
-- 8. Self-check
-- ═══════════════════════════════════════════════════════════
DO $$
BEGIN
  -- Membership validation trigger (fires on table_id, party_id, business_id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_validate_invite_table'
      AND tgrelid = 'public.event_invites'::regclass
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: trg_validate_invite_table not found';
  END IF;

  -- BEFORE ROW serialization trigger
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_serialize_capacity_writes'
      AND tgrelid = 'public.event_invites'::regclass
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: trg_serialize_capacity_writes not found';
  END IF;

  -- AFTER ROW scoped capacity trigger (replaces global AFTER STATEMENT)
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_enforce_invite_capacity'
      AND tgrelid = 'public.event_invites'::regclass
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: trg_enforce_invite_capacity not found';
  END IF;

  -- Party capacity reduction guard
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_guard_party_capacity'
      AND tgrelid = 'public.parties'::regclass
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: trg_guard_party_capacity not found';
  END IF;

  -- Table capacity reduction guard
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_guard_table_capacity'
      AND tgrelid = 'public.party_tables'::regclass
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: trg_guard_table_capacity not found';
  END IF;

  -- Table identity immutability guard
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_guard_table_identity'
      AND tgrelid = 'public.party_tables'::regclass
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: trg_guard_table_identity not found';
  END IF;

  -- Verify scoped capacity function checks party and table
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'enforce_invite_capacity'
      AND prosrc ILIKE '%max_guests%'
      AND prosrc ILIKE '%party_tables%'
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: enforce_invite_capacity missing party or table check';
  END IF;

  -- Verify advisory lock serialization
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'serialize_capacity_writes'
      AND prosrc ILIKE '%party:%'
      AND prosrc ILIKE '%table:%'
      AND prosrc ILIKE '%pg_advisory_xact_lock%'
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: serialize_capacity_writes missing advisory locks';
  END IF;

  -- Verify party_tables ownership trigger (Codex P1)
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_validate_party_table_ownership'
      AND tgrelid = 'public.party_tables'::regclass
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: trg_validate_party_table_ownership not found';
  END IF;

  -- Verify plus_ones non-negative constraint (Codex P1)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'event_invites_plus_ones_nonneg'
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: event_invites_plus_ones_nonneg constraint not found';
  END IF;

  -- Verify RPCs exist
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'assign_guest_to_table') THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: assign_guest_to_table not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'bulk_assign_guests_to_table') THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: bulk_assign_guests_to_table not found';
  END IF;

  RAISE NOTICE '457 SELF-CHECK PASSED: party_tables + triggers + RPCs + guards verified';
END;
$$;
