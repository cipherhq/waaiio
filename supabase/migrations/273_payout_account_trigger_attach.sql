-- Attach the account-change trigger
DO $$ BEGIN
  DROP TRIGGER IF EXISTS trg_flag_payouts_on_account_change ON public.payout_accounts;
  CREATE TRIGGER trg_flag_payouts_on_account_change
    AFTER UPDATE OF is_active ON public.payout_accounts
    FOR EACH ROW
    EXECUTE FUNCTION public.flag_payouts_on_account_change();
END $$;
