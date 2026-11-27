-- M559: Customer blocking also covers email (#1166 r7, Owner approval
-- 2026-11-27; builds on M547 / #1103).
--
-- §1. customer_email_blocks: one row per blocked email, stored trimmed and
--     lower-cased, unique. It records who blocked it, when, why (3–500
--     characters) and, when known, the canonical phone of the customer it was
--     blocked with. The phone is plain text with no foreign key to
--     customer_suspensions, so unblocking (deleting) the phone row never
--     touches an email block (Owner Q6 B). Unblock deletes the row; the
--     history lives in admin_audit_logs. Server only: RLS on with a deny-all
--     policy, no rights for anon or authenticated (DB-003), as M547.
-- §2. bookings.email_verified_at: nullable timestamp of the one-time email
--     code proof on web bookings and ticket purchases (S1b). Only the service
--     role may set or change it: a trigger rejects a real change by any other
--     database role (business owners can update their own bookings under the
--     existing RLS, and a column REVOKE would not override their table-level
--     UPDATE grant). The check uses the database role (current_user), not
--     request claims, and ignores rows where the value does not change, so
--     owners' ordinary updates and the booking RPCs (which leave it NULL)
--     keep working. The trigger function is SECURITY INVOKER with an empty
--     search_path and no API-role EXECUTE.
-- §3. svc_set_customer_block(): blocks or unblocks a phone and any number of
--     emails in one transaction, with one admin_audit_logs row per changed
--     item keyed on that row's id. SECURITY INVOKER (no SECURITY DEFINER, so
--     DB-001/DB-002/DB-006 do not apply); only service_role may EXECUTE it.
--     svc_set_customer_suspension (M547) is not changed and keeps its grants.
--
-- No step-up CHECK change: 'customer_suspension' is already in the final
-- list (M553). No existing row, policy, grant or function changes.
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS, and the
-- same grants each run. Ends with a self-check that raises on any drift.
-- Must be applied before the app code that reads these objects is deployed.
BEGIN;

-- §1
CREATE TABLE IF NOT EXISTS public.customer_email_blocks (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text        NOT NULL UNIQUE
    CONSTRAINT customer_email_blocks_email_normalized CHECK (email = lower(btrim(email)))
    CONSTRAINT customer_email_blocks_email_format CHECK (char_length(email) <= 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  phone       text
    CONSTRAINT customer_email_blocks_phone_format CHECK (phone IS NULL OR phone ~ '^[1-9][0-9]{6,14}$'),
  reason      text        NOT NULL
    CONSTRAINT customer_email_blocks_reason_length CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  blocked_by  uuid        NOT NULL,
  blocked_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_email_blocks_phone
  ON public.customer_email_blocks (phone) WHERE phone IS NOT NULL;

ALTER TABLE public.customer_email_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_email_blocks_deny_all" ON public.customer_email_blocks;
CREATE POLICY "customer_email_blocks_deny_all"
  ON public.customer_email_blocks
  FOR ALL
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.customer_email_blocks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_email_blocks TO service_role;

-- §2
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.bookings_email_verified_at_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.email_verified_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.email_verified_at IS NOT DISTINCT FROM OLD.email_verified_at THEN
    RETURN NEW;
  END IF;
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'email_verified_at is set by the server only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.bookings_email_verified_at_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS bookings_email_verified_at_guard ON public.bookings;
CREATE TRIGGER bookings_email_verified_at_guard
  BEFORE INSERT OR UPDATE OF email_verified_at ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION private.bookings_email_verified_at_guard();

-- §3
-- p_phone_action: 'block', 'unblock' or NULL (leave the phone as it is; the
-- phone, when given, is still recorded on newly blocked emails).
-- p_block_emails / p_unblock_emails: emails to block / unblock; trimmed,
-- lower-cased and de-duplicated here. An email may not be in both lists.
-- Blocking needs a reason (3–500 characters); unblocking does not.
CREATE OR REPLACE FUNCTION public.svc_set_customer_block(
  p_actor_id uuid,
  p_phone text,
  p_phone_action text,
  p_block_emails text[],
  p_unblock_emails text[],
  p_reason text,
  p_ip text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_block text[];
  v_unblock text[];
  v_reason text := NULLIF(btrim(coalesce(p_reason, '')), '');
  v_email text;
  v_phone_row public.customer_suspensions%ROWTYPE;
  v_email_row public.customer_email_blocks%ROWTYPE;
  v_phone_result jsonb := NULL;
  v_email_results jsonb := '[]'::jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'actor is required';
  END IF;
  IF p_phone_action IS NOT NULL AND p_phone_action NOT IN ('block', 'unblock') THEN
    RAISE EXCEPTION 'phone action must be block, unblock or null';
  END IF;
  IF p_phone_action IS NOT NULL AND p_phone IS NULL THEN
    RAISE EXCEPTION 'phone is required for a phone action';
  END IF;

  SELECT coalesce(array_agg(DISTINCT lower(btrim(e)) ORDER BY lower(btrim(e))), '{}')
    INTO v_block FROM unnest(coalesce(p_block_emails, '{}')) AS e WHERE e IS NOT NULL;
  SELECT coalesce(array_agg(DISTINCT lower(btrim(e)) ORDER BY lower(btrim(e))), '{}')
    INTO v_unblock FROM unnest(coalesce(p_unblock_emails, '{}')) AS e WHERE e IS NOT NULL;

  IF p_phone_action IS NULL AND cardinality(v_block) = 0 AND cardinality(v_unblock) = 0 THEN
    RAISE EXCEPTION 'nothing to change';
  END IF;
  IF v_block && v_unblock THEN
    RAISE EXCEPTION 'an email cannot be blocked and unblocked at once';
  END IF;
  IF (p_phone_action = 'block' OR cardinality(v_block) > 0) AND v_reason IS NULL THEN
    RAISE EXCEPTION 'reason is required to block';
  END IF;

  -- Phone (same rows and audit entries as svc_set_customer_suspension).
  IF p_phone_action = 'block' THEN
    INSERT INTO public.customer_suspensions (phone, reason, suspended_by)
    VALUES (p_phone, v_reason, p_actor_id)
    ON CONFLICT (phone) DO NOTHING
    RETURNING * INTO v_phone_row;
  ELSIF p_phone_action = 'unblock' THEN
    DELETE FROM public.customer_suspensions WHERE phone = p_phone RETURNING * INTO v_phone_row;
  END IF;
  IF p_phone_action IS NOT NULL THEN
    IF v_phone_row.id IS NULL THEN
      v_phone_result := jsonb_build_object('changed', false, 'suspended', p_phone_action = 'block');
    ELSE
      INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, details, ip_address)
      VALUES (
        p_actor_id,
        CASE WHEN p_phone_action = 'block' THEN 'suspend_customer' ELSE 'unsuspend_customer' END,
        'customer_suspension',
        v_phone_row.id,
        jsonb_build_object('phone', p_phone, 'reason', v_reason,
          'suspended_at', v_phone_row.suspended_at, 'suspended_by', v_phone_row.suspended_by),
        left(p_ip, 45)
      );
      v_phone_result := jsonb_build_object('changed', true, 'suspended', p_phone_action = 'block', 'id', v_phone_row.id);
    END IF;
  END IF;

  -- Emails to block.
  FOREACH v_email IN ARRAY v_block LOOP
    INSERT INTO public.customer_email_blocks (email, phone, reason, blocked_by)
    VALUES (v_email, p_phone, v_reason, p_actor_id)
    ON CONFLICT (email) DO NOTHING
    RETURNING * INTO v_email_row;
    IF v_email_row.id IS NULL THEN
      v_email_results := v_email_results || jsonb_build_object('email', v_email, 'changed', false, 'blocked', true);
    ELSE
      INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, details, ip_address)
      VALUES (p_actor_id, 'block_customer_email', 'customer_email_block', v_email_row.id,
        jsonb_build_object('email', v_email, 'phone', v_email_row.phone, 'reason', v_reason,
          'blocked_at', v_email_row.blocked_at, 'blocked_by', v_email_row.blocked_by),
        left(p_ip, 45));
      v_email_results := v_email_results || jsonb_build_object('email', v_email, 'changed', true, 'blocked', true, 'id', v_email_row.id);
    END IF;
  END LOOP;

  -- Emails to unblock.
  FOREACH v_email IN ARRAY v_unblock LOOP
    DELETE FROM public.customer_email_blocks WHERE email = v_email RETURNING * INTO v_email_row;
    IF v_email_row.id IS NULL THEN
      v_email_results := v_email_results || jsonb_build_object('email', v_email, 'changed', false, 'blocked', false);
    ELSE
      INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, details, ip_address)
      VALUES (p_actor_id, 'unblock_customer_email', 'customer_email_block', v_email_row.id,
        jsonb_build_object('email', v_email, 'phone', v_email_row.phone, 'reason', v_reason,
          'blocked_at', v_email_row.blocked_at, 'blocked_by', v_email_row.blocked_by),
        left(p_ip, 45));
      v_email_results := v_email_results || jsonb_build_object('email', v_email, 'changed', true, 'blocked', false, 'id', v_email_row.id);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('phone', v_phone_result, 'emails', v_email_results);
END;
$$;

REVOKE ALL ON FUNCTION public.svc_set_customer_block(uuid, text, text, text[], text[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_set_customer_block(uuid, text, text, text[], text[], text, text) TO service_role;

-- Self-check
DO $$
DECLARE
  r text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.customer_email_blocks'::regclass) THEN
    RAISE EXCEPTION 'M559: RLS is off on customer_email_blocks';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customer_email_blocks'
             AND policyname <> 'customer_email_blocks_deny_all') THEN
    RAISE EXCEPTION 'M559: unexpected policy on customer_email_blocks';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.customer_email_blocks', 'SELECT')
       OR has_table_privilege(r, 'public.customer_email_blocks', 'INSERT')
       OR has_table_privilege(r, 'public.customer_email_blocks', 'UPDATE')
       OR has_table_privilege(r, 'public.customer_email_blocks', 'DELETE')
       OR has_table_privilege(r, 'public.customer_email_blocks', 'TRUNCATE') THEN
      RAISE EXCEPTION 'M559: % has rights on customer_email_blocks', r;
    END IF;
    IF has_function_privilege(r, 'public.svc_set_customer_block(uuid, text, text, text[], text[], text, text)', 'EXECUTE')
       OR has_function_privilege(r, 'private.bookings_email_verified_at_guard()', 'EXECUTE') THEN
      RAISE EXCEPTION 'M559: % can execute a M559 function', r;
    END IF;
  END LOOP;
  IF NOT (has_table_privilege('service_role', 'public.customer_email_blocks', 'SELECT')
          AND has_table_privilege('service_role', 'public.customer_email_blocks', 'INSERT')
          AND has_table_privilege('service_role', 'public.customer_email_blocks', 'DELETE')
          AND has_function_privilege('service_role', 'public.svc_set_customer_block(uuid, text, text, text[], text[], text, text)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'M559: service_role lost access';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.svc_set_customer_block(uuid, text, text, text[], text[], text, text)'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'private.bookings_email_verified_at_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'M559: a M559 function is SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.bookings'::regclass
                 AND tgname = 'bookings_email_verified_at_guard' AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'M559: bookings_email_verified_at_guard trigger missing or disabled';
  END IF;
END $$;

COMMIT;
