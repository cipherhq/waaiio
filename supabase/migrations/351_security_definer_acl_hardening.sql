-- Migration 351: SECURITY DEFINER ACL Hardening
--
-- Revokes anon/authenticated EXECUTE from 27 server-only SECURITY DEFINER
-- functions unconditionally, plus 1 conditionally (if present).
--
-- P0: Financial/payment state mutation (7 signatures)
-- P1: Admin capability + inventory + booking mutation (12 signatures)
-- P2: Usage/metric counter manipulation (8 signatures, including 2 increment_ai_usage overloads)
-- P3: Trigger helper _is_service_role (conditional — not in repository migrations)
-- Total: 27 unconditional + 1 conditional = 28 max
--
-- All 28 functions are called exclusively from server-side code
-- (service client / cron / webhook handlers / trigger internals).
--
-- Trigger functions that are DIRECTLY invoked by PostgreSQL triggers
-- are intentionally EXCLUDED (they must retain grants for trigger execution).
--
-- release_booking_slot remains authenticated-accessible because it has
-- a legitimate browser caller (dashboard/reservations). This is a known
-- risk requiring a follow-up to route through a server API.

-- ═══════════════════════════════════════════════════════
-- P0: Financial / Payment / Recurring State Authorities
-- ═══════════════════════════════════════════════════════

-- Payment Authority lifecycle (authority.ts via service client)
REVOKE ALL ON FUNCTION public.claim_payment_finalization(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_payment_finalization(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_payment_finalization(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_finalization(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.complete_payment_finalization(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_payment_finalization(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.complete_payment_finalization(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_payment_finalization(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.release_payment_finalization(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_payment_finalization(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.release_payment_finalization(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_payment_finalization(uuid, uuid) TO service_role;

-- Flutterwave recurring charge finalization (flutterwave-renewal.ts via service client)
REVOKE ALL ON FUNCTION public.finalize_token_recurring_charge(text, uuid, numeric, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_token_recurring_charge(text, uuid, numeric, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_token_recurring_charge(text, uuid, numeric, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_token_recurring_charge(text, uuid, numeric, text, text, text) TO service_role;

-- Recurring billing cycle claim (flutterwave-renewal.ts via service client)
REVOKE ALL ON FUNCTION public.claim_recurring_billing_cycle(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_recurring_billing_cycle(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_recurring_billing_cycle(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_recurring_billing_cycle(uuid) TO service_role;

-- Flutterwave definitive failure recording (flutterwave-renewal.ts via service client)
REVOKE ALL ON FUNCTION public.record_flutterwave_definitive_failure(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_flutterwave_definitive_failure(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_flutterwave_definitive_failure(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_flutterwave_definitive_failure(uuid, text) TO service_role;

-- Flutterwave subscription cancellation after failures (cron via service client)
REVOKE ALL ON FUNCTION public.cancel_flutterwave_after_failures(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_flutterwave_after_failures(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_flutterwave_after_failures(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_flutterwave_after_failures(uuid) TO service_role;

-- ═══════════════════════════════════════════════════════
-- P1: Administrative / Capability / Inventory Mutation
-- ═══════════════════════════════════════════════════════

-- Admin capability management (admin API routes via service client)
REVOKE ALL ON FUNCTION public.admin_grant_capability(uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_grant_capability(uuid, text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_grant_capability(uuid, text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_grant_capability(uuid, text, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.admin_revoke_capability(uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_revoke_capability(uuid, text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_revoke_capability(uuid, text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_capability(uuid, text, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.configure_business_capabilities(uuid, text[], integer[], text, timestamptz, text, text[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.configure_business_capabilities(uuid, text[], integer[], text, timestamptz, text, text[], text[]) FROM anon;
REVOKE ALL ON FUNCTION public.configure_business_capabilities(uuid, text[], integer[], text, timestamptz, text, text[], text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.configure_business_capabilities(uuid, text[], integer[], text, timestamptz, text, text[], text[]) TO service_role;

-- Inventory stock manipulation (server-only / no direct app caller)
REVOKE ALL ON FUNCTION public.decrement_stock(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decrement_stock(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.decrement_stock(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.decrement_stock(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.decrement_variant_stock(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decrement_variant_stock(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.decrement_variant_stock(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.decrement_variant_stock(uuid, integer) TO service_role;

-- Low stock alert reset (cron via service client)
REVOKE ALL ON FUNCTION public.reset_low_stock_alerts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_low_stock_alerts() FROM anon;
REVOKE ALL ON FUNCTION public.reset_low_stock_alerts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reset_low_stock_alerts() TO service_role;

-- Ticket purchase (server API route via service client — no auth.uid() check)
REVOKE ALL ON FUNCTION public.purchase_tickets_atomic(uuid, uuid, uuid, integer, uuid, text, text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purchase_tickets_atomic(uuid, uuid, uuid, integer, uuid, text, text, text, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.purchase_tickets_atomic(uuid, uuid, uuid, integer, uuid, text, text, text, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_tickets_atomic(uuid, uuid, uuid, integer, uuid, text, text, text, integer, text) TO service_role;

-- Booking slot reservation (bot flow via service client — caller-controlled capacity)
REVOKE ALL ON FUNCTION public.reserve_booking_slot(uuid, date, time, time, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_booking_slot(uuid, date, time, time, uuid, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_booking_slot(uuid, date, time, time, uuid, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_booking_slot(uuid, date, time, time, uuid, uuid, integer) TO service_role;

-- Booking cancellation (bot handler + API route via service client — no ownership check)
REVOKE ALL ON FUNCTION public.cancel_booking_with_release(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_booking_with_release(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_booking_with_release(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking_with_release(uuid, text) TO service_role;

-- Package session release (no app callers found — defensive hardening)
REVOKE ALL ON FUNCTION public.release_package_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_package_session(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.release_package_session(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_package_session(uuid) TO service_role;

-- Package booking (bot flow via service client)
REVOKE ALL ON FUNCTION public.book_with_package_atomic(uuid, uuid, uuid, uuid, date, text, integer, integer, text, integer, text, text, text, text, text, text, text, date, jsonb, uuid, integer, text, uuid, uuid, integer, integer, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.book_with_package_atomic(uuid, uuid, uuid, uuid, date, text, integer, integer, text, integer, text, text, text, text, text, text, text, date, jsonb, uuid, integer, text, uuid, uuid, integer, integer, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.book_with_package_atomic(uuid, uuid, uuid, uuid, date, text, integer, integer, text, integer, text, text, text, text, text, text, text, date, jsonb, uuid, integer, text, uuid, uuid, integer, integer, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.book_with_package_atomic(uuid, uuid, uuid, uuid, date, text, integer, integer, text, integer, text, text, text, text, text, text, text, date, jsonb, uuid, integer, text, uuid, uuid, integer, integer, uuid, uuid) TO service_role;

-- ═══════════════════════════════════════════════════════
-- P3: Helper functions only called from within SECURITY DEFINER triggers
-- ═══════════════════════════════════════════════════════

-- _is_service_role(): read-only helper called only from enforce_payout_accounts_insert/update.
-- This function exists on staging/production but is NOT defined in repository migrations
-- (it's a Supabase-managed or manually-created function).
-- Conditional REVOKE: only applies if the function exists.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
             WHERE n.nspname = 'public' AND p.proname = '_is_service_role') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public._is_service_role() FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION public._is_service_role() FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public._is_service_role() FROM authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public._is_service_role() TO service_role';
    RAISE NOTICE 'Migration 351: _is_service_role() ACL hardened';
  ELSE
    RAISE NOTICE 'Migration 351: _is_service_role() not found — skipping (not in repository migrations)';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════
-- P2: Usage / Metric Counter Manipulation
-- ═══════════════════════════════════════════════════════

-- Customer visit/spend tracking (server-only bot/webhook callers)
REVOKE ALL ON FUNCTION public.increment_customer_visit(uuid, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_customer_visit(uuid, text, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.increment_customer_visit(uuid, text, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_customer_visit(uuid, text, numeric) TO service_role;

-- AI usage tracking — two overloads (server-only)
REVOKE ALL ON FUNCTION public.increment_ai_usage(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_ai_usage(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.increment_ai_usage(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ai_usage(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.increment_ai_usage(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_ai_usage(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.increment_ai_usage(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ai_usage(uuid, text, text) TO service_role;

-- Broadcast usage tracking (server-only)
REVOKE ALL ON FUNCTION public.increment_broadcast_usage(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_broadcast_usage(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.increment_broadcast_usage(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_broadcast_usage(uuid, integer) TO service_role;

-- Chat forward tracking (server-only)
REVOKE ALL ON FUNCTION public.increment_chat_forwards(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_chat_forwards(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.increment_chat_forwards(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_chat_forwards(uuid) TO service_role;

-- Form response counting (server-only)
REVOKE ALL ON FUNCTION public.increment_form_response_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_form_response_count(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.increment_form_response_count(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_form_response_count(uuid) TO service_role;

-- Message usage tracking (server-only)
REVOKE ALL ON FUNCTION public.increment_message_usage(uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_message_usage(uuid, text, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.increment_message_usage(uuid, text, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_message_usage(uuid, text, boolean) TO service_role;

-- Promo usage tracking (server-only)
REVOKE ALL ON FUNCTION public.increment_promo_usage(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_promo_usage(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.increment_promo_usage(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_promo_usage(uuid) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Verification: inline privilege checks
-- ═══════════════════════════════════════════════════════

DO $$
DECLARE
  v_fn TEXT;
  v_sig TEXT;
  v_anon BOOLEAN;
  v_auth BOOLEAN;
  v_svc BOOLEAN;
  v_errors TEXT[] := '{}';
BEGIN
  -- P0 checks
  FOR v_fn, v_sig IN VALUES
    ('claim_payment_finalization', 'claim_payment_finalization(uuid)'),
    ('complete_payment_finalization', 'complete_payment_finalization(uuid, uuid)'),
    ('release_payment_finalization', 'release_payment_finalization(uuid, uuid)'),
    ('finalize_token_recurring_charge', 'finalize_token_recurring_charge(text, uuid, numeric, text, text, text)'),
    ('claim_recurring_billing_cycle', 'claim_recurring_billing_cycle(uuid)'),
    ('record_flutterwave_definitive_failure', 'record_flutterwave_definitive_failure(uuid, text)'),
    ('cancel_flutterwave_after_failures', 'cancel_flutterwave_after_failures(uuid)')
  LOOP
    v_anon := has_function_privilege('anon', v_sig, 'EXECUTE');
    v_auth := has_function_privilege('authenticated', v_sig, 'EXECUTE');
    v_svc := has_function_privilege('service_role', v_sig, 'EXECUTE');

    IF v_anon THEN v_errors := array_append(v_errors, 'P0 FAIL: anon can execute ' || v_fn); END IF;
    IF v_auth THEN v_errors := array_append(v_errors, 'P0 FAIL: authenticated can execute ' || v_fn); END IF;
    IF NOT v_svc THEN v_errors := array_append(v_errors, 'P0 FAIL: service_role cannot execute ' || v_fn); END IF;
  END LOOP;

  IF array_length(v_errors, 1) > 0 THEN
    RAISE EXCEPTION 'Migration 351 privilege verification failed: %', array_to_string(v_errors, '; ');
  END IF;

  RAISE NOTICE 'Migration 351: All P0 privilege checks passed';
END $$;
