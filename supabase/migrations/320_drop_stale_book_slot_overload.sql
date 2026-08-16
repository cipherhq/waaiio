-- Migration 320: Drop stale 26-arg book_slot_atomic overload
--
-- Production contains two public.book_slot_atomic overloads:
--
--   1. 26-arg (oid 32754): legacy — no advisory lock canonicalization,
--      no idempotent retry, no appointment schedule validation,
--      no staff availability, no requires_staff enforcement.
--      Created by a pre-313 migration, never replaced because 313+
--      used CREATE OR REPLACE on the NEW 27-arg signature.
--
--   2. 27-arg (oid 36198): canonical — includes all fixes from
--      migrations 313, 318, 319 (advisory locks, idempotent retry,
--      appointment schedule, staff availability, requires_staff).
--
-- Problem: when a caller omits p_bot_session_id (e.g. public web
-- booking), PostgreSQL resolves to the 26-arg "more specific" match,
-- bypassing all safety checks from 318/319. PostgREST named-argument
-- resolution makes this worse — ambiguous overloads can produce
-- unpredictable dispatch.
--
-- Fix: DROP the stale 26-arg overload. The canonical 27-arg version
-- has p_bot_session_id DEFAULT NULL, so callers that omit it still work.

DROP FUNCTION IF EXISTS public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, integer, integer,
  text, integer, text, text, text, text, text,
  text, text, date, jsonb, uuid, integer, text,
  uuid, uuid, integer, integer
);

-- Verify: exactly one book_slot_atomic must remain (the 27-arg canonical)
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'book_slot_atomic' AND n.nspname = 'public';

  IF v_count != 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 book_slot_atomic after drop, found %', v_count;
  END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════
-- ACL remediation: restrict canonical 27-arg to service_role only
--
-- The canonical 27-arg book_slot_atomic is a SECURITY DEFINER booking
-- authority. All application callers use createServiceClient() (bot
-- webhook handler, API routes, cron). No browser/authenticated caller
-- exists. However, production ACL shows anon and authenticated have
-- EXECUTE — likely from Supabase ALTER DEFAULT PRIVILEGES granting
-- EXECUTE to PUBLIC on function creation, which individual role grants
-- survive even after REVOKE ALL FROM PUBLIC.
--
-- This explicitly strips anon/authenticated EXECUTE and confirms
-- service_role access. Does NOT modify the function body.
-- ═══════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, integer, integer,
  text, integer, text, text, text, text, text,
  text, text, date, jsonb, uuid, integer, text,
  uuid, uuid, integer, integer, uuid
) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, integer, integer,
  text, integer, text, text, text, text, text,
  text, text, date, jsonb, uuid, integer, text,
  uuid, uuid, integer, integer, uuid
) FROM anon;

REVOKE EXECUTE ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, integer, integer,
  text, integer, text, text, text, text, text,
  text, text, date, jsonb, uuid, integer, text,
  uuid, uuid, integer, integer, uuid
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, integer, integer,
  text, integer, text, text, text, text, text,
  text, text, date, jsonb, uuid, integer, text,
  uuid, uuid, integer, integer, uuid
) TO service_role;
