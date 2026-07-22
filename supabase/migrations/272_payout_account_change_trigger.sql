-- ═══════════════════════════════════════════════════════
-- 272: Auto-hold pending payouts when payout account deactivated
-- When a business replaces their payout account, any pending payouts
-- referencing the old account are moved to 'held' status.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.flag_payouts_on_account_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- When an account is deactivated, hold any pending payouts referencing it
  IF OLD.is_active = true AND NEW.is_active = false THEN
    UPDATE public.business_payouts
    SET status = 'held',
        notes = COALESCE(notes, '') || ' [AUTO-HELD: payout account deactivated at ' || NOW()::text || ']',
        updated_at = NOW()
    WHERE payout_account_id = OLD.id
      AND status = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
