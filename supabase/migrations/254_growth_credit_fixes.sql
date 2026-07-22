-- Separate blocks so exception handling is scoped correctly.
DO $fix1$ BEGIN
  DROP POLICY IF EXISTS "customer_consents_service_insert" ON public.customer_consents;
END $fix1$;

DO $fix2$ BEGIN
  ALTER TABLE public.growth_campaigns
    ADD CONSTRAINT uq_growth_campaign_dedup UNIQUE (business_id, name, type)
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL;
END $fix2$;
