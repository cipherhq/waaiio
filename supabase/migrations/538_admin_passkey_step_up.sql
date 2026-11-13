-- M538: Admin passkey sign-in and passkey step-up (Owner decision 2026-11-12).
--
-- §1. Two new step-up actions. Approving or removing an admin passkey always
--     needs a fresh authenticator-app code.
-- §2. One passkey tap verifies at most one step-up. A passkey-verified grant
--     stores a challenge_id derived from (session, passkey verification time);
--     TOTP grants keep GoTrue's random challenge ids. Uniqueness makes a reused
--     tap fail atomically, even under concurrent requests.
-- §3. admin_passkey_approvals: passkeys an admin confirmed with an
--     authenticator-app code. The server trusts a passkey session only when
--     every verified passkey on the account is listed here.
--
-- No SECURITY DEFINER functions. Service role only; RLS deny-all.
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
    'passkey_approve','passkey_remove'
  ));

-- §2
CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_step_up_challenge_id
  ON public.admin_step_up_authorizations (challenge_id)
  WHERE challenge_id IS NOT NULL;

-- §3
CREATE TABLE IF NOT EXISTS public.admin_passkey_approvals (
  factor_id      uuid        PRIMARY KEY,
  admin_user_id  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  step_up_id     uuid        NOT NULL REFERENCES public.admin_step_up_authorizations(id),
  approved_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_passkey_approvals_admin
  ON public.admin_passkey_approvals (admin_user_id);

ALTER TABLE public.admin_passkey_approvals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_passkey_approvals_deny_all" ON public.admin_passkey_approvals;
CREATE POLICY "admin_passkey_approvals_deny_all"
  ON public.admin_passkey_approvals
  FOR ALL
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.admin_passkey_approvals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.admin_passkey_approvals TO service_role;

COMMIT;
