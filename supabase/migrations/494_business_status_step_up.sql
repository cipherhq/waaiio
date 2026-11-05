-- M494: Add account status step-up; preserve all existing authorization actions.
BEGIN;
ALTER TABLE public.admin_step_up_authorizations
  DROP CONSTRAINT IF EXISTS admin_step_up_authorizations_action_type_check;

ALTER TABLE public.admin_step_up_authorizations
  ADD CONSTRAINT admin_step_up_authorizations_action_type_check
  CHECK (action_type IN (
    'payout_approve',
    'payout_reject',
    'payout_generate',
    'payout_confirm_settlement',
    'payout_force_settle',
    'provider_config',
    'team_grant',
    'team_revoke',
    'impersonate',
    'refund',
    'reseller_payout_approve',
    'reseller_payout_reject',
    'reseller_payout_mark_paid',
    'reseller_payout_generate',
    'commercial_config',
    'messaging_config',
    'messaging_suspension',
    'business_status'
  ));

COMMIT;
