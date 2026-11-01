-- M497: Core scheduling price authority (#604).
-- Forward-only; configurable promo/package modes are excluded.
BEGIN;
CREATE SCHEMA IF NOT EXISTS scheduling_private_604;
REVOKE ALL ON SCHEMA scheduling_private_604 FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA scheduling_private_604 TO service_role;

ALTER TABLE public.promo_reservations ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE public.promo_reservations ADD COLUMN booking_id uuid REFERENCES public.bookings(id) ON DELETE CASCADE;
ALTER TABLE public.promo_reservations ADD CONSTRAINT promo_reservations_entity_xor
  CHECK (num_nonnulls(order_id, booking_id) = 1);
CREATE UNIQUE INDEX promo_reservations_booking_604 ON public.promo_reservations(booking_id) WHERE booking_id IS NOT NULL;

-- Called in the same transaction as slot allocation; callers provide expected
-- terms only. They never supply the authoritative price, discount or capacity.
CREATE FUNCTION scheduling_private_604.quote(
  p_business uuid, p_service uuid, p_appointment uuid, p_party integer,
  p_addons jsonb, p_promo uuid, p_expected jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  b record; item jsonb; addon record; promo record; selected jsonb;
  unit_price integer; unit_deposit integer; discount integer := 0;
  addon_total bigint := 0; total bigint; due bigint; reserved bigint;
  mode text; prepay boolean; item_id uuid := COALESCE(p_service,p_appointment);
BEGIN
  IF p_party IS NULL OR p_party < 1 OR p_party > 50 THEN RAISE EXCEPTION 'invalid_party_size'; END IF;
  IF p_service IS NOT NULL AND p_appointment IS NOT NULL THEN RAISE EXCEPTION 'invalid_booking_item'; END IF;
  SELECT * INTO b FROM public.businesses WHERE id=p_business FOR SHARE;
  IF NOT FOUND OR b.status::text <> 'active' THEN RAISE EXCEPTION 'business_unavailable'; END IF;
  IF p_service IS NOT NULL THEN
    SELECT to_jsonb(s) INTO item FROM public.services s WHERE s.id=p_service AND s.business_id=p_business FOR SHARE;
  ELSIF p_appointment IS NOT NULL THEN
    SELECT to_jsonb(a) INTO item FROM public.appointments a WHERE a.id=p_appointment AND a.business_id=p_business FOR SHARE;
  ELSE
    item := jsonb_build_object('price',0,'deposit_amount',0,'is_active',true,'max_capacity',1);
  END IF;
  IF item IS NULL OR (item->>'is_active')::boolean IS NOT TRUE OR item->>'deleted_at' IS NOT NULL THEN
    RAISE EXCEPTION 'item_unavailable';
  END IF;
  -- No customer-selected variable amount is inferred from a floor/session ID.
  -- A separately verified quote producer must be integrated before enabling it.
  
  unit_price := COALESCE((item->>'price')::integer,0);
  unit_deposit := COALESCE((item->>'deposit_amount')::integer,0);
  IF COALESCE((item->>'price_is_variable')::boolean,false) THEN
    IF p_expected->>'verified_variable_intent' IS DISTINCT FROM 'true'
       OR (p_expected->>'price')::integer IS NULL OR (p_expected->>'price')::integer<unit_price THEN
       RAISE EXCEPTION 'verified_quote_required';
    END IF;
    unit_price := (p_expected->>'price')::integer;
  END IF;
  IF unit_price < 0 OR unit_deposit < 0 THEN RAISE EXCEPTION 'invalid_item_terms'; END IF;
  IF p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object'
     OR p_expected->>'price' IS NULL OR p_expected->>'deposit' IS NULL
     OR (p_expected->>'price')::integer IS DISTINCT FROM unit_price
     OR (p_expected->>'deposit')::integer IS DISTINCT FROM unit_deposit
     OR p_expected->>'country' IS DISTINCT FROM b.country_code THEN
    RAISE EXCEPTION 'terms_changed';
  END IF;
  IF jsonb_typeof(COALESCE(p_addons,'[]')) <> 'array' THEN RAISE EXCEPTION 'invalid_addons'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(COALESCE(p_addons,'[]'))) <>
     (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(COALESCE(p_addons,'[]')) x) THEN
    RAISE EXCEPTION 'duplicate_addon';
  END IF;
  -- Stable ordering prevents cross-booking addon lock inversion.
  FOR selected IN SELECT x FROM jsonb_array_elements(COALESCE(p_addons,'[]')) x ORDER BY x->>'id' LOOP
    SELECT * INTO addon FROM public.service_addons
      WHERE id=(selected->>'id')::uuid AND business_id=p_business FOR SHARE;
    IF NOT FOUND OR addon.is_active IS NOT TRUE
       OR (addon.service_id IS NOT NULL AND addon.service_id IS DISTINCT FROM p_service)
       OR addon.price < 0 OR (selected->>'price')::integer IS DISTINCT FROM addon.price THEN
      RAISE EXCEPTION 'addon_terms_changed';
    END IF;
    addon_total := addon_total + addon.price;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.service_addons a WHERE a.business_id=p_business AND a.is_active
      AND a.is_required AND (a.service_id IS NULL OR a.service_id=p_service)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_addons,'[]')) x WHERE x->>'id'=a.id::text)) THEN
    RAISE EXCEPTION 'required_addon_missing';
  END IF;
  IF p_promo IS NOT NULL THEN
    SELECT * INTO promo FROM public.promo_codes WHERE id=p_promo FOR UPDATE;
    IF NOT FOUND OR promo.business_id IS DISTINCT FROM p_business OR promo.is_active IS NOT TRUE
      OR (promo.valid_from IS NOT NULL AND now()<promo.valid_from)
      OR (promo.valid_until IS NOT NULL AND now()>=promo.valid_until)
      OR (COALESCE(cardinality(promo.applicable_flow_types),0)>0 AND NOT 'scheduling'=ANY(promo.applicable_flow_types))
      OR (COALESCE(cardinality(promo.applicable_services),0)>0 AND (item_id IS NULL OR NOT item_id=ANY(promo.applicable_services)))
      OR COALESCE(promo.min_order_amount,0)>unit_price THEN RAISE EXCEPTION 'promo_unavailable'; END IF;
    SELECT count(*) INTO reserved FROM public.promo_reservations WHERE promo_code_id=p_promo AND state='reserved';
    IF promo.max_uses IS NOT NULL AND COALESCE(promo.current_uses,0)+reserved >= promo.max_uses THEN
      RAISE EXCEPTION 'promo_exhausted';
    END IF;
    IF promo.discount_type='percentage' AND promo.discount_value>0 AND promo.discount_value<=100 THEN
      discount := LEAST(unit_price,round(unit_price::numeric*promo.discount_value/100)::integer);
    ELSIF promo.discount_type='fixed' AND promo.discount_value>0 THEN
      discount := LEAST(unit_price,round(promo.discount_value)::integer);
    ELSE RAISE EXCEPTION 'invalid_promo'; END IF;
  END IF;
  IF (p_expected->>'discount')::integer IS DISTINCT FROM discount THEN RAISE EXCEPTION 'terms_changed'; END IF;
  -- Existing fixed discount applies to each participant's service, never addons.
  total := (unit_price::bigint-discount)*p_party + addon_total;
  mode := COALESCE(b.metadata->>'prepay_mode','auto');
  prepay := mode='full' OR (mode='auto' AND b.category::text=ANY(ARRAY[
    'barber','spa','salon','tattoo','gym','clinic','dental','veterinary','consultant',
    'tutor','photographer','car_wash','laundry','coworking']));
  IF p_expected->>'source'='public' THEN due:=COALESCE(NULLIF(unit_deposit,0),unit_price)::bigint*p_party;
  ELSIF mode='free' THEN due:=0;
  ELSIF unit_deposit>0 THEN due:=LEAST(unit_deposit,total);
  ELSIF COALESCE(b.deposit_per_guest,0)>0 THEN due:=b.deposit_per_guest::bigint*p_party;
  ELSIF prepay THEN due:=total;
  ELSE due:=0; END IF;
  IF item_id IS NULL AND total=0 THEN total:=due; END IF;
  IF total>2147483647 OR due>2147483647 OR due>total THEN RAISE EXCEPTION 'invalid_booking_amount'; END IF;
  RETURN jsonb_build_object('total',total,'deposit',due,'price',unit_price,
    'item_deposit',unit_deposit,'discount',discount,'country',b.country_code,
    'capacity',CASE WHEN item->'metadata'->>'is_dropoff'='true' THEN 9999 ELSE COALESCE((item->>'max_capacity')::integer,1) END,
    'buffer',COALESCE((item->>'buffer_minutes')::integer,(item->'metadata'->>'buffer_minutes')::integer,0),
    'duration',COALESCE((item->>'duration_minutes')::integer,30),
    'auto_approve',COALESCE((item->>'auto_approve')::boolean,true));
END;
$$;
REVOKE ALL ON FUNCTION scheduling_private_604.quote(uuid,uuid,uuid,integer,jsonb,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;


ALTER FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer) SET SCHEMA scheduling_private_604;
REVOKE ALL ON FUNCTION scheduling_private_604.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION scheduling_private_604.create_booking(p jsonb, p_mode text DEFAULT 'customer', p_enrollment uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE
  b public.bookings%ROWTYPE; existing public.bookings%ROWTYPE;
  session_row record; enrollment record; package record; cs record;
  q jsonb; r record; legacy_item jsonb; legacy_country text; legacy boolean := p_mode LIKE 'legacy%'; expected jsonb := p->'expected_terms'; claim jsonb;
  due integer; total integer; final_status text; selected jsonb;
BEGIN
  SELECT * INTO b FROM jsonb_populate_record(NULL::public.bookings,p);
  IF b.flow_type::text IS DISTINCT FROM 'scheduling' THEN RAISE EXCEPTION 'unsupported_booking_flow'; END IF;
  IF b.bot_session_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('scheduling604:'||b.bot_session_id::text,0));
    SELECT * INTO session_row FROM public.bot_sessions WHERE id=b.bot_session_id FOR SHARE;
    IF NOT legacy AND (NOT FOUND OR session_row.business_id IS DISTINCT FROM b.business_id
      OR session_row.user_id IS DISTINCT FROM b.user_id
      OR ltrim(session_row.whatsapp_number,'+') IS DISTINCT FROM ltrim(b.guest_phone,'+')) THEN
      RAISE EXCEPTION 'booking_identity_mismatch';
    END IF;
    SELECT * INTO existing FROM public.bookings WHERE bot_session_id=b.bot_session_id;
    IF FOUND THEN
      IF existing.metadata->'scheduling_authority_604'->'request' IS DISTINCT FROM p
        OR existing.status::text NOT IN ('pending','confirmed','in_progress','completed')
        OR existing.metadata->'scheduling_authority_604'->>'enrollment' IS DISTINCT FROM p_enrollment::text THEN
        RAISE EXCEPTION 'booking_intent_changed';
      END IF;
      RETURN jsonb_build_object('booking_id',existing.id,'reference_code',existing.reference_code,
        'slot_available',true,'committed_total',existing.total_amount,'committed_deposit',existing.deposit_amount,
        'package_covered',p_enrollment IS NOT NULL,'success',true);
    END IF;
    IF NOT legacy THEN
    claim := session_row.session_data->'_604_confirmation';
    IF claim IS NULL OR claim->>'service_id' IS DISTINCT FROM COALESCE(b.service_id,b.appointment_id)::text
      OR claim->>'date' IS DISTINCT FROM b.date::text
      OR (claim->>'party_size')::integer IS DISTINCT FROM b.party_size
      OR claim->>'time' IS DISTINCT FROM b.time::text
      OR claim->'terms' IS DISTINCT FROM expected THEN RAISE EXCEPTION 'booking_confirmation_required'; END IF;
    END IF;
  END IF;
  IF legacy THEN
    IF b.service_id IS NOT NULL THEN SELECT to_jsonb(s) INTO legacy_item FROM services s WHERE id=b.service_id FOR SHARE;
    ELSIF b.appointment_id IS NOT NULL THEN SELECT to_jsonb(a) INTO legacy_item FROM appointments a WHERE id=b.appointment_id FOR SHARE;
    ELSE legacy_item:='{"price":0,"deposit_amount":0}'::jsonb; END IF;
    SELECT country_code INTO legacy_country FROM businesses WHERE id=b.business_id FOR SHARE;
    IF legacy_item->>'is_active'='false' THEN RAISE EXCEPTION 'service_unavailable'; END IF;
    IF p->>'expected_price' IS NOT NULL AND (p->>'expected_price')::integer IS DISTINCT FROM (legacy_item->>'price')::integer THEN RAISE EXCEPTION 'price_changed'; END IF;
    IF p->>'expected_deposit' IS NOT NULL AND (p->>'expected_deposit')::integer IS DISTINCT FROM (legacy_item->>'deposit_amount')::integer THEN RAISE EXCEPTION 'deposit_changed'; END IF;
    expected:=jsonb_build_object('price',COALESCE((legacy_item->>'price')::integer,0),
      'deposit',COALESCE((legacy_item->>'deposit_amount')::integer,0),'country',legacy_country,'discount',0);
  END IF;
  q := scheduling_private_604.quote(b.business_id,b.service_id,b.appointment_id,b.party_size,b.addons_snapshot,b.promo_code_id,expected||jsonb_build_object('verified_variable_intent',claim IS NOT NULL));
  IF p_enrollment IS NOT NULL THEN
    IF b.service_id IS NULL OR b.appointment_id IS NOT NULL THEN RAISE EXCEPTION 'package_service_required'; END IF;
    SELECT * INTO enrollment FROM public.package_enrollments WHERE id=p_enrollment FOR UPDATE;
    IF NOT FOUND OR enrollment.business_id IS DISTINCT FROM b.business_id OR enrollment.is_active IS NOT TRUE
      OR ltrim(enrollment.customer_phone,'+') IS DISTINCT FROM ltrim(b.guest_phone,'+')
      OR enrollment.expires_at<=now() OR enrollment.sessions_used>=enrollment.sessions_total THEN
      RAISE EXCEPTION 'package_unavailable';
    END IF;
    SELECT * INTO package FROM public.service_packages WHERE id=enrollment.package_id FOR SHARE;
    IF NOT FOUND OR package.business_id IS DISTINCT FROM b.business_id OR package.is_active IS NOT TRUE
      OR (COALESCE(cardinality(package.service_ids),0)>0 AND NOT b.service_id=ANY(package.service_ids)) THEN
      RAISE EXCEPTION 'package_unavailable';
    END IF;
  END IF;
  total := (q->>'total')::integer;
  due := (q->>'deposit')::integer;
  IF p_mode IN ('manual','legacy_manual') OR p_enrollment IS NOT NULL THEN due:=0; END IF;
  IF NOT legacy AND (b.total_amount IS DISTINCT FROM total OR b.deposit_amount IS DISTINCT FROM due) THEN RAISE EXCEPTION 'terms_changed'; END IF;
  IF legacy AND p->>'expected_price' IS NULL AND p_enrollment IS NULL AND p_mode<>'legacy_manual'
      AND (b.total_amount IS DISTINCT FROM total OR b.deposit_amount IS DISTINCT FROM due) THEN RAISE EXCEPTION 'terms_changed'; END IF;
  IF p_mode='legacy_manual' AND b.total_amount IS DISTINCT FROM (q->>'price')::integer THEN RAISE EXCEPTION 'price_changed'; END IF;
  IF b.class_session_id IS NOT NULL THEN
    SELECT * INTO cs FROM public.class_sessions WHERE id=b.class_session_id FOR SHARE;
    IF NOT FOUND OR cs.business_id IS DISTINCT FROM b.business_id OR cs.service_id IS DISTINCT FROM b.service_id
       OR cs.date IS DISTINCT FROM b.date OR cs.start_time IS DISTINCT FROM b.time THEN
      RAISE EXCEPTION 'class_terms_changed';
    END IF;
  END IF;
  IF b.promo_code_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.bookings
    WHERE business_id=b.business_id AND ltrim(guest_phone,'+')=ltrim(b.guest_phone,'+')
      AND promo_code_id=b.promo_code_id AND status::text<>'cancelled') THEN RAISE EXCEPTION 'promo_already_used'; END IF;
  final_status := CASE WHEN p_mode IN ('manual','legacy_manual') THEN 'confirmed' WHEN due>0 THEN 'pending'
    WHEN (q->>'auto_approve')::boolean THEN 'confirmed' ELSE 'pending' END;
  SELECT * INTO r FROM scheduling_private_604.book_slot_atomic(
    b.business_id,b.user_id,b.service_id,b.staff_id,b.date,b.time::text,b.party_size,(q->>'capacity')::integer,
    'scheduling',due,CASE WHEN due>0 THEN 'pending' ELSE 'none' END,final_status,
    b.guest_name,b.guest_phone,b.guest_email,b.special_requests,b.venue_address,b.end_date,
    b.addons_snapshot,b.promo_code_id,total,b.staff_name,b.location_id,b.appointment_id,
    (q->>'buffer')::integer,(q->>'duration')::integer,b.bot_session_id,b.class_session_id,NULL,NULL);
  IF r.slot_available IS NOT TRUE THEN RETURN jsonb_build_object('slot_available',false,'success',false,'reason','slot_full'); END IF;
  UPDATE public.bookings SET metadata=COALESCE(metadata,'{}')||jsonb_build_object('scheduling_authority_604',
    jsonb_build_object('request',p,'terms',q,'enrollment',p_enrollment)), 
    channel=CASE WHEN p_mode IN ('manual','legacy_manual') THEN 'dashboard'::booking_channel ELSE channel END,
    notes=CASE WHEN p_mode IN ('manual','legacy_manual') THEN b.notes ELSE notes END,
    confirmed_at=CASE WHEN final_status='confirmed' THEN now() ELSE confirmed_at END
    WHERE id=r.booking_id;
  IF p_enrollment IS NOT NULL THEN
    INSERT INTO public.package_redemptions(enrollment_id,booking_id,business_id) VALUES(p_enrollment,r.booking_id,b.business_id);
    UPDATE public.package_enrollments SET sessions_used=sessions_used+1 WHERE id=p_enrollment;
  END IF;
  IF b.promo_code_id IS NOT NULL THEN
    INSERT INTO public.promo_reservations(booking_id,promo_code_id,state)
      VALUES(r.booking_id,b.promo_code_id,CASE WHEN due=0 THEN 'finalized' ELSE 'reserved' END);
    IF due=0 THEN UPDATE public.promo_codes SET current_uses=COALESCE(current_uses,0)+1 WHERE id=b.promo_code_id; END IF;
  END IF;
  RETURN jsonb_build_object('booking_id',r.booking_id,'reference_code',r.reference_code,'slot_available',true,
    'committed_total',total,'committed_deposit',due,'package_covered',p_enrollment IS NOT NULL,'success',true);
END;
$$;
REVOKE ALL ON FUNCTION scheduling_private_604.create_booking(jsonb,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION scheduling_private_604.create_booking(jsonb,text,uuid) TO service_role;
CREATE FUNCTION public.book_slot_atomic(
  p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
  p_date date, p_time text, p_party_size int, p_max_capacity int,
  p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text,
  p_guest_name text, p_guest_phone text, p_guest_email text,
  p_special_requests text, p_venue_address text, p_end_date date,
  p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text,
  p_location_id uuid DEFAULT NULL, p_appointment_id uuid DEFAULT NULL,
  p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30,
  p_bot_session_id uuid DEFAULT NULL, p_class_session_id uuid DEFAULT NULL,
  p_expected_price int DEFAULT NULL, p_expected_deposit int DEFAULT NULL
) RETURNS TABLE(booking_id uuid,reference_code text,slot_available boolean)
LANGUAGE sql SECURITY INVOKER SET search_path=public,extensions AS $$
 SELECT (r->>'booking_id')::uuid,r->>'reference_code',(r->>'slot_available')::boolean
 FROM (SELECT scheduling_private_604.create_booking(jsonb_build_object('business_id',p_business_id,'user_id',p_user_id,'service_id',p_service_id,'staff_id',p_staff_id,'date',p_date,'time',p_time,'party_size',p_party_size,'flow_type',p_flow_type,'deposit_amount',p_deposit_amount,'deposit_status',p_deposit_status,'status',p_status,'guest_name',p_guest_name,'guest_phone',p_guest_phone,'guest_email',p_guest_email,'special_requests',p_special_requests,'venue_address',p_venue_address,'end_date',p_end_date,'addons_snapshot',p_addons_snapshot,'promo_code_id',p_promo_code_id,'total_amount',p_total_amount,'staff_name',p_staff_name,'location_id',p_location_id,'appointment_id',p_appointment_id,'bot_session_id',p_bot_session_id,'class_session_id',p_class_session_id,'expected_price',p_expected_price,'expected_deposit',p_expected_deposit),'legacy') AS r) result;
$$;
REVOKE ALL ON FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer) TO service_role;
CREATE FUNCTION public.book_slot_authoritative_604(
  p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
  p_date date, p_time text, p_party_size int, p_max_capacity int,
  p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text,
  p_guest_name text, p_guest_phone text, p_guest_email text,
  p_special_requests text, p_venue_address text, p_end_date date,
  p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text,
  p_location_id uuid DEFAULT NULL, p_appointment_id uuid DEFAULT NULL,
  p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30,
  p_bot_session_id uuid DEFAULT NULL, p_class_session_id uuid DEFAULT NULL,
  p_expected_price int DEFAULT NULL, p_expected_deposit int DEFAULT NULL,
  p_expected_terms jsonb DEFAULT NULL
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean, committed_total integer, committed_deposit integer)
LANGUAGE sql SECURITY INVOKER SET search_path=public,extensions AS $$
 SELECT (r->>'booking_id')::uuid,r->>'reference_code',(r->>'slot_available')::boolean,
 (r->>'committed_total')::integer,(r->>'committed_deposit')::integer
 FROM (SELECT scheduling_private_604.create_booking(jsonb_build_object('business_id',p_business_id,'user_id',p_user_id,'service_id',p_service_id,'staff_id',p_staff_id,'date',p_date,'time',p_time,'party_size',p_party_size,'flow_type',p_flow_type,'deposit_amount',p_deposit_amount,'deposit_status',p_deposit_status,'status',p_status,'guest_name',p_guest_name,'guest_phone',p_guest_phone,'guest_email',p_guest_email,'special_requests',p_special_requests,'venue_address',p_venue_address,'end_date',p_end_date,'addons_snapshot',p_addons_snapshot,'promo_code_id',p_promo_code_id,'total_amount',p_total_amount,'staff_name',p_staff_name,'location_id',p_location_id,'appointment_id',p_appointment_id,'bot_session_id',p_bot_session_id,'class_session_id',p_class_session_id,'expected_terms',p_expected_terms)) AS r) result;
$$;
REVOKE ALL ON FUNCTION public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.book_manual_slot_atomic(
  p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
  p_date date, p_time text, p_party_size int, p_max_capacity int,
  p_guest_name text, p_guest_phone text, p_guest_email text, p_notes text,
  p_total_amount int, p_staff_name text,
  p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30,
  p_appointment_id uuid DEFAULT NULL, p_class_session_id uuid DEFAULT NULL
) RETURNS TABLE(booking_id uuid,reference_code text,slot_available boolean)
LANGUAGE sql SECURITY INVOKER SET search_path=public,extensions AS $$
 SELECT (r->>'booking_id')::uuid,r->>'reference_code',(r->>'slot_available')::boolean
 FROM (SELECT scheduling_private_604.create_booking(jsonb_build_object('business_id',p_business_id,'user_id',p_user_id,'service_id',p_service_id,'staff_id',p_staff_id,'date',p_date,'time',p_time,'party_size',p_party_size,'guest_name',p_guest_name,'guest_phone',p_guest_phone,'guest_email',p_guest_email,'notes',p_notes,'total_amount',p_total_amount,'staff_name',p_staff_name,'appointment_id',p_appointment_id,'class_session_id',p_class_session_id,'flow_type','scheduling','deposit_amount',0),'legacy_manual') AS r) result;
$$;

CREATE FUNCTION public.book_manual_slot_authoritative_604(
  p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
  p_date date, p_time text, p_party_size int, p_max_capacity int,
  p_guest_name text, p_guest_phone text, p_guest_email text, p_notes text,
  p_total_amount int, p_staff_name text,
  p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30,
  p_appointment_id uuid DEFAULT NULL, p_class_session_id uuid DEFAULT NULL, p_expected_terms jsonb DEFAULT NULL
) RETURNS TABLE(booking_id uuid,reference_code text,slot_available boolean,committed_total integer,committed_deposit integer)
LANGUAGE sql SECURITY INVOKER SET search_path=public,extensions AS $$
 SELECT (r->>'booking_id')::uuid,r->>'reference_code',(r->>'slot_available')::boolean,
 (r->>'committed_total')::integer,(r->>'committed_deposit')::integer
 FROM (SELECT scheduling_private_604.create_booking(jsonb_build_object('business_id',p_business_id,'user_id',p_user_id,'service_id',p_service_id,'staff_id',p_staff_id,'date',p_date,'time',p_time,'party_size',p_party_size,'guest_name',p_guest_name,'guest_phone',p_guest_phone,'guest_email',p_guest_email,'notes',p_notes,'total_amount',p_total_amount,'staff_name',p_staff_name,'appointment_id',p_appointment_id,'class_session_id',p_class_session_id,'expected_terms',p_expected_terms,
 'flow_type','scheduling','deposit_amount',0),'manual') AS r) result;
$$;
REVOKE ALL ON FUNCTION public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,integer,integer,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,integer,integer,uuid,uuid,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.book_with_package_atomic(
  -- Same params as book_slot_atomic
  p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
  p_date date, p_time text, p_party_size int, p_max_capacity int,
  p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text,
  p_guest_name text, p_guest_phone text, p_guest_email text,
  p_special_requests text, p_venue_address text, p_end_date date,
  p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text,
  p_location_id uuid DEFAULT NULL,
  p_appointment_id uuid DEFAULT NULL,
  p_buffer_minutes integer DEFAULT 0,
  p_duration integer DEFAULT 30,
  p_bot_session_id uuid DEFAULT NULL,
  -- Package-specific params
  p_enrollment_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=public,extensions AS $$
 SELECT scheduling_private_604.create_booking(jsonb_build_object('business_id',p_business_id,'user_id',p_user_id,'service_id',p_service_id,'staff_id',p_staff_id,'date',p_date,'time',p_time,'party_size',p_party_size,'flow_type',p_flow_type,'deposit_amount',p_deposit_amount,'deposit_status',p_deposit_status,'status',p_status,'guest_name',p_guest_name,'guest_phone',p_guest_phone,'guest_email',p_guest_email,'special_requests',p_special_requests,'venue_address',p_venue_address,'end_date',p_end_date,'addons_snapshot',p_addons_snapshot,'promo_code_id',p_promo_code_id,'total_amount',p_total_amount,'staff_name',p_staff_name,'location_id',p_location_id,'appointment_id',p_appointment_id,'bot_session_id',p_bot_session_id),'legacy_package',p_enrollment_id);
$$;

CREATE FUNCTION public.book_with_package_authoritative_604(
  -- Same params as book_slot_atomic
  p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
  p_date date, p_time text, p_party_size int, p_max_capacity int,
  p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text,
  p_guest_name text, p_guest_phone text, p_guest_email text,
  p_special_requests text, p_venue_address text, p_end_date date,
  p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text,
  p_location_id uuid DEFAULT NULL,
  p_appointment_id uuid DEFAULT NULL,
  p_buffer_minutes integer DEFAULT 0,
  p_duration integer DEFAULT 30,
  p_bot_session_id uuid DEFAULT NULL,
  -- Package-specific params
  p_enrollment_id uuid DEFAULT NULL,
 p_class_session_id uuid DEFAULT NULL, p_expected_terms jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=public,extensions AS $$
 SELECT scheduling_private_604.create_booking(jsonb_build_object('business_id',p_business_id,'user_id',p_user_id,'service_id',p_service_id,'staff_id',p_staff_id,'date',p_date,'time',p_time,'party_size',p_party_size,'flow_type',p_flow_type,'deposit_amount',p_deposit_amount,'deposit_status',p_deposit_status,'status',p_status,'guest_name',p_guest_name,'guest_phone',p_guest_phone,'guest_email',p_guest_email,'special_requests',p_special_requests,'venue_address',p_venue_address,'end_date',p_end_date,'addons_snapshot',p_addons_snapshot,'promo_code_id',p_promo_code_id,'total_amount',p_total_amount,'staff_name',p_staff_name,'location_id',p_location_id,'appointment_id',p_appointment_id,'bot_session_id',p_bot_session_id,'class_session_id',p_class_session_id,'expected_terms',p_expected_terms),'customer',p_enrollment_id);
$$;
REVOKE ALL ON FUNCTION public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb) TO service_role;

CREATE FUNCTION scheduling_private_604.finalize_booking_promo(p_booking_id uuid,p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE b record; pay record; res record;
BEGIN
 SELECT * INTO b FROM public.bookings WHERE id=p_booking_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('finalized',false,'reason','booking_not_found'); END IF;
 IF b.promo_code_id IS NULL THEN RETURN jsonb_build_object('finalized',true,'not_applicable',true); END IF;
 IF b.metadata->'scheduling_authority_604' IS NULL THEN
   RETURN jsonb_build_object('finalized',true,'legacy',true);
 END IF;
 IF b.status::text IN ('cancelled','no_show') THEN RETURN jsonb_build_object('finalized',false,'reason','booking_not_payable'); END IF;
 SELECT * INTO pay FROM public.payments WHERE id=p_payment_id FOR SHARE;
 IF NOT FOUND OR pay.booking_id IS DISTINCT FROM b.id OR pay.business_id IS DISTINCT FROM b.business_id
   OR pay.status::text<>'success' OR b.deposit_status::text<>'paid' THEN
   RETURN jsonb_build_object('finalized',false,'reason','verified_payment_required');
 END IF;
 PERFORM 1 FROM public.promo_codes WHERE id=b.promo_code_id FOR UPDATE;
 SELECT * INTO res FROM public.promo_reservations WHERE booking_id=b.id FOR UPDATE;
 IF NOT FOUND OR res.promo_code_id IS DISTINCT FROM b.promo_code_id OR res.state='released' THEN
   RETURN jsonb_build_object('finalized',false,'reason','reservation_unavailable');
 END IF;
 IF res.state='reserved' THEN
   UPDATE public.promo_reservations SET state='finalized',updated_at=now() WHERE id=res.id;
   UPDATE public.promo_codes SET current_uses=COALESCE(current_uses,0)+1 WHERE id=res.promo_code_id;
 END IF;
 RETURN jsonb_build_object('finalized',true);
END;
$$;
REVOKE ALL ON FUNCTION scheduling_private_604.finalize_booking_promo(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION scheduling_private_604.finalize_booking_promo(uuid,uuid) TO service_role;
CREATE FUNCTION public.finalize_booking_promo_reservation(p_booking_id uuid,p_payment_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=public,extensions AS $$
 SELECT scheduling_private_604.finalize_booking_promo(p_booking_id,p_payment_id);
$$;
REVOKE ALL ON FUNCTION public.finalize_booking_promo_reservation(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_booking_promo_reservation(uuid,uuid) TO service_role;

-- Raw cancellation/expiry updates use the same durable reservation transition.
-- This does not replace M357's owner checks, package release or slot accounting.
CREATE FUNCTION scheduling_private_604.booking_promo_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE result jsonb;
BEGIN
 IF NEW.metadata->'scheduling_authority_604' IS NULL OR NEW.promo_code_id IS NULL THEN RETURN NEW; END IF;
 IF NEW.deposit_status::text='paid' AND OLD.deposit_status::text IS DISTINCT FROM 'paid' THEN
   result:=scheduling_private_604.finalize_booking_promo(NEW.id,NEW.payment_id);
   IF result->>'finalized' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'booking_promo_finalization_failed'; END IF;
 ELSIF NEW.status::text='cancelled' AND OLD.status::text IS DISTINCT FROM 'cancelled'
       AND OLD.deposit_status::text IS DISTINCT FROM 'paid' THEN
   PERFORM 1 FROM public.promo_codes WHERE id=NEW.promo_code_id FOR UPDATE;
   UPDATE public.promo_reservations SET state='released',updated_at=now()
     WHERE booking_id=NEW.id AND state='reserved';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION scheduling_private_604.booking_promo_transition() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER booking_promo_transition_604 AFTER UPDATE OF status,deposit_status ON public.bookings
 FOR EACH ROW EXECUTE FUNCTION scheduling_private_604.booking_promo_transition();

DO $$
DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid,p.prosecdef,p.proconfig,p.proname FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='scheduling_private_604'
 LOOP
   IF f.prosecdef AND f.proname<>'book_slot_atomic'
      AND NOT ('search_path=public, extensions'=ANY(f.proconfig)) THEN
     RAISE EXCEPTION 'M497 invalid helper search_path';
   END IF;
   IF has_function_privilege('anon',f.oid,'EXECUTE') OR has_function_privilege('authenticated',f.oid,'EXECUTE') THEN
     RAISE EXCEPTION 'M497 unexpected helper execute grant';
   END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='book_slot_atomic')<>1 THEN
   RAISE EXCEPTION 'M497 legacy signature ambiguity';
 END IF;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
