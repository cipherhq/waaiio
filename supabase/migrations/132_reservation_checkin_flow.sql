-- ═══════════════════════════════════════════════════════
-- Migration 132: Reservation Check-In/Check-Out Flow
-- Adds missing enum values, notes and checked_in_by columns,
-- and ensures proper status transitions for property reservations.
-- ═══════════════════════════════════════════════════════

-- 1. Add missing enum values to reservation_status
-- The original enum (001) has: pending, confirmed, seated, completed, no_show, cancelled
-- Migration 039 tried to create it with checked_in/checked_out but it already existed
-- The dashboard uses in_progress — add all three for completeness
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'in_progress';
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'checked_in';
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'checked_out';

-- 2. Add notes column to reservations (dashboard saves notes but column doesn't exist)
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS notes TEXT;

-- 3. Add checked_in_by column (tracks who performed check-in: staff name or 'self')
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_in_by VARCHAR(100);
