-- 457: Party tables + seat assignments — Phase B1-2 (#661)
-- Creates party_tables for table/seating management.
-- Adds table_id and seat_number to event_invites for guest-to-table assignments.

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

-- Owner: full CRUD
CREATE POLICY "Business owners manage party tables"
  ON public.party_tables
  FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Admin: read-only (M439 pattern)
CREATE POLICY "Admin reads party tables"
  ON public.party_tables
  FOR SELECT
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

-- GRANTs for authenticated role
GRANT SELECT, INSERT, UPDATE, DELETE ON public.party_tables TO authenticated;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_party_tables_party ON public.party_tables(party_id);
CREATE INDEX IF NOT EXISTS idx_party_tables_business ON public.party_tables(business_id);

-- ═══════════════════════════════════════════════════════════
-- 2. Add table_id and seat_number to event_invites
-- ═══════════════════════════════════════════════════════════
ALTER TABLE public.event_invites
  ADD COLUMN IF NOT EXISTS table_id UUID REFERENCES party_tables(id) ON DELETE SET NULL;

ALTER TABLE public.event_invites
  ADD COLUMN IF NOT EXISTS seat_number INTEGER;

-- Index for looking up guests by table
CREATE INDEX IF NOT EXISTS idx_event_invites_table ON public.event_invites(table_id)
  WHERE table_id IS NOT NULL;
