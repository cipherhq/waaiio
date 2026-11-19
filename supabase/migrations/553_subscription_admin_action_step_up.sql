-- M553: Step-up action for admin subscription money actions (Owner decisions 2026-11-18).
--
-- POST /api/admin/subscriptions (stop a Waaiio plan's renewal, extend a Free
-- business's feature trial) and POST /api/admin/recurring (pause, resume,
-- cancel or retry a merchant customer's recurring payment) consume a
-- single-use step-up bound to the action, target and every confirmed field.
--
-- §1. Step-up action 'subscription_admin_action' added to the cumulative CHECK
--     as last redefined by M548 (every earlier action is kept). No other change:
--     no table, column, function, grant or RLS policy.
BEGIN;

-- §1
ALTER TABLE public.admin_step_up_authorizations
  DROP CONSTRAINT IF EXISTS admin_step_up_authorizations_action_type_check;
ALTER TABLE public.admin_step_up_authorizations
  ADD CONSTRAINT admin_step_up_authorizations_action_type_check
  CHECK (action_type IN (
    'payout_approve','payout_reject','payout_generate',
    'payout_confirm_settlement','payout_force_settle',
    'provider_config','team_grant','team_revoke','impersonate','refund',
    'reseller_payout_approve','reseller_payout_reject',
    'reseller_payout_mark_paid','reseller_payout_generate',
    'commercial_config','messaging_config','messaging_suspension',
    'business_status','channel_change_execute',
    'passkey_approve','passkey_remove',
    'customer_suspension',
    'admin_broadcast',
    'subscription_admin_action'
  ));

COMMIT;
