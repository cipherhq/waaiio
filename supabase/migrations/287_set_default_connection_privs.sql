-- Restrict set_default_connection to service_role
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.set_default_connection(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.set_default_connection(UUID, UUID, TEXT) TO service_role;
END $$;
