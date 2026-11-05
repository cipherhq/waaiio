-- Forward-only notification recovery; historical unknown outcomes remain terminal.
BEGIN;
ALTER TABLE public.merchant_notification_deliveries ADD COLUMN allowance_reserved_month date;
CREATE OR REPLACE FUNCTION public.fence_merchant_notification(p_id uuid,p_claim_token uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE d public.merchant_notification_deliveries; r public.merchant_notification_recipients; src jsonb; tier text; used integer; maximum integer; month_start date:=date_trunc('month',now())::date;
BEGIN
 SELECT * INTO d FROM public.merchant_notification_deliveries WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR d.state<>'claimed' OR d.claim_token IS DISTINCT FROM p_claim_token OR d.lease_until<now() THEN RETURN false; END IF;
 -- Businesses before recipients, the order capture's FK checks use; NO KEY UPDATE never blocks their FOR KEY SHARE.
 IF d.channel='whatsapp' THEN PERFORM 1 FROM public.businesses WHERE id=d.business_id FOR NO KEY UPDATE; END IF;
 -- FOR SHARE: blocks consent changes (revoke/consume/PATCH update the row) during the fence, but never waits behind capture's FOR KEY SHARE.
 SELECT * INTO r FROM public.merchant_notification_recipients WHERE id=d.recipient_id FOR SHARE;
 IF NOT FOUND OR NOT r.enabled OR r.revoked_at IS NOT NULL OR r.verified_at IS DISTINCT FROM d.consent_verified_at OR r.consent_version IS DISTINCT FROM 'merchant-alerts-v1' OR r.address<>d.address OR r.channel<>d.channel OR r.whatsapp_channel_id IS DISTINCT FROM d.whatsapp_channel_id OR NOT d.event=ANY(r.events) THEN
  UPDATE public.merchant_notification_deliveries SET state='suppressed',reason='recipient_changed' WHERE id=d.id; RETURN false;
 END IF;
 EXECUTE format('SELECT to_jsonb(s) FROM public.%I s WHERE id=$1',d.source_table) INTO src USING d.source_id;
 IF src IS NULL OR (d.source_table<>'payments' AND (src->>'business_id')::uuid IS DISTINCT FROM d.business_id) OR src->>'status' IN ('cancelled','refunded','failed','draft','no_show') OR (d.event='payment' AND (src->>'status'<>'success' OR src->>'finalization_completed_at' IS NULL)) THEN
  UPDATE public.merchant_notification_deliveries SET state='suppressed',reason='source_inactive' WHERE id=d.id; RETURN false;
 END IF;
 IF d.channel='whatsapp' THEN
  IF NOT public.reserve_merchant_notification_allowance(d.business_id) THEN UPDATE public.merchant_notification_deliveries SET state='suppressed',reason='monthly_limit' WHERE id=d.id; RETURN false; END IF;
 END IF;
 UPDATE public.merchant_notification_deliveries SET state='dispatched',dispatched_at=now(),lease_until=NULL,allowance_reserved_month=CASE WHEN d.channel='whatsapp' THEN month_start ELSE NULL END WHERE id=d.id;
 RETURN true;
END $$;
CREATE FUNCTION public.recover_merchant_notification_pre_emission(p_id uuid,p_claim_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE d public.merchant_notification_deliveries; current_month date; current_count integer;
BEGIN
 SELECT * INTO d FROM public.merchant_notification_deliveries WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR p_claim_token IS NULL OR d.claim_token IS DISTINCT FROM p_claim_token
   OR d.state<>'dispatched' OR d.channel<>'whatsapp' OR d.allowance_reserved_month IS NULL THEN RETURN false; END IF;
 -- Match the business/config lock order used by allowance reservation.
 PERFORM 1 FROM public.businesses WHERE id=d.business_id FOR NO KEY UPDATE;
 SELECT notify_month_reset,notify_monthly_count INTO current_month,current_count
 FROM public.whatsapp_config WHERE business_id=d.business_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification allowance configuration unavailable'; END IF;
 IF current_month=d.allowance_reserved_month THEN
   IF current_count IS NULL OR current_count<1 THEN RAISE EXCEPTION 'Notification allowance invariant failed'; END IF;
   UPDATE public.whatsapp_config SET notify_monthly_count=notify_monthly_count-1 WHERE business_id=d.business_id;
 END IF;
 UPDATE public.merchant_notification_deliveries
 SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,
     reason='transient_pre_emission',allowance_reserved_month=NULL,dispatched_at=NULL,
     claim_token=NULL,lease_until=NULL,available_at=now()+interval '5 minutes'
 WHERE id=d.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.recover_merchant_notification_pre_emission(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.recover_merchant_notification_pre_emission(uuid,uuid) TO service_role;
DO $verify_merchant_notifications$
DECLARE signature text; function_id oid; definition record; table_name text;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'public.recover_merchant_notification_pre_emission(uuid,uuid)',
  'public.create_merchant_notification_recipient(uuid,text,text,text,text[])',
  'public.issue_merchant_notification_invitation(uuid,uuid,text,uuid)',
  'public.consume_merchant_notification_invitation(text,text,text,uuid)',
  'public.revoke_merchant_notification_whatsapp(text,uuid)',
  'public.capture_merchant_notification()',
  'public.claim_merchant_notification()',
  'public.reserve_merchant_notification_allowance(uuid)',
  'public.fence_merchant_notification(uuid,uuid)',
  'public.finish_merchant_notification(uuid,uuid,text,text,text)'
 ] LOOP
  function_id:=to_regprocedure(signature);
  IF function_id IS NULL THEN RAISE EXCEPTION 'M513 verification FAILED: missing function %',signature; END IF;
  SELECT p.prosecdef,p.proconfig,p.proacl,p.proowner INTO definition FROM pg_proc p WHERE p.oid=function_id;
  IF NOT definition.prosecdef OR NOT COALESCE('search_path=public, extensions'=ANY(definition.proconfig),false) THEN
   RAISE EXCEPTION 'M513 verification FAILED: security/search_path for %',signature;
  END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(COALESCE(definition.proacl,acldefault('f',definition.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
   OR has_function_privilege('anon',function_id,'EXECUTE') OR has_function_privilege('authenticated',function_id,'EXECUTE') THEN
   RAISE EXCEPTION 'M513 verification FAILED: public execution for %',signature;
  END IF;
  IF signature<>'public.capture_merchant_notification()' AND NOT has_function_privilege('service_role',function_id,'EXECUTE') THEN
   RAISE EXCEPTION 'M513 verification FAILED: service execution for %',signature;
  END IF;
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['merchant_notification_recipients','merchant_notification_invitations','merchant_notification_deliveries'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=table_name AND c.relrowsecurity) THEN
   RAISE EXCEPTION 'M513 verification FAILED: RLS for %',table_name;
  END IF;
 END LOOP;
END $verify_merchant_notifications$;
COMMIT;
