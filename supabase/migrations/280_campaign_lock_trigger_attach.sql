-- Attach campaign protection trigger
DO $$ BEGIN
  DROP TRIGGER IF EXISTS trg_protect_campaign_after_donations ON public.campaigns;
  CREATE TRIGGER trg_protect_campaign_after_donations
    BEFORE UPDATE ON public.campaigns
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_campaign_after_donations();
END $$;
