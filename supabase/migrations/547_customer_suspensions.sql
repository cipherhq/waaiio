-- M547: Platform-wide customer suspension (#1103, Owner decision 2026-11-17).
--
-- A suspended customer's WhatsApp number is blocked from every Waaiio bot at
-- every business, and marketing sends skip it. Payments, refunds, payouts and
-- settlement are untouched.
--
-- §1. customer_suspensions: one row per suspended number, keyed on the
--     canonical phone (E.164 digits without '+', the form Meta sends as
--     msg.from). Unsuspend deletes the row; the history lives in
--     admin_audit_logs. Server only: RLS on with a deny-all policy, no rights
--     for anon or authenticated.
-- §2. Step-up action 'customer_suspension' added to the cumulative CHECK as
--     last redefined by M538 (every earlier action is kept).
-- §3. svc_set_customer_suspension(): suspend or unsuspend and write the audit
--     row in one transaction. SECURITY INVOKER (no SECURITY DEFINER), so it
--     runs with the caller's rights; only service_role may EXECUTE it.
BEGIN;

-- §1
CREATE TABLE IF NOT EXISTS public.customer_suspensions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone            text        NOT NULL UNIQUE CHECK (phone ~ '^[1-9][0-9]{6,14}$'),
  reason           text        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  suspended_by     uuid        NOT NULL,
  suspended_at     timestamptz NOT NULL DEFAULT now(),
  -- When the customer was last sent the neutral "not available" reply.
  last_notified_at timestamptz
);

ALTER TABLE public.customer_suspensions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_suspensions_deny_all" ON public.customer_suspensions;
CREATE POLICY "customer_suspensions_deny_all"
  ON public.customer_suspensions
  FOR ALL
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.customer_suspensions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_suspensions TO service_role;

-- §2
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
    'customer_suspension'
  ));

-- §3
CREATE OR REPLACE FUNCTION public.svc_set_customer_suspension(
  p_actor_id uuid, p_phone text, p_suspend boolean, p_reason text, p_ip text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.customer_suspensions%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL OR p_phone IS NULL OR p_suspend IS NULL THEN
    RAISE EXCEPTION 'actor, phone and suspend are required';
  END IF;

  IF p_suspend THEN
    INSERT INTO public.customer_suspensions (phone, reason, suspended_by)
    VALUES (p_phone, btrim(p_reason), p_actor_id)
    ON CONFLICT (phone) DO NOTHING
    RETURNING * INTO v_row;
    IF v_row.id IS NULL THEN
      RETURN jsonb_build_object('changed', false, 'suspended', true);
    END IF;
  ELSE
    DELETE FROM public.customer_suspensions WHERE phone = p_phone RETURNING * INTO v_row;
    IF v_row.id IS NULL THEN
      RETURN jsonb_build_object('changed', false, 'suspended', false);
    END IF;
  END IF;

  INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, details, ip_address)
  VALUES (
    p_actor_id,
    CASE WHEN p_suspend THEN 'suspend_customer' ELSE 'unsuspend_customer' END,
    'customer_suspension',
    v_row.id,
    jsonb_build_object('phone', p_phone, 'reason', NULLIF(btrim(coalesce(p_reason, '')), ''),
      'suspended_at', v_row.suspended_at, 'suspended_by', v_row.suspended_by),
    left(p_ip, 45)
  );

  RETURN jsonb_build_object('changed', true, 'suspended', p_suspend, 'id', v_row.id);
END;
$$;

REVOKE ALL ON FUNCTION public.svc_set_customer_suspension(uuid, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_set_customer_suspension(uuid, text, boolean, text, text) TO service_role;

COMMIT;
