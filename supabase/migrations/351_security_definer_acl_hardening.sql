-- Migration 351: SECURITY DEFINER ACL Hardening
--
-- Revokes anon/authenticated EXECUTE from 22 server-only SECURITY DEFINER
-- functions that were incorrectly exposed via Supabase default privileges.
--
-- P0: Financial/payment state mutation (7 functions)
-- P1: Admin capability + inventory mutation (6 functions)
-- P2: Usage/metric counter manipulation (9 functions, 1 has 2 overloads = 10 signatures)
--
-- All 22 functions are called exclusively from server-side code
-- (service client / cron / webhook handlers). Zero browser callers.
--
-- Trigger functions, dashboard-facing RPCs, and public-facing RPCs
-- are intentionally EXCLUDED from this hardening.

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
