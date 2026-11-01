-- Owner-approved 48-hour lifetime for NEW email and WhatsApp invitations (#811 / PR #813).
-- M499 has already been applied in staging: preserve migration history.
-- Existing invitation timestamps are deliberately unchanged, including expired/replaced tokens.
-- Only issuance expiry changes; token binding, throttling, replacement and consumption stay intact.
BEGIN;
CREATE OR REPLACE FUNCTION public.issue_merchant_notification_invitation(p_recipient_id uuid,p_business_id uuid,p_token_hash text,p_channel_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE r public.merchant_notification_recipients; expiry timestamptz := now()+interval '48 hours';
BEGIN
 SELECT * INTO r FROM public.merchant_notification_recipients WHERE id=p_recipient_id AND business_id=p_business_id FOR UPDATE;
 IF NOT FOUND OR NOT r.enabled OR r.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('issued',false,'reason','unavailable'); END IF;
 IF length(p_token_hash)<>64 THEN RAISE EXCEPTION 'Invalid token hash'; END IF;
 IF r.channel='whatsapp' AND NOT EXISTS(SELECT 1 FROM public.whatsapp_channels WHERE id=p_channel_id AND is_active AND (channel_type='shared' OR business_id=p_business_id OR id=(SELECT whatsapp_channel_id FROM public.businesses WHERE id=p_business_id))) THEN RETURN jsonb_build_object('issued',false,'reason','channel_unavailable'); END IF;
 IF EXISTS(SELECT 1 FROM public.merchant_notification_invitations WHERE recipient_id=r.id AND created_at>now()-interval '60 seconds') THEN RETURN jsonb_build_object('issued',false,'reason','rate_limited'); END IF;
 UPDATE public.merchant_notification_invitations SET expires_at=now() WHERE recipient_id=r.id AND consumed_at IS NULL;
 INSERT INTO public.merchant_notification_invitations(recipient_id,business_id,token_hash,channel,address,whatsapp_channel_id,expires_at) VALUES(r.id,r.business_id,p_token_hash,r.channel,r.address,CASE WHEN r.channel='whatsapp' THEN p_channel_id END,expiry);
 RETURN jsonb_build_object('issued',true,'expires_at',expiry);
END $$;

REVOKE ALL ON FUNCTION public.issue_merchant_notification_invitation(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.issue_merchant_notification_invitation(uuid,uuid,text,uuid) TO service_role;
DO $verify_invitation_lifetime$
DECLARE function_id oid := to_regprocedure('public.issue_merchant_notification_invitation(uuid,uuid,text,uuid)'); definition record;
BEGIN
 IF function_id IS NULL THEN RAISE EXCEPTION 'M502 verification FAILED: missing function'; END IF;
 SELECT p.prosecdef,p.proconfig,p.proacl,p.proowner,p.prosrc INTO definition FROM pg_proc p WHERE p.oid=function_id;
 IF NOT definition.prosecdef OR NOT COALESCE('search_path=public, extensions'=ANY(definition.proconfig),false) THEN
  RAISE EXCEPTION 'M502 verification FAILED: security/search_path';
 END IF;
 IF EXISTS(SELECT 1 FROM aclexplode(COALESCE(definition.proacl,acldefault('f',definition.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
  OR has_function_privilege('anon',function_id,'EXECUTE') OR has_function_privilege('authenticated',function_id,'EXECUTE') THEN
  RAISE EXCEPTION 'M502 verification FAILED: public execution';
 END IF;
 IF NOT has_function_privilege('service_role',function_id,'EXECUTE') THEN
  RAISE EXCEPTION 'M502 verification FAILED: service execution';
 END IF;
 IF position('interval ''48 hours''' IN definition.prosrc)=0 THEN
  RAISE EXCEPTION 'M502 verification FAILED: invitation lifetime';
 END IF;
END $verify_invitation_lifetime$;
COMMIT;
