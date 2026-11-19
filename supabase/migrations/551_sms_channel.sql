-- ══════════════════════════════════════════════════════════
-- 551: SMS as a real channel (Owner decisions 2026-11-18, issue #1131)
--
-- Merchant SMS (campaigns, party invites, reminders, failed-charge notices)
-- is charged to the merchant's messaging credit through the existing
-- reserve -> settle path (check_or_authorize_send / settle_message_cost).
-- Admin SMS broadcasts are Waaiio-paid and never reserve merchant credit.
--
-- §1. message_send_attempts.units: SMS pages (1-10). Every other send is 1.
-- §2. authorize_message_send (both overloads): for message_category 'sms'
--     the price per page is ceil(rates[country].sms_cost * 1.2): the
--     BulkSMS cost (VAT included, entered by an admin) plus Waaiio's 20%.
--     There is no fallback to '*' or default_cost_minor, so an unpriced
--     country is refused, never charged a WhatsApp rate. SMS is allowed only
--     for NG and GH businesses, and only to a recipient in the business's
--     own country. The resolved price is multiplied by units; units other
--     than 1 are refused for every other category.
-- §3. _save_messaging_config_impl: 'sms_cost' becomes an allowed rate key,
--     so the admin Countries editor can store it (validated like every
--     other rate: a non-negative integer in minor units).
-- §4. sms_sends: one row per SMS (business or platform), claimed by a unique
--     idempotency key before the provider call, then updated with the
--     outcome. Server only: RLS on with a deny-all policy; service_role may
--     read, insert and update, not delete.
--
-- §2 and §3 rewrite only the named statement in each function, re-created
-- from its live pg_get_functiondef, so schema, SECURITY DEFINER,
-- search_path, owner and ACL are kept (DB-002; same method as M525/M550).
-- The migration fails if a function is missing, if a statement is not found
-- exactly once, or if any attribute differs afterwards. A function that
-- already carries the M551 marker is left alone, so a re-run is a no-op.
--
-- Not changed: WhatsApp pricing, the spend cap, FIFO allowance order,
-- settlement, the financial gate, existing rows (units defaults to 1).
--
-- ROLLBACK: forward-only. A new migration would have to restore the
-- previous statements; units and sms_sends can stay (both inert).
-- ══════════════════════════════════════════════════════════
BEGIN;

-- §1
ALTER TABLE public.message_send_attempts
  ADD COLUMN IF NOT EXISTS units integer NOT NULL DEFAULT 1;
DO $m551_units$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.message_send_attempts'::regclass
                    AND conname = 'message_send_attempts_units_check') THEN
    ALTER TABLE public.message_send_attempts
      ADD CONSTRAINT message_send_attempts_units_check CHECK (units BETWEEN 1 AND 10);
  END IF;
END $m551_units$;

-- §2, §3
DO $m551$
DECLARE
  v_fn RECORD;
  v_oid OID;
  v_count INTEGER;
  v_def TEXT;
  v_new_def TEXT;
  v_before RECORD;
  v_after RECORD;
  v_rewritten INTEGER := 0;
  c_sms_price CONSTANT TEXT := 'v_resolved_cost := NULL;
  /* M551: SMS price per page = ceil(BulkSMS cost incl. VAT * 1.2), NG/GH, same country only (Owner 2026-11-18) */
  IF v_category = ''sms'' THEN
    IF v_country NOT IN (''NG'', ''GH'') OR v_attempt.recipient_country_code IS DISTINCT FROM v_country THEN
      RETURN jsonb_build_object(''authorized'', false, ''reason'', ''sms_country_not_allowed'');
    END IF;
    IF jsonb_typeof(v_currency_bucket -> ''rates'' -> v_country -> ''sms_cost'') = ''number''
       AND (v_currency_bucket -> ''rates'' -> v_country ->> ''sms_cost'')::NUMERIC > 0 THEN
      v_resolved_cost := ceil((v_currency_bucket -> ''rates'' -> v_country ->> ''sms_cost'')::NUMERIC * 1.2)::INTEGER;
    END IF;
  ELSIF v_currency_bucket';
  c_units CONSTANT TEXT := 'RETURN jsonb_build_object(''authorized'', false, ''reason'', ''unresolved_rate'');
  END IF;

  /* M551: SMS units (pages) multiply the price; every other send is exactly 1 unit */
  IF v_attempt.units IS NULL OR v_attempt.units < 1 OR v_attempt.units > 10
     OR (v_category <> ''sms'' AND v_attempt.units <> 1) THEN
    RETURN jsonb_build_object(''authorized'', false, ''reason'', ''invalid_units'');
  END IF;
  v_resolved_cost := v_resolved_cost * v_attempt.units;';
BEGIN
  FOR v_fn IN
    SELECT * FROM (VALUES
      ('public.authorize_message_send(uuid)',
       'v_resolved_cost\s*:=\s*NULL\s*;\s*IF\s+v_currency_bucket', c_sms_price, 'M551: SMS price per page'),
      ('public.authorize_message_send(uuid)',
       'RETURN\s+jsonb_build_object\(''authorized'',\s*false,\s*''reason'',\s*''unresolved_rate''\)\s*;\s*END\s+IF\s*;', c_units, 'M551: SMS units'),
      ('public.authorize_message_send(uuid,uuid,timestamp with time zone)',
       'v_resolved_cost\s*:=\s*NULL\s*;\s*IF\s+v_currency_bucket', c_sms_price, 'M551: SMS price per page'),
      ('public.authorize_message_send(uuid,uuid,timestamp with time zone)',
       'RETURN\s+jsonb_build_object\(''authorized'',\s*false,\s*''reason'',\s*''unresolved_rate''\)\s*;\s*END\s+IF\s*;', c_units, 'M551: SMS units'),
      ('public._save_messaging_config_impl(uuid,jsonb,jsonb,jsonb,uuid,text)',
       'ARRAY\[''\*'',''marketing'',''utility'',''authentication'',''service''\]',
       'ARRAY[''*'',''marketing'',''utility'',''authentication'',''service'',''sms_cost''] /* M551: SMS cost per page */',
       'M551: SMS cost per page')
    ) AS t(sig, pattern, replacement, marker)
  LOOP
    v_oid := to_regprocedure(v_fn.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'M551: % is missing', v_fn.sig;
    END IF;

    -- This statement was rewritten by an earlier run: leave it.
    IF (SELECT prosrc FROM pg_proc WHERE oid = v_oid) LIKE '%' || v_fn.marker || '%' THEN
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_count
      FROM regexp_matches((SELECT prosrc FROM pg_proc WHERE oid = v_oid), v_fn.pattern, 'g');
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'M551: % matches pattern % times, expected exactly 1', v_fn.sig, v_count;
    END IF;

    SELECT pronamespace, prosecdef, proconfig, proowner, proacl::text AS acl
      INTO v_before FROM pg_proc WHERE oid = v_oid;

    v_def := pg_get_functiondef(v_oid);
    v_new_def := regexp_replace(v_def, v_fn.pattern, v_fn.replacement);
    IF v_new_def = v_def THEN
      RAISE EXCEPTION 'M551: % definition did not change', v_fn.sig;
    END IF;
    EXECUTE v_new_def;

    SELECT pronamespace, prosecdef, proconfig, proowner, proacl::text AS acl
      INTO v_after FROM pg_proc WHERE oid = v_oid;
    IF v_after.pronamespace IS DISTINCT FROM v_before.pronamespace
       OR v_after.prosecdef IS DISTINCT FROM v_before.prosecdef
       OR v_after.proconfig IS DISTINCT FROM v_before.proconfig
       OR v_after.proowner IS DISTINCT FROM v_before.proowner
       OR v_after.acl IS DISTINCT FROM v_before.acl THEN
      RAISE EXCEPTION 'M551: % lost an attribute on rewrite', v_fn.sig;
    END IF;

    v_rewritten := v_rewritten + 1;
  END LOOP;

  RAISE NOTICE 'M551: % statement(s) rewritten', v_rewritten;
END $m551$;

-- §4
CREATE TABLE IF NOT EXISTS public.sms_sends (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Claimed before the provider call: a repeated request never sends twice.
  idempotency_key     text        NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  scope               text        NOT NULL CHECK (scope IN ('business', 'platform')),
  business_id         uuid        REFERENCES public.businesses(id) ON DELETE RESTRICT,
  purpose             text        NOT NULL CHECK (purpose IN ('campaign', 'invite', 'reminder', 'notice', 'admin_broadcast')),
  -- Canonical NG/GH phone: E.164 digits without '+'.
  phone               text        NOT NULL CHECK (phone ~ '^(234|233)[0-9]{8,11}$'),
  pages               integer     NOT NULL CHECK (pages BETWEEN 1 AND 10),
  unicode             boolean     NOT NULL,
  -- Business sends only: the reserve -> settle attempt that carries the charge.
  attempt_id          uuid        UNIQUE REFERENCES public.message_send_attempts(id) ON DELETE RESTRICT,
  price_minor         integer     CHECK (price_minor IS NULL OR price_minor >= 0),
  currency_code       text        CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  status              text        NOT NULL CHECK (status IN ('sending', 'accepted', 'failed', 'unknown')),
  provider_message_id text        CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 200),
  provider_cost       numeric     CHECK (provider_cost IS NULL OR provider_cost >= 0),
  provider_pages      integer     CHECK (provider_pages IS NULL OR provider_pages >= 0),
  error               text        CHECK (error IS NULL OR char_length(error) <= 500),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_sends_scope_shape_check CHECK (
    (scope = 'business' AND business_id IS NOT NULL AND purpose <> 'admin_broadcast')
    OR (scope = 'platform' AND business_id IS NULL AND attempt_id IS NULL AND purpose = 'admin_broadcast')
  )
);

CREATE INDEX IF NOT EXISTS idx_sms_sends_business ON public.sms_sends (business_id, created_at DESC)
  WHERE business_id IS NOT NULL;

ALTER TABLE public.sms_sends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sms_sends_deny_all" ON public.sms_sends;
CREATE POLICY "sms_sends_deny_all"
  ON public.sms_sends
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- Send records are never deleted by the app.
REVOKE ALL ON TABLE public.sms_sends FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.sms_sends TO service_role;

-- ── Verification ──
DO $$
DECLARE
  v_sig TEXT;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.authorize_message_send(uuid)',
    'public.authorize_message_send(uuid,uuid,timestamp with time zone)'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure(v_sig)
                    AND prosrc LIKE '%M551: SMS price per page%'
                    AND prosrc LIKE '%M551: SMS units%' AND prosecdef) THEN
      RAISE EXCEPTION 'M551: % does not carry the SMS pricing statements', v_sig;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
       OR has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'M551: % must not be executable by anon/authenticated', v_sig;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = to_regprocedure('public._save_messaging_config_impl(uuid,jsonb,jsonb,jsonb,uuid,text)')
                    AND prosrc LIKE '%M551: SMS cost per page%') THEN
    RAISE EXCEPTION 'M551: _save_messaging_config_impl does not allow sms_cost';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sms_sends'::regclass) THEN
    RAISE EXCEPTION 'M551: RLS is not enabled on sms_sends';
  END IF;
  IF has_table_privilege('anon', 'public.sms_sends', 'SELECT')
     OR has_table_privilege('authenticated', 'public.sms_sends', 'SELECT') THEN
    RAISE EXCEPTION 'M551: sms_sends must not be readable by anon/authenticated';
  END IF;

  RAISE NOTICE 'M551: SMS channel verified';
END $$;

COMMIT;
