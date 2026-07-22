-- Revoke public/anon/authenticated execution of the atomic catalog order function.
-- Only service_role should be able to call this (via the API route).
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.create_catalog_order_atomic(UUID, UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.create_catalog_order_atomic(UUID, UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;
END $$;
