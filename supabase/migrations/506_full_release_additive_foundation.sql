-- 506: Additive dependencies for the full merchant release.
-- This is a separate forward migration, not partial execution of M437/M446.
-- Adds the reviewed form columns and service-only OAuth/swap interface while
-- preserving existing forms and payout_accounts grants/policies. Apply the
-- complete M437/M446 permission contracts after compatible application cutover.
-- Does not invoke a provider, move funds, or update existing business records.
BEGIN;

ALTER TABLE forms
  ADD COLUMN IF NOT EXISTS meta_flow_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS meta_flow_status VARCHAR(20) DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS native_flow_json JSONB;

-- CHECK constraint on meta_flow_status (separate statement for IF NOT EXISTS safety)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'forms_meta_flow_status_check'
      AND conrelid = 'public.forms'::regclass
  ) THEN
    ALTER TABLE forms
      ADD CONSTRAINT forms_meta_flow_status_check
      CHECK (meta_flow_status IN ('draft', 'published', 'deprecated', 'blocked', 'throttled'));
  END IF;
END $$;

-- ── form_responses: native submission columns ──

ALTER TABLE form_responses
  ADD COLUMN IF NOT EXISTS submission_source VARCHAR(10) DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS flow_token_hash VARCHAR(128),
  ADD COLUMN IF NOT EXISTS consent_given BOOLEAN;

-- CHECK constraint on submission_source
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'form_responses_submission_source_check'
      AND conrelid = 'public.form_responses'::regclass
  ) THEN
    ALTER TABLE form_responses
      ADD CONSTRAINT form_responses_submission_source_check
      CHECK (submission_source IN ('web', 'native'));
  END IF;
END $$;

-- ── Unique index for replay prevention ──
-- Only non-null hashes are constrained; web submissions have NULL flow_token_hash.
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_responses_flow_token_hash
  ON form_responses (flow_token_hash)
  WHERE flow_token_hash IS NOT NULL;


CREATE TABLE IF NOT EXISTS public.oauth_connect_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'square')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.oauth_connect_states ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated grants — service_role only
REVOKE ALL ON public.oauth_connect_states FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.oauth_connect_states TO service_role;

-- ══════════════════════════════════════════════════════════════════
-- §5  Replace swap_payout_account with unified signature
-- ══════════════════════════════════════════════════════════════════
-- Drop the M441 8-arg overload to avoid "function is not unique" ambiguity.
-- The new 11-arg version keeps all M441 guarantees (FOR UPDATE lock,
-- business_not_found check, idx_payout_accounts_business_active invariant).

DROP FUNCTION IF EXISTS public.swap_payout_account(uuid, text, text, text, text, text, text, timestamptz);

CREATE OR REPLACE FUNCTION public.swap_payout_account(
  p_business_id        uuid,
  p_gateway            text,
  p_bank_code          text     DEFAULT NULL,
  p_bank_name          text     DEFAULT NULL,
  p_account_number     text     DEFAULT NULL,
  p_account_name       text     DEFAULT NULL,
  p_subaccount_code    text     DEFAULT NULL,
  p_verified_at        timestamptz DEFAULT NULL,
  p_stripe_account_id  text     DEFAULT NULL,
  p_square_merchant_id text     DEFAULT NULL,
  p_square_access_token text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new_id uuid;
BEGIN
  PERFORM 1 FROM businesses WHERE id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'business_not_found: %', p_business_id;
  END IF;

  PERFORM id FROM payout_accounts
    WHERE business_id = p_business_id AND is_active = true
    FOR UPDATE;

  UPDATE payout_accounts
    SET is_active = false, updated_at = now()
    WHERE business_id = p_business_id AND is_active = true;

  INSERT INTO payout_accounts (
    business_id, gateway, subaccount_code,
    bank_code, bank_name, account_number, account_name,
    stripe_account_id, square_merchant_id, square_access_token,
    platform_percentage, is_active, verified_at
  ) VALUES (
    p_business_id, p_gateway, p_subaccount_code,
    p_bank_code, p_bank_name, p_account_number, p_account_name,
    p_stripe_account_id, p_square_merchant_id, p_square_access_token,
    2.5, true, p_verified_at
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

-- Permissions: the old 8-arg overload was dropped above; grant new only
REVOKE ALL ON FUNCTION public.swap_payout_account(uuid, text, text, text, text, text, text, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.swap_payout_account(uuid, text, text, text, text, text, text, timestamptz, text, text, text) TO service_role;


DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.forms'::regclass AND attname='meta_flow_id' AND NOT attisdropped AND format_type(atttypid,atttypmod)='character varying(64)')
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.forms'::regclass AND attname='meta_flow_status' AND NOT attisdropped AND format_type(atttypid,atttypmod)='character varying(20)')
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.forms'::regclass AND attname='native_flow_json' AND NOT attisdropped AND atttypid='jsonb'::regtype)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.form_responses'::regclass AND attname='submission_source' AND NOT attisdropped AND format_type(atttypid,atttypmod)='character varying(10)')
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.form_responses'::regclass AND attname='flow_token_hash' AND NOT attisdropped AND format_type(atttypid,atttypmod)='character varying(128)')
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.form_responses'::regclass AND attname='consent_given' AND NOT attisdropped AND atttypid='boolean'::regtype) THEN
    RAISE EXCEPTION 'M506 form column contract mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.idx_form_responses_flow_token_hash'::regclass AND indisunique AND indisvalid AND indrelid='public.form_responses'::regclass AND indnkeyatts=1 AND indnatts=1 AND indexprs IS NULL AND indkey[0]=(SELECT attnum FROM pg_attribute WHERE attrelid='public.form_responses'::regclass AND attname='flow_token_hash') AND pg_get_expr(indpred,indrelid)='(flow_token_hash IS NOT NULL)') THEN
    RAISE EXCEPTION 'M506 form response index mismatch';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.oauth_connect_states'::regclass)
     OR has_table_privilege('anon','public.oauth_connect_states','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated','public.oauth_connect_states','SELECT,INSERT,UPDATE,DELETE')
     OR NOT has_table_privilege('service_role','public.oauth_connect_states','SELECT')
     OR NOT has_table_privilege('service_role','public.oauth_connect_states','INSERT')
     OR NOT has_table_privilege('service_role','public.oauth_connect_states','UPDATE')
     OR NOT has_table_privilege('service_role','public.oauth_connect_states','DELETE') THEN
    RAISE EXCEPTION 'M506 OAuth authority mismatch';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='swap_payout_account') <> 1
     OR has_function_privilege('anon','public.swap_payout_account(uuid,text,text,text,text,text,text,timestamptz,text,text,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.swap_payout_account(uuid,text,text,text,text,text,text,timestamptz,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.swap_payout_account(uuid,text,text,text,text,text,text,timestamptz,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'M506 swap authority mismatch';
  END IF;
END $$;
DO $shape$
DECLARE actual jsonb;
BEGIN
  SELECT jsonb_build_object(
    'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY c.relname,a.attname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND (c.relname='oauth_connect_states' OR (c.relname='forms' AND a.attname IN ('meta_flow_id','meta_flow_status','native_flow_json')) OR (c.relname='form_responses' AND a.attname IN ('submission_source','flow_token_hash','consent_given')))),
    'constraints',(SELECT jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid),'validated',c.convalidated) ORDER BY c.conrelid::regclass::text,c.conname)
      FROM pg_constraint c WHERE c.conrelid='public.oauth_connect_states'::regclass OR (c.conrelid='public.forms'::regclass AND c.conname='forms_meta_flow_status_check') OR (c.conrelid='public.form_responses'::regclass AND c.conname='form_responses_submission_source_check')))
  INTO actual;
  IF actual IS DISTINCT FROM $expected${"columns":[{"name":"consent_given","type":"boolean","table":"form_responses","default":null,"identity":"","not_null":false,"generated":""},{"name":"flow_token_hash","type":"character varying(128)","table":"form_responses","default":null,"identity":"","not_null":false,"generated":""},{"name":"submission_source","type":"character varying(10)","table":"form_responses","default":"'web'::character varying","identity":"","not_null":false,"generated":""},{"name":"meta_flow_id","type":"character varying(64)","table":"forms","default":null,"identity":"","not_null":false,"generated":""},{"name":"meta_flow_status","type":"character varying(20)","table":"forms","default":"'draft'::character varying","identity":"","not_null":false,"generated":""},{"name":"native_flow_json","type":"jsonb","table":"forms","default":null,"identity":"","not_null":false,"generated":""},{"name":"business_id","type":"uuid","table":"oauth_connect_states","default":null,"identity":"","not_null":true,"generated":""},{"name":"created_at","type":"timestamp with time zone","table":"oauth_connect_states","default":"now()","identity":"","not_null":true,"generated":""},{"name":"expires_at","type":"timestamp with time zone","table":"oauth_connect_states","default":null,"identity":"","not_null":true,"generated":""},{"name":"id","type":"uuid","table":"oauth_connect_states","default":"gen_random_uuid()","identity":"","not_null":true,"generated":""},{"name":"provider","type":"text","table":"oauth_connect_states","default":null,"identity":"","not_null":true,"generated":""},{"name":"state_hash","type":"text","table":"oauth_connect_states","default":null,"identity":"","not_null":true,"generated":""},{"name":"used_at","type":"timestamp with time zone","table":"oauth_connect_states","default":null,"identity":"","not_null":false,"generated":""},{"name":"user_id","type":"uuid","table":"oauth_connect_states","default":null,"identity":"","not_null":true,"generated":""}],"constraints":[{"name":"form_responses_submission_source_check","table":"form_responses","validated":true,"definition":"CHECK (((submission_source)::text = ANY ((ARRAY['web'::character varying, 'native'::character varying])::text[])))"},{"name":"forms_meta_flow_status_check","table":"forms","validated":true,"definition":"CHECK (((meta_flow_status)::text = ANY ((ARRAY['draft'::character varying, 'published'::character varying, 'deprecated'::character varying, 'blocked'::character varying, 'throttled'::character varying])::text[])))"},{"name":"oauth_connect_states_business_id_fkey","table":"oauth_connect_states","validated":true,"definition":"FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE"},{"name":"oauth_connect_states_pkey","table":"oauth_connect_states","validated":true,"definition":"PRIMARY KEY (id)"},{"name":"oauth_connect_states_provider_check","table":"oauth_connect_states","validated":true,"definition":"CHECK ((provider = ANY (ARRAY['stripe'::text, 'square'::text])))"},{"name":"oauth_connect_states_state_hash_key","table":"oauth_connect_states","validated":true,"definition":"UNIQUE (state_hash)"}]}$expected$::jsonb THEN
    RAISE EXCEPTION 'M506 existing structure differs from canonical contract';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.oauth_connect_states'::regclass)
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.oauth_connect_states'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M506 unexpected OAuth policy or trigger';
  END IF;
END $shape$;
COMMIT;
