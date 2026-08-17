-- 324: Revoke anon/authenticated EXECUTE on payment confirmation lifecycle RPCs
--
-- Problem: Supabase configures ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE TO anon/authenticated
-- for functions created in the public schema. Migration 307 revoked from PUBLIC but that only
-- removes the grant inherited from the PUBLIC pseudo-role — it does NOT remove the direct grants
-- that Supabase's default privileges added to anon and authenticated individually.
--
-- These are SECURITY DEFINER functions that modify payment state (claim, renew, finalize, release).
-- They must only be callable by service_role (server-side via service client).

-- claim_payment_confirmation(uuid)
REVOKE ALL ON FUNCTION public.claim_payment_confirmation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_payment_confirmation(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.claim_payment_confirmation(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_confirmation(UUID) TO service_role;

-- renew_payment_confirmation_claim(uuid, uuid)
REVOKE ALL ON FUNCTION public.renew_payment_confirmation_claim(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.renew_payment_confirmation_claim(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.renew_payment_confirmation_claim(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.renew_payment_confirmation_claim(UUID, UUID) TO service_role;

-- finalize_payment_confirmation(uuid, uuid)
REVOKE ALL ON FUNCTION public.finalize_payment_confirmation(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_payment_confirmation(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_payment_confirmation(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_payment_confirmation(UUID, UUID) TO service_role;

-- release_payment_confirmation(uuid, uuid)
REVOKE ALL ON FUNCTION public.release_payment_confirmation(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_payment_confirmation(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.release_payment_confirmation(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_payment_confirmation(UUID, UUID) TO service_role;
