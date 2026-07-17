-- ═══════════════════════════════════════════════════════
-- 249: Reseller payout overlap constraint
-- ═══════════════════════════════════════════════════════
-- Prevents overlapping payout periods for the same reseller at the database
-- level. The application-level overlap check is race-prone (query then insert).
-- This exclusion constraint makes it impossible to insert overlapping periods.

-- Enable btree_gist extension for daterange exclusion constraints
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Add exclusion constraint: no two non-rejected payouts for the same reseller
-- can have overlapping date ranges.
ALTER TABLE public.reseller_payouts
  ADD CONSTRAINT reseller_payouts_no_overlap
  EXCLUDE USING gist (
    reseller_id WITH =,
    daterange(period_start, period_end) WITH &&
  )
  WHERE (status != 'rejected');
