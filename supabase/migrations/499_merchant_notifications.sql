-- #811. Future-only merchant alerts. No financial state mutations or historical fanout.
BEGIN;
CREATE TABLE public.merchant_notification_recipients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80), channel text NOT NULL CHECK(channel IN ('email','whatsapp')),
 address text NOT NULL CHECK(length(address) BETWEEN 3 AND 254), events text[] NOT NULL CHECK(cardinality(events)>0 AND events <@ ARRAY['sale','payment','appointment','booking']::text[]),
 enabled boolean NOT NULL DEFAULT true, verified_at timestamptz, revoked_at timestamptz, stopped_at timestamptz,
 whatsapp_channel_id uuid REFERENCES public.whatsapp_channels(id), consent_version text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((channel='email' AND address=lower(address) AND position('@' IN address)>1) OR (channel='whatsapp' AND address ~ '^\+[1-9][0-9]{7,14}$')),
 CHECK (verified_at IS NULL OR (consent_version IS NOT NULL AND (channel='email' OR whatsapp_channel_id IS NOT NULL)))
);
CREATE UNIQUE INDEX merchant_notification_destination ON public.merchant_notification_recipients(business_id,channel,address) WHERE revoked_at IS NULL;
CREATE TABLE public.merchant_notification_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), recipient_id uuid NOT NULL REFERENCES public.merchant_notification_recipients(id) ON DELETE CASCADE,
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE,
 channel text NOT NULL, address text NOT NULL, whatsapp_channel_id uuid REFERENCES public.whatsapp_channels(id),
 expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merchant_notification_invites_recipient ON public.merchant_notification_invitations(recipient_id,created_at DESC);
CREATE TABLE public.merchant_notification_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 recipient_id uuid NOT NULL REFERENCES public.merchant_notification_recipients(id) ON DELETE CASCADE,
 channel text NOT NULL, address text NOT NULL, whatsapp_channel_id uuid, consent_verified_at timestamptz NOT NULL,
 event text NOT NULL CHECK(event IN ('sale','payment','appointment','booking')), source_table text NOT NULL CHECK(source_table IN ('orders','bookings','reservations','payments')),
 source_id uuid NOT NULL, payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','dispatched','accepted','unknown','failed','suppressed')),
 claim_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 provider_id text, reason text, dispatched_at timestamptz, accepted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_table,source_id,event,recipient_id,channel)
);
CREATE INDEX merchant_notification_pending ON public.merchant_notification_deliveries(available_at,created_at) WHERE state IN ('pending','claimed');
ALTER TABLE public.merchant_notification_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchant_notification_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchant_notification_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.merchant_notification_recipients,public.merchant_notification_invitations,public.merchant_notification_deliveries FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.merchant_notification_recipients,public.merchant_notification_deliveries TO authenticated;
GRANT ALL ON public.merchant_notification_recipients,public.merchant_notification_invitations,public.merchant_notification_deliveries TO service_role;
CREATE POLICY merchant_recipient_owner_read ON public.merchant_notification_recipients FOR SELECT TO authenticated USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id=(SELECT auth.uid())));
CREATE POLICY merchant_delivery_owner_read ON public.merchant_notification_deliveries FOR SELECT TO authenticated USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id=(SELECT auth.uid())));

CREATE FUNCTION public.create_merchant_notification_recipient(p_business_id uuid,p_label text,p_channel text,p_address text,p_events text[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE r public.merchant_notification_recipients;
BEGIN
 PERFORM 1 FROM public.businesses WHERE id=p_business_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('created',false,'reason','business_not_found'); END IF;
 IF (SELECT count(*) FROM public.merchant_notification_recipients WHERE business_id=p_business_id AND revoked_at IS NULL)>=20 THEN RETURN jsonb_build_object('created',false,'reason','recipient_limit'); END IF;
 IF EXISTS(SELECT 1 FROM public.merchant_notification_recipients WHERE business_id=p_business_id AND channel=p_channel AND address=p_address AND revoked_at IS NULL) THEN RETURN jsonb_build_object('created',false,'reason','duplicate'); END IF;
 INSERT INTO public.merchant_notification_recipients(business_id,label,channel,address,events) VALUES(p_business_id,p_label,p_channel,p_address,p_events) RETURNING * INTO r;
 RETURN jsonb_build_object('created',true,'recipient',to_jsonb(r));
END $$;
CREATE FUNCTION public.issue_merchant_notification_invitation(p_recipient_id uuid,p_business_id uuid,p_token_hash text,p_channel_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE r public.merchant_notification_recipients; expiry timestamptz := now()+interval '30 minutes';
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
CREATE FUNCTION public.consume_merchant_notification_invitation(p_token_hash text,p_channel text,p_address text DEFAULT NULL,p_channel_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE i public.merchant_notification_invitations; r public.merchant_notification_recipients;
BEGIN
 -- Recipient first: same lock order as issue/revoke, preventing cross-operation deadlocks.
 SELECT * INTO i FROM public.merchant_notification_invitations WHERE token_hash=p_token_hash;
 IF NOT FOUND THEN RETURN jsonb_build_object('verified',false); END IF;
 PERFORM 1 FROM public.merchant_notification_recipients WHERE business_id=i.business_id AND channel=i.channel AND address=i.address ORDER BY id FOR UPDATE;
 SELECT * INTO r FROM public.merchant_notification_recipients WHERE id=i.recipient_id FOR UPDATE;
 SELECT * INTO i FROM public.merchant_notification_invitations WHERE id=i.id FOR UPDATE;
 IF NOT r.enabled OR r.revoked_at IS NOT NULL OR r.business_id<>i.business_id OR r.address<>i.address OR r.channel<>i.channel OR p_channel IS DISTINCT FROM i.channel
 OR (i.channel='whatsapp' AND (p_address IS DISTINCT FROM i.address OR p_channel_id IS DISTINCT FROM i.whatsapp_channel_id)) THEN RETURN jsonb_build_object('verified',false); END IF;
 IF i.consumed_at IS NOT NULL THEN RETURN jsonb_build_object('verified',r.verified_at IS NOT NULL AND r.consent_version='merchant-alerts-v1' AND (i.channel='email' OR r.whatsapp_channel_id=i.whatsapp_channel_id),'recipient_id',r.id,'replay',true); END IF;
 IF i.expires_at<=now() THEN RETURN jsonb_build_object('verified',false); END IF;
 UPDATE public.merchant_notification_recipients SET stopped_at=NULL WHERE business_id=r.business_id AND channel=r.channel AND address=r.address;
 UPDATE public.merchant_notification_recipients SET verified_at=clock_timestamp(),consent_version='merchant-alerts-v1',whatsapp_channel_id=i.whatsapp_channel_id WHERE id=r.id;
 UPDATE public.merchant_notification_invitations SET consumed_at=now() WHERE id=i.id;
 RETURN jsonb_build_object('verified',true,'recipient_id',r.id,'replay',false);
END $$;
CREATE FUNCTION public.revoke_merchant_notification_whatsapp(p_address text,p_channel_id uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE ids uuid[]; affected integer;
BEGIN
 SELECT array_agg(id) INTO ids FROM (SELECT id FROM public.merchant_notification_recipients WHERE channel='whatsapp' AND address=p_address AND (whatsapp_channel_id=p_channel_id OR EXISTS(SELECT 1 FROM public.merchant_notification_invitations i WHERE i.recipient_id=merchant_notification_recipients.id AND i.channel='whatsapp' AND i.address=p_address AND i.whatsapp_channel_id=p_channel_id AND i.consumed_at IS NULL AND i.expires_at>now())) ORDER BY id FOR UPDATE) locked;
 UPDATE public.merchant_notification_recipients SET enabled=false,verified_at=NULL,consent_version=NULL,stopped_at=now() WHERE id=ANY(ids);
 GET DIAGNOSTICS affected=ROW_COUNT;
 UPDATE public.merchant_notification_invitations SET expires_at=now() WHERE recipient_id=ANY(ids) AND consumed_at IS NULL;
 RETURN affected;
END $$;

-- Source classification stays separate from payment finalization and never mutates sources.
CREATE FUNCTION public.capture_merchant_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE n jsonb:=to_jsonb(NEW); o jsonb; biz uuid; linked uuid; kind text; source text; key text; target text; title text; detail text; is_class boolean;
BEGIN
 IF TG_OP='UPDATE' THEN o:=to_jsonb(OLD); ELSE o:='{}'::jsonb; END IF;
 IF TG_TABLE_NAME='payments' THEN
  IF n->>'status'<>'success' OR n->>'finalization_completed_at' IS NULL OR o->>'finalization_completed_at' IS NOT NULL THEN RETURN NEW; END IF;
  -- Canonical foreign keys only. Conflicting source tenant bindings fail closed for alerts.
  FOREACH source IN ARRAY ARRAY['booking','order','reservation','invoice','campaign'] LOOP
   key:=source||'_id'; target:=source||'s';
   IF n->>key IS NOT NULL THEN
    EXECUTE format('SELECT business_id FROM public.%I WHERE id=$1',target) INTO linked USING (n->>key)::uuid;
    IF linked IS NULL OR (biz IS NOT NULL AND biz<>linked) THEN RETURN NEW; END IF;
    biz:=linked;
   END IF;
  END LOOP;
  IF biz IS NULL THEN RETURN NEW; END IF;
  kind:='payment'; title:='Payment received'; detail:='Payment confirmed. View your dashboard for details.';
 ELSE
  biz:=(n->>'business_id')::uuid;
  IF TG_TABLE_NAME='orders' THEN
   IF n->>'status' NOT IN ('confirmed','paid_pending_approval') OR o->>'status' IN ('confirmed','paid_pending_approval') THEN RETURN NEW; END IF;
   kind:='sale'; title:='Order received'; detail:=CASE WHEN n->>'status'='paid_pending_approval' THEN 'Merchant approval required. Review this order in your dashboard.' ELSE 'A new order is ready to review. Check payment status in your dashboard.' END;
  ELSE
   IF n->>'status'<>'confirmed' OR o->>'status'='confirmed' THEN RETURN NEW; END IF;
   IF TG_TABLE_NAME='bookings' AND n->>'flow_type'='payment' THEN RETURN NEW; END IF;
   IF TG_TABLE_NAME='bookings' THEN SELECT s.is_class INTO is_class FROM public.services s WHERE s.id=(n->>'service_id')::uuid AND s.business_id=biz; END IF;
   kind:=CASE WHEN TG_TABLE_NAME='bookings' AND COALESCE(n->>'flow_type','scheduling')='scheduling' AND NOT COALESCE(is_class,false) THEN 'appointment' ELSE 'booking' END;
   title:=CASE WHEN kind='appointment' THEN 'Appointment confirmed' ELSE 'Booking confirmed' END;
   detail:='View your dashboard for the schedule and customer details.';
  END IF;
 END IF;
 INSERT INTO public.merchant_notification_deliveries(business_id,recipient_id,channel,address,whatsapp_channel_id,consent_verified_at,event,source_table,source_id,payload)
 SELECT biz,r.id,r.channel,r.address,r.whatsapp_channel_id,r.verified_at,kind,TG_TABLE_NAME,(n->>'id')::uuid,jsonb_build_object('title',title,'reference',COALESCE(n->>'reference_code',n->>'gateway_reference',n->>'id'),'detail',detail)
 FROM public.merchant_notification_recipients r WHERE r.business_id=biz AND r.enabled AND r.revoked_at IS NULL AND r.verified_at IS NOT NULL AND r.consent_version='merchant-alerts-v1' AND kind=ANY(r.events)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER merchant_order_alert AFTER INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.capture_merchant_notification();
CREATE TRIGGER merchant_booking_alert AFTER INSERT OR UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.capture_merchant_notification();
CREATE TRIGGER merchant_reservation_alert AFTER INSERT OR UPDATE ON public.reservations FOR EACH ROW EXECUTE FUNCTION public.capture_merchant_notification();
CREATE TRIGGER merchant_payment_alert AFTER INSERT OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.capture_merchant_notification();

CREATE FUNCTION public.claim_merchant_notification() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE d public.merchant_notification_deliveries;
BEGIN
 UPDATE public.merchant_notification_deliveries SET state='failed',reason='preflight_attempts_exhausted',lease_until=NULL WHERE state='claimed' AND lease_until<now() AND attempts>=5;
 SELECT * INTO d FROM public.merchant_notification_deliveries WHERE (state='pending' OR (state='claimed' AND lease_until<now())) AND available_at<=now() AND attempts<5 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE public.merchant_notification_deliveries SET state='claimed',claim_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',attempts=attempts+1 WHERE id=d.id RETURNING * INTO d;
 RETURN to_jsonb(d);
END $$;
-- Shares the existing monthly allowance with legacy notifications; serializes every recipient.
CREATE FUNCTION public.reserve_merchant_notification_allowance(p_business_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE tier text; used integer; reset_date date; month_start date:=date_trunc('month',now())::date; maximum integer;
BEGIN
 SELECT subscription_tier::text INTO tier FROM public.businesses WHERE id=p_business_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 maximum:=CASE WHEN tier IN ('growth','business') THEN 999999 ELSE 50 END;
 INSERT INTO public.whatsapp_config(business_id) VALUES(p_business_id) ON CONFLICT(business_id) DO NOTHING;
 SELECT notify_monthly_count,notify_month_reset INTO used,reset_date FROM public.whatsapp_config WHERE business_id=p_business_id FOR UPDATE;
 IF reset_date IS NULL OR reset_date<month_start THEN used:=0; END IF;
 IF used>=maximum THEN RETURN false; END IF;
 UPDATE public.whatsapp_config SET notify_monthly_count=used+1,notify_month_reset=month_start WHERE business_id=p_business_id;
 RETURN true;
END $$;
CREATE FUNCTION public.fence_merchant_notification(p_id uuid,p_claim_token uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE d public.merchant_notification_deliveries; r public.merchant_notification_recipients; src jsonb; tier text; used integer; maximum integer; month_start date:=date_trunc('month',now())::date;
BEGIN
 SELECT * INTO d FROM public.merchant_notification_deliveries WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR d.state<>'claimed' OR d.claim_token IS DISTINCT FROM p_claim_token OR d.lease_until<now() THEN RETURN false; END IF;
 SELECT * INTO r FROM public.merchant_notification_recipients WHERE id=d.recipient_id FOR UPDATE;
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
 UPDATE public.merchant_notification_deliveries SET state='dispatched',dispatched_at=now(),lease_until=NULL WHERE id=d.id;
 RETURN true;
END $$;
CREATE FUNCTION public.finish_merchant_notification(p_id uuid,p_claim_token uuid,p_state text,p_provider_id text DEFAULT NULL,p_reason text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
BEGIN
 IF p_state NOT IN ('accepted','unknown','failed','pending') OR (p_state='accepted' AND NULLIF(p_provider_id,'') IS NULL) THEN RETURN false; END IF;
 UPDATE public.merchant_notification_deliveries SET state=CASE WHEN p_state='pending' AND attempts>=5 THEN 'failed' ELSE p_state END,provider_id=p_provider_id,reason=left(p_reason,120),accepted_at=CASE WHEN p_state='accepted' THEN now() END,available_at=now()+interval '5 minutes',lease_until=NULL
 WHERE id=p_id AND claim_token=p_claim_token AND ((state='dispatched' AND p_state IN ('accepted','unknown','failed')) OR (state='claimed' AND p_state IN ('pending','failed')));
 RETURN FOUND;
END $$;
-- Explicit allowlist for every new privileged function; trigger function is not a public API.
REVOKE ALL ON FUNCTION public.capture_merchant_notification() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.create_merchant_notification_recipient(uuid,text,text,text,text[]),public.issue_merchant_notification_invitation(uuid,uuid,text,uuid),public.consume_merchant_notification_invitation(text,text,text,uuid),public.revoke_merchant_notification_whatsapp(text,uuid),public.claim_merchant_notification(),public.reserve_merchant_notification_allowance(uuid),public.fence_merchant_notification(uuid,uuid),public.finish_merchant_notification(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_merchant_notification_recipient(uuid,text,text,text,text[]),public.issue_merchant_notification_invitation(uuid,uuid,text,uuid),public.consume_merchant_notification_invitation(text,text,text,uuid),public.revoke_merchant_notification_whatsapp(text,uuid),public.claim_merchant_notification(),public.reserve_merchant_notification_allowance(uuid),public.fence_merchant_notification(uuid,uuid),public.finish_merchant_notification(uuid,uuid,text,text,text) TO service_role;
-- Verify the final catalog state before committing any migration changes.
DO $verify_merchant_notifications$
DECLARE signature text; function_id oid; definition record; table_name text;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
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
  IF function_id IS NULL THEN RAISE EXCEPTION 'M499 verification FAILED: missing function %',signature; END IF;
  SELECT p.prosecdef,p.proconfig,p.proacl,p.proowner INTO definition FROM pg_proc p WHERE p.oid=function_id;
  IF NOT definition.prosecdef OR NOT COALESCE('search_path=public, extensions'=ANY(definition.proconfig),false) THEN
   RAISE EXCEPTION 'M499 verification FAILED: security/search_path for %',signature;
  END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(COALESCE(definition.proacl,acldefault('f',definition.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
   OR has_function_privilege('anon',function_id,'EXECUTE') OR has_function_privilege('authenticated',function_id,'EXECUTE') THEN
   RAISE EXCEPTION 'M499 verification FAILED: public execution for %',signature;
  END IF;
  IF signature<>'public.capture_merchant_notification()' AND NOT has_function_privilege('service_role',function_id,'EXECUTE') THEN
   RAISE EXCEPTION 'M499 verification FAILED: service execution for %',signature;
  END IF;
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['merchant_notification_recipients','merchant_notification_invitations','merchant_notification_deliveries'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=table_name AND c.relrowsecurity) THEN
   RAISE EXCEPTION 'M499 verification FAILED: RLS for %',table_name;
  END IF;
 END LOOP;
END $verify_merchant_notifications$;
COMMIT;
