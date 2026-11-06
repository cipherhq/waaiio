-- ═══════════════════════════════════════════════════════
-- Migration 523: align businesses_public and whatsapp_channels_public with
-- Supabase security_invoker guidance (Security Advisor lint 0010)
--
-- Why: M293 created both views without security_invoker, so they run with the
-- view owner's rights. Supabase's Security Advisor flags every such view in
-- an API schema. The views are the intended read path for public business
-- pages (anon) and for shared WhatsApp numbers (signed-in merchants):
-- anon has no grant on either base table, and signed-in users can read only
-- their own dedicated channel and their own businesses there. Switching the
-- views to security_invoker by itself would therefore break those pages.
--
-- What it changes:
--   * new schema public_view_private (not exposed through the Data API).
--     anon, authenticated and service_role get USAGE only; PUBLIC gets nothing;
--   * two read-only SECURITY DEFINER SQL functions in that schema,
--     businesses_public_rows() and whatsapp_channels_public_rows(), each with
--     search_path = '' and fully qualified names. They return exactly the
--     columns and rows the views return today (same column list, same
--     status = 'active' / shared + active filters). EXECUTE: anon,
--     authenticated, service_role and pg_read_all_data (whose members could
--     read the views before); revoked from PUBLIC. Bodies are BEGIN ATOMIC so
--     PostgreSQL keeps refusing to drop or retype a base-table column they
--     use, as it did for the M293 views;
--   * both views are replaced in place (same name, columns, types, order
--     and grants) to read from those functions, with
--     security_invoker = true and security_barrier = true.
--
-- What does not change: which columns and rows any role can read through
-- the views; no base-table grant, RLS policy or app code changes. View
-- grants are set exactly to SELECT for anon, authenticated and service_role,
-- which is what each already has in production for reading (an unused
-- MAINTAIN bit on the views is dropped).
--
-- Compatible with the live app: callers use lib/supabase/safe-view-query.ts,
-- which reads the views by name with the same columns and filters.
--
-- Rollback (Owner-authorized only): restore the M293 view bodies with
-- CREATE OR REPLACE VIEW ... WITH (security_barrier = true) and
-- ALTER VIEW ... RESET (security_invoker), then drop schema
-- public_view_private CASCADE.
--
-- Rule for the new schema: every function added later must REVOKE EXECUTE
-- FROM PUBLIC (PostgreSQL's built-in default grants it, and anon has USAGE).
-- This migration's self-check refuses any PUBLIC-executable function there.
--
-- Idempotent: a re-run replaces the same objects and passes the self-check.
-- No BEGIN/COMMIT: applied as one whole-file statement.
-- ═══════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS public_view_private;
REVOKE ALL ON SCHEMA public_view_private FROM PUBLIC;
GRANT USAGE ON SCHEMA public_view_private TO anon, authenticated, service_role;
COMMENT ON SCHEMA public_view_private IS
  'Read-only helpers behind public security_invoker views (M523). Not exposed through the Data API. Every function here must REVOKE EXECUTE FROM PUBLIC.';

-- ── businesses ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public_view_private.businesses_public_rows()
RETURNS TABLE (
  id uuid,
  name varchar,
  slug varchar,
  description text,
  address text,
  city varchar,
  state varchar,
  country_code varchar,
  phone varchar,
  email varchar,
  logo_url text,
  cover_photo_url text,
  category public.business_category,
  flow_type public.flow_type,
  operating_hours jsonb,
  rating_avg numeric,
  rating_count integer,
  total_bookings integer,
  instagram_handle varchar,
  timezone varchar,
  recurring_enabled boolean,
  bot_code varchar,
  status public.restaurant_status,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
BEGIN ATOMIC
  SELECT
    b.id, b.name, b.slug, b.description, b.address, b.city, b.state,
    b.country_code, b.phone, b.email, b.logo_url, b.cover_photo_url,
    b.category, b.flow_type, b.operating_hours, b.rating_avg, b.rating_count,
    b.total_bookings, b.instagram_handle, b.timezone, b.recurring_enabled,
    b.bot_code, b.status, b.created_at, b.updated_at
  FROM public.businesses b
  WHERE b.status = 'active'::public.restaurant_status;
END;

REVOKE ALL ON FUNCTION public_view_private.businesses_public_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_view_private.businesses_public_rows() TO anon, authenticated, service_role, pg_read_all_data;

-- Casts keep each view column's exact type (function results drop length limits).
CREATE OR REPLACE VIEW public.businesses_public
  WITH (security_barrier = true, security_invoker = true) AS
SELECT
  r.id,
  r.name::varchar(200) AS name,
  r.slug::varchar(200) AS slug,
  r.description,
  r.address,
  r.city::varchar(50) AS city,
  r.state::varchar(100) AS state,
  r.country_code::varchar(2) AS country_code,
  r.phone::varchar(20) AS phone,
  r.email::varchar(255) AS email,
  r.logo_url,
  r.cover_photo_url,
  r.category,
  r.flow_type,
  r.operating_hours,
  r.rating_avg::numeric(2,1) AS rating_avg,
  r.rating_count,
  r.total_bookings,
  r.instagram_handle::varchar(100) AS instagram_handle,
  r.timezone::varchar(50) AS timezone,
  r.recurring_enabled,
  r.bot_code::varchar(30) AS bot_code,
  r.status,
  r.created_at,
  r.updated_at
FROM public_view_private.businesses_public_rows() r;

-- ── whatsapp_channels ───────────────────────────────────

CREATE OR REPLACE FUNCTION public_view_private.whatsapp_channels_public_rows()
RETURNS TABLE (
  id uuid,
  country_code varchar,
  phone_number varchar,
  display_name varchar,
  channel_type varchar,
  is_active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
BEGIN ATOMIC
  SELECT c.id, c.country_code, c.phone_number, c.display_name, c.channel_type, c.is_active
  FROM public.whatsapp_channels c
  WHERE c.channel_type::text = 'shared' AND c.is_active = true;
END;

REVOKE ALL ON FUNCTION public_view_private.whatsapp_channels_public_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_view_private.whatsapp_channels_public_rows() TO anon, authenticated, service_role, pg_read_all_data;

CREATE OR REPLACE VIEW public.whatsapp_channels_public
  WITH (security_barrier = true, security_invoker = true) AS
SELECT
  r.id,
  r.country_code::varchar(2) AS country_code,
  r.phone_number::varchar(20) AS phone_number,
  r.display_name::varchar(128) AS display_name,
  r.channel_type::varchar(10) AS channel_type,
  r.is_active
FROM public_view_private.whatsapp_channels_public_rows() r;

-- Exact view grants (as M519/M520): SELECT only, for the three API roles.
-- Production's service_role SELECT came from Supabase default privileges
-- (M293 alone did not give it); the MAINTAIN bit PostgreSQL 17 added there
-- has no use on a view. Stating the grants makes production, staging and the
-- catalog oracle end in the same state.
REVOKE ALL ON public.businesses_public, public.whatsapp_channels_public FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.businesses_public, public.whatsapp_channels_public TO anon, authenticated, service_role;

-- ── self-check (final state) ────────────────────────────

DO $$
DECLARE
  v_view text;
  v_fn regprocedure;
  v_role text;
  v_opts text[];
BEGIN
  FOREACH v_view IN ARRAY ARRAY['public.businesses_public', 'public.whatsapp_channels_public'] LOOP
    SELECT c.reloptions INTO v_opts FROM pg_class c WHERE c.oid = v_view::regclass;
    IF NOT ('security_invoker=true' = ANY(v_opts) AND 'security_barrier=true' = ANY(v_opts)) THEN
      RAISE EXCEPTION 'M523 self-check: % options are %', v_view, v_opts;
    END IF;
    IF has_table_privilege('anon', v_view, 'INSERT') OR has_table_privilege('anon', v_view, 'UPDATE')
       OR has_table_privilege('anon', v_view, 'DELETE') THEN
      RAISE EXCEPTION 'M523 self-check: anon can write %', v_view;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT has_table_privilege(v_role, v_view, 'SELECT') THEN
        RAISE EXCEPTION 'M523 self-check: % lost SELECT on %', v_role, v_view;
      END IF;
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = v_view::regclass
        AND (a.grantee = 0 OR a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role'))
        AND a.privilege_type <> 'SELECT'
    ) THEN
      RAISE EXCEPTION 'M523 self-check: % has API-role grants other than SELECT', v_view;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    'public_view_private.businesses_public_rows()'::regprocedure,
    'public_view_private.whatsapp_channels_public_rows()'::regprocedure
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = v_fn AND p.prosecdef AND p.provolatile = 's'
        AND p.proconfig = ARRAY['search_path=""']
    ) THEN
      RAISE EXCEPTION 'M523 self-check: % is not SECURITY DEFINER STABLE with search_path ''''', v_fn;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'pg_read_all_data'] LOOP
      IF NOT has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'M523 self-check: % cannot execute %', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;

  -- No function in the schema may be executable by PUBLIC.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public_view_private'
      AND (p.proacl IS NULL OR EXISTS (
        SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'M523 self-check: a function in public_view_private is executable by PUBLIC';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT has_schema_privilege(v_role, 'public_view_private', 'USAGE') THEN
      RAISE EXCEPTION 'M523 self-check: % lacks USAGE on public_view_private', v_role;
    END IF;
  END LOOP;

  IF has_schema_privilege('anon', 'public_view_private', 'CREATE')
     OR has_schema_privilege('authenticated', 'public_view_private', 'CREATE') THEN
    RAISE EXCEPTION 'M523 self-check: anon/authenticated can create objects in public_view_private';
  END IF;

  -- The base tables stay closed to anon (M293).
  IF has_any_column_privilege('anon', 'public.businesses', 'SELECT')
     OR has_any_column_privilege('anon', 'public.whatsapp_channels', 'SELECT') THEN
    RAISE EXCEPTION 'M523 self-check: anon can read a base table directly';
  END IF;
END $$;
