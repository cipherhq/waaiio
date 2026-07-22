-- Restrict new payment RPCs to service_role only
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.apply_invoice_payment(UUID, UUID, NUMERIC, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.apply_invoice_payment(UUID, UUID, NUMERIC, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT) TO service_role;

  REVOKE ALL ON FUNCTION public.apply_campaign_donation(UUID, UUID, NUMERIC, UUID) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.apply_campaign_donation(UUID, UUID, NUMERIC, UUID) TO service_role;
END $$;
