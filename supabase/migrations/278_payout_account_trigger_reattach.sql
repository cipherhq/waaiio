-- Reattach trigger: fires on destination field changes AND is_active changes
DO $$ BEGIN
  DROP TRIGGER IF EXISTS trg_flag_payouts_on_account_change ON public.payout_accounts;
  CREATE TRIGGER trg_flag_payouts_on_account_change
    BEFORE UPDATE ON public.payout_accounts
    FOR EACH ROW
    EXECUTE FUNCTION public.flag_payouts_on_account_change();
END $$;
