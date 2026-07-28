-- Complete Migration 115: add missing properties_updated_at trigger
--
-- Migration 115 created the properties table and related schema.
-- Production verification confirmed 11 of 12 durable schema effects are present.
-- The only missing effect is the properties_updated_at trigger.
--
-- public.update_updated_at() already exists (used by many other tables).
-- This migration creates only the missing trigger.
--
-- Idempotency: checks pg_trigger before creating to avoid duplicate triggers.
-- Fails clearly if the required table or function is missing.
--
-- Does NOT modify historical Migration 115 or any existing data.

DO $$
BEGIN
  -- Verify prerequisites exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = 'properties' AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'Required table public.properties does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'update_updated_at'
  ) THEN
    RAISE EXCEPTION 'Required function public.update_updated_at() does not exist';
  END IF;

  -- Create trigger only if it does not already exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = 'properties' AND t.tgname = 'properties_updated_at'
  ) THEN
    CREATE TRIGGER properties_updated_at
      BEFORE UPDATE ON public.properties
      FOR EACH ROW
      EXECUTE FUNCTION public.update_updated_at();
  END IF;
END
$$;
