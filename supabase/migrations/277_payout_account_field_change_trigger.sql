-- ═══════════════════════════════════════════════════════
-- 277: Expanded payout account change trigger
-- Fires on ANY destination field change (not just is_active).
-- Clears verification and holds pending/approved payouts.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.flag_payouts_on_account_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dest_changed BOOLEAN := false;
BEGIN
  -- Check if any destination field changed
  IF (OLD.account_number IS DISTINCT FROM NEW.account_number)
    OR (OLD.bank_code IS DISTINCT FROM NEW.bank_code)
    OR (OLD.routing_number IS DISTINCT FROM NEW.routing_number)
    OR (OLD.iban IS DISTINCT FROM NEW.iban)
    OR (OLD.swift_code IS DISTINCT FROM NEW.swift_code)
    OR (OLD.subaccount_code IS DISTINCT FROM NEW.subaccount_code)
    OR (OLD.stripe_account_id IS DISTINCT FROM NEW.stripe_account_id)
    OR (OLD.square_merchant_id IS DISTINCT FROM NEW.square_merchant_id)
  THEN
    v_dest_changed := true;
  END IF;

  -- On destination field change: clear verification, deactivate, hold payouts
  IF v_dest_changed THEN
    NEW.verified_at := NULL;
    NEW.is_active := false;

    UPDATE public.business_payouts
    SET status = 'held',
        notes = COALESCE(notes, '') || ' [AUTO-HELD: payout account destination changed at ' || NOW()::text || ']',
        updated_at = NOW()
    WHERE payout_account_id = OLD.id
      AND status IN ('pending', 'approved');
  END IF;

  -- On explicit deactivation (without destination change): hold pending payouts
  IF NOT v_dest_changed AND OLD.is_active = true AND NEW.is_active = false THEN
    UPDATE public.business_payouts
    SET status = 'held',
        notes = COALESCE(notes, '') || ' [AUTO-HELD: payout account deactivated at ' || NOW()::text || ']',
        updated_at = NOW()
    WHERE payout_account_id = OLD.id
      AND status IN ('pending', 'approved');
  END IF;

  RETURN NEW;
END;
$$;
