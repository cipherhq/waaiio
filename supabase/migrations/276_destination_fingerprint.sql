-- ═══════════════════════════════════════════════════════
-- 276: Destination fingerprint + expanded account-change trigger
-- Stores SHA-256 of normalized destination fields instead of
-- masked account number. Covers field-level changes, not just
-- is_active toggle. Clears verification on destination change.
-- ═══════════════════════════════════════════════════════

-- Replace masked column with fingerprint
ALTER TABLE public.business_payouts
  ADD COLUMN IF NOT EXISTS destination_fingerprint VARCHAR(64);
