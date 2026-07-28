-- Restrict EXECUTE on 7 SECURITY DEFINER RPCs to service_role only
--
-- Migrations 176/181/182/245 applied REVOKE ALL FROM PUBLIC and GRANT TO
-- service_role for these functions. However, production may still have direct
-- EXECUTE grants to anon and authenticated (from Supabase ALTER DEFAULT
-- PRIVILEGES), which survive REVOKE FROM PUBLIC.
--
-- Application caller audit confirmed all 7 functions are called exclusively
-- from service-role clients (bot flows via webhook handler, cron jobs, API
-- routes using createServiceClient()). None have browser/authenticated callers.
--
-- This migration explicitly revokes direct anon/authenticated grants.
-- It does NOT modify function bodies, owners, SECURITY DEFINER settings,
-- search_path, tables, data, policies or finance logic.
--
-- Idempotency: REVOKE is naturally idempotent in PostgreSQL.
-- Role guards prevent errors in bare PostgreSQL CI environments.

DO $$
BEGIN

  -- ═══════════════════════════════════════════════════════════════════
  -- 1. book_slot_atomic (26 args — Migration 176, cleaned by 245)
  -- ═══════════════════════════════════════════════════════════════════
  REVOKE EXECUTE ON FUNCTION public.book_slot_atomic(
    uuid, uuid, uuid, uuid, date, text, int, int,
    text, int, text, text, text, text, text,
    text, text, date, jsonb, uuid, int, text,
    uuid, uuid, integer, integer
  ) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.book_slot_atomic(
      uuid, uuid, uuid, uuid, date, text, int, int,
      text, int, text, text, text, text, text,
      text, text, date, jsonb, uuid, int, text,
      uuid, uuid, integer, integer
    ) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public.book_slot_atomic(
      uuid, uuid, uuid, uuid, date, text, int, int,
      text, int, text, text, text, text, text,
      text, text, date, jsonb, uuid, int, text,
      uuid, uuid, integer, integer
    ) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.book_slot_atomic(
      uuid, uuid, uuid, uuid, date, text, int, int,
      text, int, text, text, text, text, text,
      text, text, date, jsonb, uuid, int, text,
      uuid, uuid, integer, integer
    ) TO service_role;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════
  -- 2. restore_stock (Migration 173, locked by 181)
  -- ═══════════════════════════════════════════════════════════════════
  REVOKE EXECUTE ON FUNCTION public.restore_stock(uuid, integer) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.restore_stock(uuid, integer) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public.restore_stock(uuid, integer) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.restore_stock(uuid, integer) TO service_role;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════
  -- 3. restore_variant_stock (Migration 173, locked by 181)
  -- ═══════════════════════════════════════════════════════════════════
  REVOKE EXECUTE ON FUNCTION public.restore_variant_stock(uuid, integer) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.restore_variant_stock(uuid, integer) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public.restore_variant_stock(uuid, integer) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.restore_variant_stock(uuid, integer) TO service_role;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════
  -- 4. restore_tickets_sold (Migration 173, locked by 181)
  -- ═══════════════════════════════════════════════════════════════════
  REVOKE EXECUTE ON FUNCTION public.restore_tickets_sold(uuid, integer) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.restore_tickets_sold(uuid, integer) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public.restore_tickets_sold(uuid, integer) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.restore_tickets_sold(uuid, integer) TO service_role;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════
  -- 5. redeem_loyalty_points (Migration 157, locked by 182)
  -- ═══════════════════════════════════════════════════════════════════
  REVOKE EXECUTE ON FUNCTION public.redeem_loyalty_points(uuid, integer) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.redeem_loyalty_points(uuid, integer) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public.redeem_loyalty_points(uuid, integer) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.redeem_loyalty_points(uuid, integer) TO service_role;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════
  -- 6. increment_campaign_donation (Migration 158, locked by 182)
  -- ═══════════════════════════════════════════════════════════════════
  REVOKE EXECUTE ON FUNCTION public.increment_campaign_donation(uuid, numeric, integer) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.increment_campaign_donation(uuid, numeric, integer) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public.increment_campaign_donation(uuid, numeric, integer) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.increment_campaign_donation(uuid, numeric, integer) TO service_role;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════
  -- 7. upsert_customer_profile (Migration 021, locked by 182)
  -- ═══════════════════════════════════════════════════════════════════
  REVOKE EXECUTE ON FUNCTION public.upsert_customer_profile(uuid, text, text, numeric, boolean, boolean) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.upsert_customer_profile(uuid, text, text, numeric, boolean, boolean) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public.upsert_customer_profile(uuid, text, text, numeric, boolean, boolean) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.upsert_customer_profile(uuid, text, text, numeric, boolean, boolean) TO service_role;
  END IF;

END
$$;
