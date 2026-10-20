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
-- 4. STATEMENT trigger: capacity enforcement with serialization
--    Uses FOR UPDATE on party_tables to serialize concurrent
--    transactions (same pattern as M451 contract signer lock).
--    In READ COMMITTED, a blocked transaction gets a fresh
--    snapshot after lock acquisition — sees committed counts.
--    Rolls back entire statement on capacity breach.
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.enforce_table_capacity()
RETURNS TRIGGER AS $$
DECLARE
  v_rec RECORD;
  v_capacity INTEGER;
  v_current INTEGER;
BEGIN
  -- Check each table affected by this statement
  FOR v_rec IN
    SELECT DISTINCT table_id FROM new_rows WHERE table_id IS NOT NULL
  LOOP
    -- Lock the table row: serializes concurrent assignments to same table.
    -- Re-entrant within same transaction (safe when called via RPC that
    -- also locks this row). Blocked transactions get fresh snapshot on
    -- lock acquisition in READ COMMITTED mode.
    SELECT capacity INTO v_capacity
    FROM party_tables WHERE id = v_rec.table_id
    FOR UPDATE;

    IF NOT FOUND THEN
      -- FK constraint should prevent this, but defense in depth
      RAISE EXCEPTION 'Party table % not found', v_rec.table_id
        USING ERRCODE = '23503';
    END IF;

    -- Count actual seats (fresh snapshot after lock acquisition)
    SELECT COUNT(*) INTO v_current
    FROM event_invites WHERE table_id = v_rec.table_id;

    IF v_current > v_capacity THEN
      RAISE EXCEPTION 'Table capacity exceeded (%/% seats)', v_current, v_capacity
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NULL; -- AFTER trigger, return ignored
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_table_capacity ON public.event_invites;
CREATE TRIGGER trg_enforce_table_capacity
  AFTER INSERT OR UPDATE OF table_id ON public.event_invites
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.enforce_table_capacity();

-- ═══════════════════════════════════════════════════════════
-- 5. RPC: assign_guest_to_table (single assignment)
--    Thin wrapper — triggers enforce invariants.
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
BEGIN
  UPDATE event_invites
  SET table_id = p_table_id,
      seat_number = CASE WHEN p_table_id IS NULL THEN NULL ELSE p_seat_number END
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
--    Single UPDATE statement → single STATEMENT trigger →
--    rolls back entire batch on capacity breach.
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
BEGIN
  IF p_invite_ids IS NULL OR array_length(p_invite_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', true, 'assigned', 0);
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

  -- Verify STATEMENT trigger exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_enforce_table_capacity'
      AND tgrelid = 'public.event_invites'::regclass
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: trg_enforce_table_capacity not found';
  END IF;

  -- Verify capacity enforcement function contains FOR UPDATE
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'enforce_table_capacity'
      AND prosrc ILIKE '%FOR UPDATE%'
  ) THEN
    RAISE EXCEPTION '457 SELF-CHECK FAILED: enforce_table_capacity missing FOR UPDATE';
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
