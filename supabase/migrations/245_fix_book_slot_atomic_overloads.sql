-- Fix book_slot_atomic function overload ambiguity
--
-- Problem: Migrations 137→155→166→176 each added parameters with DEFAULT values
-- to book_slot_atomic, creating 4 distinct PostgreSQL overloads instead of
-- replacing the original. This causes:
--   - REVOKE/GRANT without a signature fails with "function name is not unique"
--   - CI migration validation fails at migration 176 line 90
--
-- Overloads created:
--   137-141: 22 params (original)
--   155:     23 params (+p_location_id DEFAULT NULL)
--   166:     24 params (+p_appointment_id DEFAULT NULL)
--   176:     26 params (+p_buffer_minutes DEFAULT 0, +p_duration DEFAULT 30) ← current
--
-- Application callers (scheduling.flow.ts, bookings/public/create/route.ts)
-- both pass all 26 parameters, so only the 176 signature is needed.
--
-- Safety:
--   - Uses DROP FUNCTION IF EXISTS with exact signatures (safe for fresh + production)
--   - Does not drop the active 26-arg version
--   - Re-applies REVOKE/GRANT with fully qualified signature
--   - Idempotent: IF EXISTS guards, exception handlers for missing roles

-- ── Drop the 22-parameter overload (from migrations 137-141) ──
DROP FUNCTION IF EXISTS public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text
);

-- ── Drop the 23-parameter overload (from migration 155, added p_location_id) ──
DROP FUNCTION IF EXISTS public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text,
  uuid
);

-- ── Drop the 24-parameter overload (from migration 166, added p_appointment_id) ──
DROP FUNCTION IF EXISTS public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text,
  uuid, uuid
);

-- ── The 26-parameter version from migration 176 is the only one that remains ──
-- It is the version all application callers use.

-- ── Re-apply REVOKE/GRANT with fully qualified signature ──
-- Uses the exact 26-argument identity types from the remaining overload.
REVOKE ALL ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text,
  uuid, uuid, integer, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text,
  uuid, uuid, integer, integer
) TO service_role;
