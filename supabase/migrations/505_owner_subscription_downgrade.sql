-- Atomic local owner-requested downgrade. Provider HTTP remains outside SQL.
-- Local downgrade does not assert that provider cancellation was confirmed.
CREATE SCHEMA IF NOT EXISTS subscription_private;
REVOKE ALL ON SCHEMA subscription_private FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA subscription_private TO service_role;

CREATE OR REPLACE FUNCTION subscription_private.complete_owner_subscription_downgrade(
  p_business_id uuid,
  p_actor_id uuid,
  p_operation_id uuid,
  p_expected_business jsonb,
  p_expected_subscriptions jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_business public.businesses%ROWTYPE;
  v_receipt public.subscription_payments%ROWTYPE;
  v_active jsonb;
  v_expected jsonb;
  v_fingerprint text;
  v_reference text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_business_id IS NULL OR p_actor_id IS NULL OR p_operation_id IS NULL
     OR jsonb_typeof(p_expected_business) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_expected_subscriptions) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_expected_subscriptions)>1 THEN
    RAISE EXCEPTION 'invalid_downgrade_request';
  END IF;
  v_reference:='user-downgrade:'||p_actor_id::text||':'||p_operation_id::text;
  v_fingerprint:='state:'||encode(sha256(convert_to(jsonb_build_object(
    'business',p_expected_business,'subscriptions',p_expected_subscriptions)::text,'UTF8')),'hex');

  -- Match existing paid activation/cancellation order: subscription then business.
  -- Lock all this business's existing subscriptions, including inactive rows.
  PERFORM id FROM public.subscriptions WHERE business_id=p_business_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_business FROM public.businesses WHERE id=p_business_id FOR UPDATE;
  IF NOT FOUND OR v_business.owner_id IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'downgrade_not_authorized';
  END IF;

  SELECT * INTO v_receipt FROM public.subscription_payments WHERE id=p_operation_id;
  IF FOUND THEN
    IF v_receipt.business_id IS DISTINCT FROM p_business_id
      OR v_receipt.provider_reference IS DISTINCT FROM v_reference
      OR v_receipt.gateway_reference IS DISTINCT FROM v_fingerprint
      OR v_receipt.gateway IS DISTINCT FROM 'none' OR v_receipt.action IS DISTINCT FROM 'downgrade'
      OR v_receipt.plan IS DISTINCT FROM 'free' OR v_receipt.status IS DISTINCT FROM 'success'
      OR v_receipt.amount IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'downgrade_operation_conflict'; END IF;
    RETURN jsonb_build_object('downgraded',true,'replayed',true,'operation_id',p_operation_id);
  END IF;

  IF v_business.subscription_tier::text IS DISTINCT FROM p_expected_business->>'subscription_tier'
    OR v_business.updated_at IS DISTINCT FROM (p_expected_business->>'updated_at')::timestamptz THEN
    RAISE EXCEPTION 'downgrade_state_changed';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) INTO v_active FROM (
    SELECT id,status,gateway,plan,stripe_subscription_id,paystack_subscription_code,
      paystack_customer_code,metadata,updated_at
    FROM public.subscriptions WHERE business_id=p_business_id AND status='active'
  ) s;
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) INTO v_expected FROM
    jsonb_to_recordset(p_expected_subscriptions) AS s(id uuid,status text,gateway text,plan text,
      stripe_subscription_id text,paystack_subscription_code text,paystack_customer_code text,
      metadata jsonb,updated_at timestamptz);
  IF v_active IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'downgrade_state_changed'; END IF;

  UPDATE public.businesses SET subscription_tier='free',updated_at=v_now WHERE id=p_business_id;
  UPDATE public.subscriptions SET status='cancelled',cancelled_at=v_now,
    cancellation_reason='User-initiated downgrade to Free plan',updated_at=v_now
    WHERE business_id=p_business_id AND status='active';
  INSERT INTO public.subscription_payments(id,business_id,subscription_id,amount,currency,gateway,
    plan,action,status,provider_reference,gateway_reference)
  VALUES(p_operation_id,p_business_id,(v_active->0->>'id')::uuid,0,'NGN','none','free','downgrade',
    'success',v_reference,v_fingerprint);
  RETURN jsonb_build_object('downgraded',true,'replayed',false,'operation_id',p_operation_id);
END;
$$;
REVOKE ALL ON FUNCTION subscription_private.complete_owner_subscription_downgrade(uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION subscription_private.complete_owner_subscription_downgrade(uuid,uuid,uuid,jsonb,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.complete_owner_subscription_downgrade(
 p_business_id uuid,p_actor_id uuid,p_operation_id uuid,p_expected_business jsonb,p_expected_subscriptions jsonb
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 SELECT subscription_private.complete_owner_subscription_downgrade(p_business_id,p_actor_id,p_operation_id,p_expected_business,p_expected_subscriptions);
$$;
REVOKE ALL ON FUNCTION public.complete_owner_subscription_downgrade(uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.complete_owner_subscription_downgrade(uuid,uuid,uuid,jsonb,jsonb) TO service_role;
DO $$
DECLARE f oid; expected_definer boolean;
BEGIN
 FOR f,expected_definer IN SELECT 'public.complete_owner_subscription_downgrade(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure::oid,false UNION ALL SELECT 'subscription_private.complete_owner_subscription_downgrade(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure::oid,true LOOP
  IF NOT (SELECT prosecdef=expected_definer AND proconfig=ARRAY['search_path=""'] AND prorettype='jsonb'::regtype AND prokind='f' FROM pg_proc WHERE oid=f)
    OR has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE')
    OR NOT has_function_privilege('service_role',f,'EXECUTE')
    OR has_function_privilege('service_role',f,'EXECUTE WITH GRANT OPTION')
    OR EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(p.proacl) acl WHERE p.oid=f AND acl.grantee=0 AND acl.privilege_type='EXECUTE') THEN
    RAISE EXCEPTION 'M505 function contract failed';
  END IF;
 END LOOP;
 IF has_schema_privilege('anon','subscription_private','USAGE') OR has_schema_privilege('authenticated','subscription_private','USAGE') OR has_schema_privilege('service_role','subscription_private','CREATE') THEN RAISE EXCEPTION 'M505 private schema contract failed'; END IF;
END $$;
