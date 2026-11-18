-- M548: Admin WhatsApp broadcasts (#1104, Owner request 2026-11-17).
--
-- Waaiio messages its own users and account owners with an approved WhatsApp
-- template from the shared Waaiio number. These are platform sends: no
-- merchant messaging credit is reserved or charged.
--
-- §1. Step-up action 'admin_broadcast' added to the cumulative CHECK as last
--     redefined by M547 (every earlier action is kept).
-- §2. admin_broadcasts.request_id: one broadcast per request id, so a retried
--     send returns the first result instead of sending again.
-- §3. admin_broadcast_recipients: one row per recipient per broadcast, written
--     before the send (the unique key stops a second send to the same number)
--     and updated with the outcome. Server only: RLS on with a deny-all policy,
--     no rights for anon or authenticated; service_role may read, insert and
--     update, not delete.
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
    'admin_broadcast'
  ));

-- §2
ALTER TABLE public.admin_broadcasts ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS admin_broadcasts_request_id_key
  ON public.admin_broadcasts (request_id) WHERE request_id IS NOT NULL;

-- §3
CREATE TABLE IF NOT EXISTS public.admin_broadcast_recipients (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: a broadcast with delivery records cannot be deleted (M012 lets a
  -- legacy admin browser session delete admin_broadcasts rows).
  broadcast_id    uuid        NOT NULL REFERENCES public.admin_broadcasts(id) ON DELETE RESTRICT,
  -- Canonical phone: E.164 digits without '+'.
  phone           text        NOT NULL CHECK (phone ~ '^[1-9][0-9]{6,14}$'),
  status          text        NOT NULL CHECK (status IN (
                    'sending', 'sent', 'failed', 'unknown',
                    'skipped_opted_out', 'skipped_suspended', 'skipped_unverified'
                  )),
  meta_message_id text,
  error           text        CHECK (error IS NULL OR char_length(error) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (broadcast_id, phone)
);

ALTER TABLE public.admin_broadcast_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_broadcast_recipients_deny_all" ON public.admin_broadcast_recipients;
CREATE POLICY "admin_broadcast_recipients_deny_all"
  ON public.admin_broadcast_recipients
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- Delivery records are never deleted by the app.
REVOKE ALL ON TABLE public.admin_broadcast_recipients FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.admin_broadcast_recipients TO service_role;

COMMIT;
