-- M481: bounded Event save, final cancellation, issuance and delivery authority.
-- No provider/financial execution. New objects use service-only invoker entry points.
BEGIN;
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO service_role;

CREATE TABLE public.event_mutation_operations (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('admin','merchant')),
  request_payload jsonb NOT NULL,
  response_payload jsonb NOT NULL DEFAULT '{}',
  is_cancellation boolean NOT NULL DEFAULT false,
  affected_ticket_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX event_one_cancellation ON public.event_mutation_operations(event_id) WHERE is_cancellation;
CREATE TABLE public.event_cancellation_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES public.event_mutation_operations(id) ON DELETE RESTRICT,
  recipient_phone text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','attempted','accepted','failed','ambiguous')),
  claim_token uuid,
  claim_expires_at timestamptz,
  attempted_at timestamptz,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(operation_id,recipient_phone)
);
CREATE TABLE public.event_cancelled_payment_followups (
  operation_id uuid NOT NULL REFERENCES public.event_mutation_operations(id) ON DELETE RESTRICT,
  -- Deliberately no payment FK: cancellation holds event, never a payment lock.
  -- Identity is checked from payments/bookings in the service-only functions.
  payment_id uuid NOT NULL,
  alert_id uuid NOT NULL REFERENCES public.alerts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(operation_id,payment_id)
);
CREATE TABLE public.event_ticket_issuance_state (
  booking_id uuid PRIMARY KEY REFERENCES public.bookings(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  ticket_type_id uuid REFERENCES public.event_ticket_types(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK(quantity > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.event_ticket_emissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK(channel IN ('whatsapp','email','webhook')),
  emission_key text NOT NULL CHECK(length(emission_key) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'attempted' CHECK(state IN ('attempted','accepted','failed','ambiguous')),
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(booking_id,channel,emission_key)
);

CREATE FUNCTION private.event_finality_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status::text = 'cancelled' AND NEW.status::text <> 'cancelled' THEN
    RAISE EXCEPTION 'event_cancellation_final' USING ERRCODE='23514';
  END IF;
  -- Run after the legacy update_events_updated_at trigger; every committed save
  -- receives a strictly increasing revision even inside one transaction.
  NEW.updated_at:=GREATEST(clock_timestamp(),OLD.updated_at+interval '1 microsecond');
  RETURN NEW;
END $$;
CREATE TRIGGER zz_event_cancellation_is_final BEFORE UPDATE ON public.events
FOR EACH ROW EXECUTE FUNCTION private.event_finality_guard();

-- Caller holds the event (or payment) authority. No payment row is locked here.
CREATE FUNCTION private.record_event_cancelled_payment_followup(p_operation_id uuid,p_payment_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_op public.event_mutation_operations%ROWTYPE; v_alert uuid;
BEGIN
  SELECT * INTO v_op FROM public.event_mutation_operations WHERE id=p_operation_id AND is_cancellation;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.payments p JOIN public.bookings b ON b.id=p.booking_id
    WHERE p.id=p_payment_id AND p.status::text='success'
      AND b.event_id=v_op.event_id AND b.business_id=v_op.business_id
      AND (p.business_id IS NULL OR p.business_id=v_op.business_id)
  ) THEN RAISE EXCEPTION 'cancelled_payment_identity_mismatch'; END IF;
  -- Serialize by operation/payment without taking a payment row lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_operation_id::text||':'||p_payment_id::text,481));
  IF EXISTS(SELECT 1 FROM public.event_cancelled_payment_followups WHERE operation_id=p_operation_id AND payment_id=p_payment_id) THEN RETURN false; END IF;
  INSERT INTO public.alerts(business_id,type,severity,title,message,metadata)
  VALUES(v_op.business_id,'event_cancelled','warning','Event Cancelled - Refund Follow-up',
    'A payment for a cancelled event requires review under the existing refund policy.',
    jsonb_build_object('eventId',v_op.event_id,'operationId',p_operation_id,'paymentIds',jsonb_build_array(p_payment_id),'manualFollowup',true))
  RETURNING id INTO v_alert;
  INSERT INTO public.event_cancelled_payment_followups(operation_id,payment_id,alert_id) VALUES(p_operation_id,p_payment_id,v_alert);
  RETURN true;
END $$;

CREATE FUNCTION private.mutate_event(p_event_id uuid,p_business_id uuid,p_actor_id uuid,p_actor_kind text,
 p_expected_updated_at timestamptz,p_operation_id uuid,p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_event public.events%ROWTYPE; v_previous public.event_mutation_operations%ROWTYPE;
 v_payload jsonb; v_cancel boolean; v_ids uuid[]; v_pay uuid; v_count integer; v_recipients integer; v_paid integer; v_result jsonb;
BEGIN
  IF p_operation_id IS NULL OR p_actor_id IS NULL OR p_expected_updated_at IS NULL OR p_changes IS NULL OR jsonb_typeof(p_changes)<>'object'
    OR p_changes='{}'::jsonb OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('name','date','time','venue','price','status'))
  THEN RETURN jsonb_build_object('success',false,'reason','invalid_changes'); END IF;
  IF p_actor_kind='admin' THEN
    IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_actor_id AND raw_app_meta_data->>'role'='admin') THEN
      RETURN jsonb_build_object('success',false,'reason','identity_mismatch'); END IF;
  ELSIF p_actor_kind='merchant' THEN
    IF NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=p_business_id AND owner_id=p_actor_id) THEN
      RETURN jsonb_build_object('success',false,'reason','identity_mismatch'); END IF;
  ELSE RETURN jsonb_build_object('success',false,'reason','identity_mismatch'); END IF;
  SELECT * INTO v_event FROM public.events WHERE id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'reason','not_found'); END IF;
  IF v_event.business_id<>p_business_id THEN RETURN jsonb_build_object('success',false,'reason','identity_mismatch'); END IF;
  v_payload:=jsonb_build_object('event_id',p_event_id,'business_id',p_business_id,'actor_id',p_actor_id,'actor_kind',p_actor_kind,
    'expected_updated_at',p_expected_updated_at,'changes',p_changes);
  SELECT * INTO v_previous FROM public.event_mutation_operations WHERE id=p_operation_id;
  IF FOUND THEN
    IF v_previous.request_payload<>v_payload THEN RETURN jsonb_build_object('success',false,'reason','operation_conflict'); END IF;
    RETURN v_previous.response_payload||jsonb_build_object('replayed',true);
  END IF;
  IF v_event.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object('success',false,'reason','revision_conflict','event',to_jsonb(v_event)); END IF;
  IF v_event.status::text='cancelled' AND p_changes ? 'status' AND p_changes->>'status'<>'cancelled' THEN
    RETURN jsonb_build_object('success',false,'reason','event_cancellation_final'); END IF;
  IF (p_changes?'name' AND (jsonb_typeof(p_changes->'name')<>'string' OR length(btrim(p_changes->>'name')) NOT BETWEEN 1 AND 300))
    OR (p_changes?'venue' AND p_changes->'venue'<>'null'::jsonb AND (jsonb_typeof(p_changes->'venue')<>'string' OR length(p_changes->>'venue')>300))
    OR (p_changes?'date' AND (jsonb_typeof(p_changes->'date')<>'string' OR p_changes->>'date' !~ '^\d{4}-\d{2}-\d{2}$'))
    OR (p_changes?'time' AND p_changes->'time'<>'null'::jsonb AND (jsonb_typeof(p_changes->'time')<>'string' OR p_changes->>'time' !~ '^\d{2}:\d{2}(:\d{2})?$'))
    OR (p_changes?'price' AND (jsonb_typeof(p_changes->'price')<>'number' OR p_changes->>'price' !~ '^\d+$' OR (p_changes->>'price')::numeric>2147483647))
    OR (p_changes?'status' AND (jsonb_typeof(p_changes->'status')<>'string' OR p_changes->>'status' NOT IN ('draft','published','sold_out','cancelled','completed')))
  THEN RETURN jsonb_build_object('success',false,'reason','invalid_changes'); END IF;
  v_cancel:=v_event.status::text<>'cancelled' AND p_changes->>'status'='cancelled';
  v_cancel:=COALESCE(v_cancel,false);
  v_ids:='{}';
  IF v_cancel THEN
    -- Ticket locks precede immutable snapshot. No booking/payment lock follows.
    PERFORM id FROM public.event_tickets WHERE event_id=p_event_id AND status='valid' ORDER BY id FOR UPDATE;
    SELECT COALESCE(array_agg(id),'{}') INTO v_ids FROM public.event_tickets WHERE event_id=p_event_id AND status='valid';
  END IF;
  UPDATE public.events SET
    name=CASE WHEN p_changes?'name' THEN p_changes->>'name' ELSE name END,
    date=CASE WHEN p_changes?'date' THEN (p_changes->>'date')::date ELSE date END,
    time=CASE WHEN p_changes?'time' THEN (p_changes->>'time')::time ELSE time END,
    venue=CASE WHEN p_changes?'venue' THEN p_changes->>'venue' ELSE venue END,
    price=CASE WHEN p_changes?'price' THEN (p_changes->>'price')::integer ELSE price END,
    status=CASE WHEN p_changes?'status' THEN (p_changes->>'status')::public.event_status ELSE status END,
    updated_at=clock_timestamp()
  WHERE id=p_event_id RETURNING * INTO v_event;
  INSERT INTO public.event_mutation_operations(id,event_id,business_id,actor_id,actor_kind,request_payload,is_cancellation,affected_ticket_ids)
  VALUES(p_operation_id,p_event_id,p_business_id,p_actor_id,p_actor_kind,v_payload,v_cancel,v_ids);
  v_count:=cardinality(v_ids); v_recipients:=0; v_paid:=0;
  IF v_cancel THEN
    UPDATE public.event_tickets SET status='cancelled' WHERE id=ANY(v_ids);
    INSERT INTO public.event_cancellation_recipients(operation_id,recipient_phone)
    SELECT DISTINCT p_operation_id,regexp_replace(guest_phone,'^\+','')
    FROM public.event_tickets WHERE id=ANY(v_ids) AND guest_phone IS NOT NULL AND length(guest_phone)>0;
    GET DIAGNOSTICS v_recipients=ROW_COUNT;
    FOR v_pay IN SELECT DISTINCT p.id FROM public.payments p JOIN public.event_tickets t ON t.booking_id=p.booking_id
      WHERE t.id=ANY(v_ids) AND p.status::text='success' AND (p.business_id IS NULL OR p.business_id=p_business_id)
    LOOP PERFORM private.record_event_cancelled_payment_followup(p_operation_id,v_pay); v_paid:=v_paid+1; END LOOP;
  END IF;
  IF p_actor_kind='admin' THEN
    INSERT INTO public.admin_audit_logs(actor_id,action,entity_type,entity_id,details)
    VALUES(p_actor_id,CASE WHEN v_cancel THEN 'cancel_event' ELSE 'edit_event' END,'events',p_event_id,
      jsonb_build_object('operationId',p_operation_id,'businessId',p_business_id,'changedFields',(SELECT jsonb_agg(k) FROM jsonb_object_keys(p_changes) k)));
  END IF;
  v_result:=jsonb_build_object('success',true,'event',to_jsonb(v_event),'operation_id',p_operation_id,'cancelled',v_event.status::text='cancelled',
    'counts',jsonb_build_object('cancelled_tickets',v_count,'recipients',v_recipients,'refunds_pending',v_paid));
  UPDATE public.event_mutation_operations SET response_payload=v_result WHERE id=p_operation_id;
  RETURN v_result;
END $$;

CREATE FUNCTION private.converge_event_ticket_booking(p_booking_id uuid,p_event_id uuid,p_ticket_type_id uuid,p_quantity integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,extensions AS $$
DECLARE b public.bookings%ROWTYPE; e public.events%ROWTYPE; st public.event_ticket_issuance_state%ROWTYPE;
 v_tier uuid; v_session_tier uuid; v_op uuid; v_pay uuid; v_number integer; v_tickets jsonb; v_count integer; v_tier_count integer; v_followups integer:=0;
BEGIN
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'reason','booking_not_found'); END IF;
  IF b.event_id IS DISTINCT FROM p_event_id OR b.flow_type::text<>'ticketing' OR p_quantity IS NULL
    OR p_quantity<=0 OR p_quantity IS DISTINCT FROM COALESCE(b.party_size,b.quantity)
  THEN RETURN jsonb_build_object('success',false,'reason','booking_identity_mismatch'); END IF;
  SELECT * INTO e FROM public.events WHERE id=p_event_id FOR UPDATE;
  IF NOT FOUND OR e.business_id<>b.business_id THEN RETURN jsonb_build_object('success',false,'reason','event_identity_mismatch'); END IF;
  IF e.status::text='cancelled' THEN
    SELECT id INTO v_op FROM public.event_mutation_operations WHERE event_id=e.id AND is_cancellation;
    IF v_op IS NULL THEN RETURN jsonb_build_object('success',false,'reason','legacy_cancellation_unverified'); END IF;
    FOR v_pay IN SELECT id FROM public.payments WHERE booking_id=b.id AND status::text='success'
      AND (business_id IS NULL OR business_id=b.business_id)
    LOOP PERFORM private.record_event_cancelled_payment_followup(v_op,v_pay); v_followups:=v_followups+1; END LOOP;
    RETURN jsonb_build_object('success',false,'outcome','cancelled_followup_recorded',
      'reason','event_cancelled','tickets','[]'::jsonb,'inventory_finalized',false,'followup_recorded',true);
  END IF;
  IF b.status::text IN ('cancelled','no_show') THEN RETURN jsonb_build_object('success',false,'reason','booking_not_issuable'); END IF;
  SELECT * INTO st FROM public.event_ticket_issuance_state WHERE booking_id=b.id;
  IF FOUND THEN
    IF st.event_id<>p_event_id OR st.quantity<>p_quantity OR (p_ticket_type_id IS NOT NULL AND st.ticket_type_id IS DISTINCT FROM p_ticket_type_id)
      THEN RETURN jsonb_build_object('success',false,'reason','issuance_identity_mismatch'); END IF;
    v_tier:=st.ticket_type_id;
  ELSE
    v_tier:=p_ticket_type_id;
    IF b.bot_session_id IS NOT NULL THEN
      SELECT NULLIF(session_data->>'ticket_type_id','')::uuid INTO v_session_tier FROM public.bot_sessions WHERE id=b.bot_session_id AND business_id=b.business_id;
      IF v_session_tier IS NOT NULL AND v_tier IS NOT NULL AND v_session_tier<>v_tier THEN
        RETURN jsonb_build_object('success',false,'reason','issuance_identity_mismatch');
      END IF;
      v_tier:=COALESCE(v_session_tier,v_tier);
    END IF;
    IF v_tier IS NULL THEN
      SELECT count(DISTINCT ticket_type_id),min(ticket_type_id::text)::uuid INTO v_tier_count,v_tier
      FROM public.event_tickets WHERE booking_id=b.id AND ticket_type_id IS NOT NULL;
      IF v_tier_count>1 THEN RETURN jsonb_build_object('success',false,'reason','ticket_type_ambiguous'); END IF;
    END IF;
    IF v_tier IS NULL AND EXISTS(SELECT 1 FROM public.event_ticket_types WHERE event_id=e.id) THEN
      RETURN jsonb_build_object('success',false,'reason','ticket_type_required'); END IF;
    IF v_tier IS NOT NULL THEN
      PERFORM id FROM public.event_ticket_types WHERE id=v_tier AND event_id=e.id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'reason','ticket_type_wrong_event'); END IF;
    END IF;
    INSERT INTO public.event_ticket_issuance_state(booking_id,event_id,ticket_type_id,quantity) VALUES(b.id,e.id,v_tier,p_quantity);
  END IF;
  IF v_tier IS NOT NULL THEN
    PERFORM id FROM public.event_ticket_types WHERE id=v_tier AND event_id=e.id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'reason','ticket_type_wrong_event'); END IF;
  END IF;
  IF NOT COALESCE(b.tickets_finalized,false) THEN
    UPDATE public.events SET tickets_sold=tickets_sold+p_quantity WHERE id=e.id;
    IF v_tier IS NOT NULL THEN
      UPDATE public.event_ticket_types SET tickets_sold=COALESCE(tickets_sold,0)+p_quantity WHERE id=v_tier AND event_id=e.id;
      IF NOT FOUND THEN RAISE EXCEPTION 'ticket_type_wrong_event'; END IF;
    END IF;
    UPDATE public.bookings SET tickets_finalized=true WHERE id=b.id;
  END IF;
  FOR v_number IN 1..p_quantity LOOP
    IF NOT EXISTS(SELECT 1 FROM public.event_tickets WHERE booking_id=b.id AND ticket_number=v_number) THEN
      INSERT INTO public.event_tickets(business_id,booking_id,event_id,ticket_code,ticket_number,guest_name,guest_phone,status,ticket_type_id)
      VALUES(b.business_id,b.id,e.id,'TK-'||upper(substr(md5(gen_random_uuid()::text),1,9)),v_number,b.guest_name,b.guest_phone,'valid',v_tier);
    END IF;
  END LOOP;
  SELECT count(*),COALESCE(jsonb_agg(jsonb_build_object('ticketCode',ticket_code,'ticketNumber',ticket_number,'totalTickets',p_quantity) ORDER BY ticket_number),'[]')
    INTO v_count,v_tickets FROM public.event_tickets WHERE booking_id=b.id AND event_id=e.id AND business_id=b.business_id
      AND ticket_number BETWEEN 1 AND p_quantity AND status IN ('valid','used') AND ticket_type_id IS NOT DISTINCT FROM v_tier;
  IF v_count<>p_quantity OR (SELECT count(*) FROM public.event_tickets WHERE booking_id=b.id)<>p_quantity THEN
    RAISE EXCEPTION 'canonical_ticket_state_invalid';
  END IF;
  RETURN jsonb_build_object('success',true,'outcome','issued','tickets',v_tickets,'inventory_finalized',true,'already_finalized',COALESCE(b.tickets_finalized,false));
END $$;

CREATE FUNCTION private.authorize_event_ticket_emission(p_booking_id uuid,p_channel text,p_emission_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b public.bookings%ROWTYPE; e public.events%ROWTYPE; v_id uuid; v_prior public.event_ticket_emissions%ROWTYPE;
BEGIN
  IF p_channel NOT IN ('whatsapp','email','webhook') OR p_emission_key IS NULL OR length(p_emission_key) NOT BETWEEN 1 AND 200
    THEN RETURN jsonb_build_object('authorized',false,'reason','invalid_emission'); END IF;
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('authorized',false,'reason','booking_not_found'); END IF;
  SELECT * INTO e FROM public.events WHERE id=b.event_id FOR UPDATE;
  SELECT * INTO v_prior FROM public.event_ticket_emissions WHERE booking_id=b.id AND channel=p_channel AND emission_key=p_emission_key;
  IF FOUND THEN RETURN jsonb_build_object('authorized',false,'reason','already_authorized','state',v_prior.state,'emission_id',v_prior.id,'provider_message_id',v_prior.provider_message_id); END IF;
  IF e.id IS NULL OR e.business_id<>b.business_id OR e.status::text='cancelled'
    OR b.status::text IN ('cancelled','no_show')
    OR NOT EXISTS(SELECT 1 FROM public.event_tickets WHERE booking_id=b.id AND status='valid')
    OR EXISTS(SELECT 1 FROM public.event_tickets WHERE booking_id=b.id AND status='cancelled')
  THEN RETURN jsonb_build_object('authorized',false,'reason',CASE WHEN e.status::text='cancelled' THEN 'event_cancelled' ELSE 'event_or_tickets_cancelled' END); END IF;
  INSERT INTO public.event_ticket_emissions(booking_id,channel,emission_key)
  VALUES(b.id,p_channel,p_emission_key) ON CONFLICT(booking_id,channel,emission_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN jsonb_build_object('authorized',false,'reason','already_authorized'); END IF;
  RETURN jsonb_build_object('authorized',true,'emission_id',v_id);
END $$;

CREATE FUNCTION private.finalize_event_ticket_emission(p_emission_id uuid,p_state text,p_provider_message_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_state NOT IN ('accepted','failed','ambiguous') OR (p_state='accepted' AND NULLIF(p_provider_message_id,'') IS NULL)
    THEN RETURN jsonb_build_object('finalized',false); END IF;
  UPDATE public.event_ticket_emissions SET state=p_state,provider_message_id=p_provider_message_id WHERE id=p_emission_id AND state='attempted';
  IF FOUND THEN RETURN jsonb_build_object('finalized',true); END IF;
  RETURN jsonb_build_object('finalized',EXISTS(SELECT 1 FROM public.event_ticket_emissions WHERE id=p_emission_id AND state=p_state AND provider_message_id IS NOT DISTINCT FROM p_provider_message_id));
END $$;

CREATE FUNCTION private.claim_event_cancellation_notification(p_recipient_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,extensions AS $$
DECLARE r public.event_cancellation_recipients%ROWTYPE; v_token uuid:=gen_random_uuid();
BEGIN
  UPDATE public.event_cancellation_recipients SET state='claimed',claim_token=v_token,claim_expires_at=clock_timestamp()+interval '30 seconds'
  WHERE id=p_recipient_id AND attempted_at IS NULL AND (state='pending' OR (state='claimed' AND claim_expires_at<clock_timestamp()))
  RETURNING * INTO r;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed',false); END IF;
  RETURN jsonb_build_object('claimed',true,'claim_token',v_token,'recipient_phone',r.recipient_phone,'operation_id',r.operation_id);
END $$;
CREATE FUNCTION private.mark_event_cancellation_notification_attempted(p_recipient_id uuid,p_claim_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.event_cancellation_recipients SET state='attempted',attempted_at=clock_timestamp()
  WHERE id=p_recipient_id AND claim_token=p_claim_token AND state='claimed' AND claim_expires_at>clock_timestamp() AND attempted_at IS NULL;
  RETURN jsonb_build_object('marked',FOUND);
END $$;
CREATE FUNCTION private.finalize_event_cancellation_notification(p_recipient_id uuid,p_claim_token uuid,p_state text,p_provider_message_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_state NOT IN ('pending','accepted','failed','ambiguous') OR (p_state='accepted' AND NULLIF(p_provider_message_id,'') IS NULL)
    THEN RETURN jsonb_build_object('finalized',false); END IF;
  UPDATE public.event_cancellation_recipients SET state=p_state,provider_message_id=p_provider_message_id,
    claim_token=CASE WHEN p_state='pending' THEN NULL ELSE claim_token END,
    claim_expires_at=CASE WHEN p_state='pending' THEN NULL ELSE claim_expires_at END
  WHERE id=p_recipient_id AND claim_token=p_claim_token AND
    ((p_state='pending' AND state='claimed' AND attempted_at IS NULL AND claim_expires_at>clock_timestamp())
      OR (p_state<>'pending' AND state='attempted' AND attempted_at IS NOT NULL));
  IF FOUND THEN RETURN jsonb_build_object('finalized',true); END IF;
  RETURN jsonb_build_object('finalized',EXISTS(SELECT 1 FROM public.event_cancellation_recipients WHERE id=p_recipient_id AND claim_token=p_claim_token AND state=p_state AND provider_message_id IS NOT DISTINCT FROM p_provider_message_id));
END $$;

CREATE FUNCTION private.terminate_cancelled_event_confirmation(p_payment_id uuid,p_claim_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.payments%ROWTYPE; v_event uuid; v_business uuid; v_op uuid;
BEGIN
  SELECT * INTO p FROM public.payments WHERE id=p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('terminated',false,'reason','payment_not_found'); END IF;
  SELECT b.event_id,b.business_id INTO v_event,v_business FROM public.bookings b
    JOIN public.events e ON e.id=b.event_id AND e.business_id=b.business_id
    WHERE b.id=p.booking_id AND b.flow_type::text='ticketing' AND e.status::text='cancelled';
  IF v_event IS NULL THEN RETURN jsonb_build_object('terminated',false,'reason','not_cancelled'); END IF;
  SELECT id INTO v_op FROM public.event_mutation_operations WHERE event_id=v_event AND business_id=v_business AND is_cancellation;
  IF v_op IS NULL THEN RETURN jsonb_build_object('terminated',false,'reason','legacy_cancellation_unverified'); END IF;
  IF p.confirmation_terminal_reason='event_cancelled_followup_recorded' AND EXISTS(
    SELECT 1 FROM public.event_cancelled_payment_followups WHERE operation_id=v_op AND payment_id=p.id)
    THEN RETURN jsonb_build_object('terminated',true,'already_terminated',true); END IF;
  IF p.confirmation_sent_at IS NOT NULL THEN RETURN jsonb_build_object('terminated',false,'reason','already_finalized'); END IF;
  IF p.confirmation_terminal_reason IS NOT NULL THEN RETURN jsonb_build_object('terminated',false,'reason','terminal_reason_conflict'); END IF;
  IF p.confirmation_claim_token IS DISTINCT FROM p_claim_token OR p_claim_token IS NULL
    THEN RETURN jsonb_build_object('terminated',false,'reason','token_mismatch'); END IF;
  IF p.confirmation_processing_at IS NULL OR p.confirmation_processing_at<=clock_timestamp()-interval '5 minutes'
    THEN RETURN jsonb_build_object('terminated',false,'reason','claim_expired'); END IF;
  PERFORM private.record_event_cancelled_payment_followup(v_op,p.id);
  UPDATE public.payments SET confirmation_terminal_reason='event_cancelled_followup_recorded',
    confirmation_processing_at=NULL,confirmation_claim_token=NULL WHERE id=p.id;
  RETURN jsonb_build_object('terminated',true,'already_terminated',false);
END $$;

-- Public API wrappers are INVOKER; private functions own narrowly bounded elevation.
CREATE FUNCTION public.mutate_event(p_event_id uuid,p_business_id uuid,p_actor_id uuid,p_actor_kind text,p_expected_updated_at timestamptz,p_operation_id uuid,p_changes jsonb)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT private.mutate_event($1,$2,$3,$4,$5,$6,$7) $$;
CREATE FUNCTION public.converge_event_ticket_booking(p_booking_id uuid,p_event_id uuid,p_ticket_type_id uuid DEFAULT NULL,p_quantity integer DEFAULT 1)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT private.converge_event_ticket_booking($1,$2,$3,$4) $$;
CREATE OR REPLACE FUNCTION public.finalize_free_ticket_booking(p_booking_id uuid,p_event_id uuid,p_ticket_type_id uuid DEFAULT NULL,p_quantity integer DEFAULT 1)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT private.converge_event_ticket_booking($1,$2,$3,$4) $$;
CREATE FUNCTION public.authorize_event_ticket_emission(p_booking_id uuid,p_channel text,p_emission_key text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT private.authorize_event_ticket_emission($1,$2,$3) $$;
CREATE FUNCTION public.finalize_event_ticket_emission(p_emission_id uuid,p_state text,p_provider_message_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT private.finalize_event_ticket_emission($1,$2,$3) $$;
CREATE FUNCTION public.claim_event_cancellation_notification(p_recipient_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT private.claim_event_cancellation_notification($1) $$;
CREATE FUNCTION public.mark_event_cancellation_notification_attempted(p_recipient_id uuid,p_claim_token uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT private.mark_event_cancellation_notification_attempted($1,$2) $$;
CREATE FUNCTION public.finalize_event_cancellation_notification(p_recipient_id uuid,p_claim_token uuid,p_state text,p_provider_message_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT private.finalize_event_cancellation_notification($1,$2,$3,$4) $$;
CREATE FUNCTION public.terminate_cancelled_event_confirmation(p_payment_id uuid,p_claim_token uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT private.terminate_cancelled_event_confirmation($1,$2) $$;

DO $acl$
DECLARE r record; v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['event_mutation_operations','event_cancellation_recipients','event_cancelled_payment_followups','event_ticket_issuance_state','event_ticket_emissions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated',v_table);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',v_table);
    EXECUTE format('CREATE POLICY service_only ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',v_table);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS signature,n.nspname,p.proname,p.prosecdef,p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='private' AND p.proname IN ('event_finality_guard','record_event_cancelled_payment_followup','mutate_event','converge_event_ticket_booking','authorize_event_ticket_emission','finalize_event_ticket_emission','claim_event_cancellation_notification','mark_event_cancellation_notification_attempted','finalize_event_cancellation_notification','terminate_cancelled_event_confirmation'))
      OR (n.nspname='public' AND p.proname IN ('mutate_event','converge_event_ticket_booking','finalize_free_ticket_booking','authorize_event_ticket_emission','finalize_event_ticket_emission','claim_event_cancellation_notification','mark_event_cancellation_notification_attempted','finalize_event_cancellation_notification','terminate_cancelled_event_confirmation'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',r.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.signature);
    IF r.proconfig IS NULL OR NOT EXISTS(SELECT 1 FROM unnest(r.proconfig) c WHERE c LIKE 'search_path=%') THEN RAISE EXCEPTION 'M481 missing search_path %',r.signature; END IF;
    IF r.nspname='public' AND r.prosecdef THEN RAISE EXCEPTION 'M481 public elevation %',r.signature; END IF;
    IF r.nspname='private' AND NOT r.prosecdef THEN RAISE EXCEPTION 'M481 private authority %',r.signature; END IF;
    IF has_function_privilege('authenticated',r.signature,'EXECUTE') OR has_function_privilege('anon',r.signature,'EXECUTE')
      OR NOT has_function_privilege('service_role',r.signature,'EXECUTE') THEN RAISE EXCEPTION 'M481 invalid ACL %',r.signature; END IF;
  END LOOP;
END $acl$;
COMMIT;
