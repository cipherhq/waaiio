-- ═══════════════════════════════════════════════════════
-- 250: Consolidated function privileges
-- ═══════════════════════════════════════════════════════
-- Supabase CLI's migration runner rejects multi-statement files
-- (CREATE FUNCTION + REVOKE/GRANT). All function privilege grants
-- are consolidated here as single-statement executions.
--
-- Each DO block is one statement — safe for prepared-statement mode.

DO $$ BEGIN
  -- book_slot_atomic: 26-param version (from migration 176, the only production version)
  REVOKE ALL ON FUNCTION public.book_slot_atomic(
    uuid, uuid, uuid, uuid, date, text, int, int,
    text, int, text, text, text, text, text,
    text, text, date, jsonb, uuid, int, text,
    uuid, uuid, integer, integer
  ) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.book_slot_atomic(
    uuid, uuid, uuid, uuid, date, text, int, int,
    text, int, text, text, text, text, text,
    text, text, date, jsonb, uuid, int, text,
    uuid, uuid, integer, integer
  ) TO service_role;

  -- restore_stock / restore_variant_stock / restore_tickets_sold (from 181)
  REVOKE ALL ON FUNCTION public.restore_stock(uuid, integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.restore_stock(uuid, integer) TO service_role;
  REVOKE ALL ON FUNCTION public.restore_variant_stock(uuid, integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.restore_variant_stock(uuid, integer) TO service_role;
  REVOKE ALL ON FUNCTION public.restore_tickets_sold(uuid, integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.restore_tickets_sold(uuid, integer) TO service_role;

  -- process_recurring_charge (from 233)
  REVOKE ALL ON FUNCTION public.process_recurring_charge FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.process_recurring_charge TO service_role;

  -- update_session_cas (from 236)
  REVOKE ALL ON FUNCTION public.update_session_cas(UUID, BIGINT, TEXT, JSONB, JSONB, TEXT[]) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.update_session_cas(UUID, BIGINT, TEXT, JSONB, JSONB, TEXT[]) TO service_role;

  -- reserve_credits_atomic / consume_credits_atomic (from 242)
  REVOKE ALL ON FUNCTION public.reserve_credits_atomic(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.reserve_credits_atomic(UUID, UUID, INTEGER) TO service_role;
  REVOKE ALL ON FUNCTION public.consume_credits_atomic(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.consume_credits_atomic(UUID, UUID, INTEGER) TO service_role;

  -- release_credits_atomic (from 243)
  REVOKE ALL ON FUNCTION public.release_credits_atomic(UUID, UUID) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.release_credits_atomic(UUID, UUID) TO service_role;

  -- deduct_package_session (from 247, 248)
  REVOKE ALL ON FUNCTION public.deduct_package_session(UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.deduct_package_session(UUID, TEXT, UUID, UUID) TO service_role;

  -- create_payout_with_adjustments (from 248)
  REVOKE ALL ON FUNCTION public.create_payout_with_adjustments(UUID, DATE, DATE, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, UUID, JSONB, UUID[]) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.create_payout_with_adjustments(UUID, DATE, DATE, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, UUID, JSONB, UUID[]) TO service_role;

  -- create_invoice_with_items (from 248)
  REVOKE ALL ON FUNCTION public.create_invoice_with_items(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.create_invoice_with_items(JSONB, JSONB) TO service_role;

  -- recover_expired_reservations (from 243)
  REVOKE ALL ON FUNCTION public.recover_expired_reservations() FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.recover_expired_reservations() TO service_role;
END $$;
