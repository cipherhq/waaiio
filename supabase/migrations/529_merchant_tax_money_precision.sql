-- #980: exact major-currency decimal storage for merchant tax integration.
-- DRAFT / NOT APPLIED. No historical value is multiplied or divided.
-- Explicit replacements below are based on read-only catalog snapshots at M527.
-- Existing discount/flat-fee rounding policy and provider minor-unit integers stay unchanged.
BEGIN;

-- Refuse unknown function drift; do not overwrite another lane's correction.
DO $guard$
DECLARE expected record; actual text;
BEGIN
  actual := md5(pg_get_functiondef(to_regprocedure('private.scheduling_604_create_booking(jsonb,text,uuid)')));
  IF actual IS NULL OR actual NOT IN ('89e60c176f2b174d7977e2a42566f743') THEN
    RAISE EXCEPTION 'M529 source drift: private.scheduling_604_create_booking';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('private.scheduling_604_quote(uuid,uuid,uuid,integer,jsonb,uuid,jsonb)')));
  IF actual IS NULL OR actual NOT IN ('2be5504d9e1d80bd2c63dc15d0adf470') THEN
    RAISE EXCEPTION 'M529 source drift: private.scheduling_604_quote';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.apply_payment_customer_visit_once(uuid)')));
  IF actual IS NULL OR actual NOT IN ('a9fddbc28b66d4706bb55e5cc600c73d') THEN
    RAISE EXCEPTION 'M529 source drift: public.apply_payment_customer_visit_once';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,integer,integer,uuid,uuid,jsonb)')));
  IF actual IS NULL OR actual NOT IN ('5bb2ea6189c4deea7bcd6973552c67b0') THEN
    RAISE EXCEPTION 'M529 source drift: public.book_manual_slot_authoritative_604';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer,jsonb)')));
  IF actual IS NULL OR actual NOT IN ('404d35c564762a7bbe39a0204ee19bd1') THEN
    RAISE EXCEPTION 'M529 source drift: public.book_slot_authoritative_604';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb)')));
  IF actual IS NULL OR actual NOT IN ('9d237b8ff11040d0de0d8fc4e2f13541') THEN
    RAISE EXCEPTION 'M529 source drift: public.book_with_package_authoritative_604';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.claim_payment_finalization_with_verified_fee(uuid,text,text,numeric,text,boolean,numeric)')));
  IF actual IS NULL OR actual NOT IN ('294846cd6d7efbe8c65fff128efb5633') THEN
    RAISE EXCEPTION 'M529 source drift: public.claim_payment_finalization_with_verified_fee';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean)')));
  IF actual IS NULL OR actual NOT IN ('f067876bf3a00a76f3d07492c34cc62b') THEN
    RAISE EXCEPTION 'M529 source drift: public.confirm_nonorder_transfer_atomic';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.create_catalog_order_atomic(uuid,uuid,text,text,text,jsonb)')));
  IF actual IS NULL OR actual NOT IN ('5e23a92cfbbadf3668b9d3d2778a47c9') THEN
    RAISE EXCEPTION 'M529 source drift: public.create_catalog_order_atomic';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.create_order_atomic(uuid,uuid,uuid,text,text,text,integer,integer,integer,uuid,text,text,uuid,text,integer,integer,text,text,text,text,jsonb,uuid,boolean,integer)')));
  IF actual IS NULL OR actual NOT IN ('3a8b1027dc0ad6ccc037deb81b295ab8') THEN
    RAISE EXCEPTION 'M529 source drift: public.create_order_atomic';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer)')));
  IF actual IS NULL OR actual NOT IN ('a2f456faee58526042ceaab829f570cc') THEN
    RAISE EXCEPTION 'M529 source drift: public.book_slot_atomic';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.get_business_revenue(uuid)')));
  IF actual IS NULL OR actual NOT IN ('02223b6d0295a77f0d6068ff29b8054d') THEN
    RAISE EXCEPTION 'M529 source drift: public.get_business_revenue';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.get_business_revenue_totals(uuid)')));
  IF actual IS NULL OR actual NOT IN ('3fed03ac6a0971ef3241ae3a5081dd7d','d9c2963d1c4933b86767c48c5076ae9b') THEN
    RAISE EXCEPTION 'M529 source drift: public.get_business_revenue_totals';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.get_business_transactions(uuid,integer,integer)')));
  IF actual IS NULL OR actual NOT IN ('82be90e8b89c9ec942c2c4b1e3030c0e','c754355fe1df7453defcc90abfe16c4f') THEN
    RAISE EXCEPTION 'M529 source drift: public.get_business_transactions';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.get_customer_history(uuid,uuid,integer)')));
  IF actual IS NULL OR actual NOT IN ('d162bced7f941646f538ad57f9d46886','e8f2f1c096a131c852a5997f7beef973') THEN
    RAISE EXCEPTION 'M529 source drift: public.get_customer_history';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.get_order_revenue(uuid)')));
  IF actual IS NULL OR actual NOT IN ('3f0dd33cf8b5f26d53f129f98f374ac3') THEN
    RAISE EXCEPTION 'M529 source drift: public.get_order_revenue';
  END IF;
  actual := md5(pg_get_functiondef(to_regprocedure('public.accept_order_quote_atomic(uuid,text)')));
  IF actual IS NULL OR actual NOT IN ('d92224be02f266f5e1c3a09feefa9085') THEN
    RAISE EXCEPTION 'M529 source drift: public.accept_order_quote_atomic';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('private.scheduling_604_create_booking(jsonb,text,uuid)')) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: scheduling_604_create_booking'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname='scheduling_604_create_booking') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: scheduling_604_create_booking'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('private.scheduling_604_quote(uuid,uuid,uuid,integer,jsonb,uuid,jsonb)')) IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: scheduling_604_quote'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname='scheduling_604_quote') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: scheduling_604_quote'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.apply_payment_customer_visit_once(uuid)')) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: apply_payment_customer_visit_once'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='apply_payment_customer_visit_once') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: apply_payment_customer_visit_once'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,integer,integer,uuid,uuid,jsonb)')) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: book_manual_slot_authoritative_604'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='book_manual_slot_authoritative_604') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: book_manual_slot_authoritative_604'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer,jsonb)')) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: book_slot_authoritative_604'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='book_slot_authoritative_604') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: book_slot_authoritative_604'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb)')) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: book_with_package_authoritative_604'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='book_with_package_authoritative_604') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: book_with_package_authoritative_604'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.claim_payment_finalization_with_verified_fee(uuid,text,text,numeric,text,boolean,numeric)')) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: claim_payment_finalization_with_verified_fee'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='claim_payment_finalization_with_verified_fee') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: claim_payment_finalization_with_verified_fee'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean)')) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: confirm_nonorder_transfer_atomic'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='confirm_nonorder_transfer_atomic') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: confirm_nonorder_transfer_atomic'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.create_catalog_order_atomic(uuid,uuid,text,text,text,jsonb)')) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: create_catalog_order_atomic'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_catalog_order_atomic') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: create_catalog_order_atomic'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.create_order_atomic(uuid,uuid,uuid,text,text,text,integer,integer,integer,uuid,text,text,uuid,text,integer,integer,text,text,text,text,jsonb,uuid,boolean,integer)')) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: create_order_atomic'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_order_atomic') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: create_order_atomic'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer)')) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: book_slot_atomic'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='book_slot_atomic') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: book_slot_atomic'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.get_business_revenue(uuid)')) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: get_business_revenue'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_business_revenue') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: get_business_revenue'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.get_business_revenue_totals(uuid)')) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: get_business_revenue_totals'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_business_revenue_totals') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: get_business_revenue_totals'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.get_business_transactions(uuid,integer,integer)')) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: get_business_transactions'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_business_transactions') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: get_business_transactions'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.get_customer_history(uuid,uuid,integer)')) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: get_customer_history'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_customer_history') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: get_customer_history'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.get_order_revenue(uuid)')) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: get_order_revenue'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_order_revenue') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: get_order_revenue'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.accept_order_quote_atomic(uuid,text)')) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'M529 grant drift: accept_order_quote_atomic'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='accept_order_quote_atomic') <> 1 THEN RAISE EXCEPTION 'M529 unexpected overload: accept_order_quote_atomic'; END IF;
END $guard$;

ALTER TABLE public.payments
  ALTER COLUMN amount TYPE numeric(20,2) USING amount::numeric(20,2),
  ALTER COLUMN gateway_fee TYPE numeric(20,2) USING gateway_fee::numeric(20,2),
  ALTER COLUMN verified_gateway_fee TYPE numeric(20,2) USING verified_gateway_fee::numeric(20,2),
  ALTER COLUMN gateway_fee_claim_snapshot TYPE numeric(20,2) USING gateway_fee_claim_snapshot::numeric(20,2);
ALTER TABLE public.platform_fees
  ALTER COLUMN transaction_amount TYPE numeric(20,2) USING transaction_amount::numeric(20,2),
  ALTER COLUMN fee_total TYPE numeric(20,2) USING fee_total::numeric(20,2),
  ALTER COLUMN fee_flat TYPE numeric(20,2) USING fee_flat::numeric(20,2),
  ALTER COLUMN gateway_fee TYPE numeric(20,2) USING gateway_fee::numeric(20,2),
  ALTER COLUMN reseller_commission TYPE numeric(20,2) USING reseller_commission::numeric(20,2);
ALTER TABLE public.orders
  ALTER COLUMN total_amount TYPE numeric(20,2) USING total_amount::numeric(20,2),
  ALTER COLUMN platform_fee TYPE numeric(20,2) USING platform_fee::numeric(20,2),
  ALTER COLUMN discount_amount TYPE numeric(20,2) USING discount_amount::numeric(20,2),
  ALTER COLUMN shipping_cost TYPE numeric(20,2) USING shipping_cost::numeric(20,2),
  ALTER COLUMN addons_total TYPE numeric(20,2) USING addons_total::numeric(20,2),
  ALTER COLUMN volume_discount_amount TYPE numeric(20,2) USING volume_discount_amount::numeric(20,2),
  ALTER COLUMN deposit_amount TYPE numeric(20,2) USING deposit_amount::numeric(20,2),
  ALTER COLUMN balance_amount TYPE numeric(20,2) USING balance_amount::numeric(20,2);
ALTER TABLE public.bookings
  ALTER COLUMN deposit_amount TYPE numeric(20,2) USING deposit_amount::numeric(20,2),
  ALTER COLUMN total_amount TYPE numeric(20,2) USING total_amount::numeric(20,2),
  ALTER COLUMN platform_fee TYPE numeric(20,2) USING platform_fee::numeric(20,2),
  ALTER COLUMN discount_amount TYPE numeric(20,2) USING discount_amount::numeric(20,2);
ALTER TABLE public.order_items
  ALTER COLUMN unit_price TYPE numeric(20,2) USING unit_price::numeric(20,2);
ALTER TABLE public.quote_requests
  ALTER COLUMN estimated_subtotal TYPE numeric(20,2) USING estimated_subtotal::numeric(20,2),
  ALTER COLUMN quoted_amount TYPE numeric(20,2) USING quoted_amount::numeric(20,2);
ALTER TABLE public.payment_spend_applications
  ALTER COLUMN amount TYPE numeric(20,2) USING amount::numeric(20,2);
ALTER TABLE public.payment_visit_applications
  ALTER COLUMN visit_amount TYPE numeric(20,2) USING visit_amount::numeric(20,2);

-- Drop old signatures first, without CASCADE: dependent objects must be reviewed.
DROP FUNCTION public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,integer,integer,uuid,uuid,jsonb);
DROP FUNCTION public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer,jsonb);
DROP FUNCTION public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb);
DROP FUNCTION public.create_order_atomic(uuid,uuid,uuid,text,text,text,integer,integer,integer,uuid,text,text,uuid,text,integer,integer,text,text,text,text,jsonb,uuid,boolean,integer);
DROP FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer);
DROP FUNCTION public.get_business_revenue(uuid);
DROP FUNCTION public.get_business_revenue_totals(uuid);
DROP FUNCTION public.get_business_transactions(uuid,integer,integer);
DROP FUNCTION public.get_customer_history(uuid,uuid,integer);
DROP FUNCTION public.get_order_revenue(uuid);

-- public.book_slot_atomic: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.book_slot_atomic(p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid, p_date date, p_time text, p_party_size integer, p_max_capacity integer, p_flow_type text, p_deposit_amount numeric, p_deposit_status text, p_status text, p_guest_name text, p_guest_phone text, p_guest_email text, p_special_requests text, p_venue_address text, p_end_date date, p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount numeric, p_staff_name text, p_location_id uuid DEFAULT NULL::uuid, p_appointment_id uuid DEFAULT NULL::uuid, p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30, p_bot_session_id uuid DEFAULT NULL::uuid, p_class_session_id uuid DEFAULT NULL::uuid, p_expected_price numeric DEFAULT NULL::integer, p_expected_deposit numeric DEFAULT NULL::integer)
 RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count int; v_buffer_count int; v_booking_id uuid; v_ref text;
  v_lock_key bigint; v_sched_allowed boolean; v_sched_reason text;
  v_requires_staff boolean; v_cs record; v_occupied bigint;
  v_cs_duration integer; v_canonical_staff_name text;
  v_service RECORD;
  v_effective_max_capacity int;
  v_effective_buffer int;
  v_effective_duration int;
  v_committed_deposit numeric;
  v_committed_total numeric;
  v_service_validated boolean := false;
BEGIN
  -- ── Bot session idempotency ──
  IF p_bot_session_id IS NOT NULL THEN
    SELECT id, bookings.reference_code INTO v_booking_id, v_ref
    FROM bookings WHERE bot_session_id = p_bot_session_id AND status IN ('pending', 'confirmed') LIMIT 1;
    IF FOUND THEN RETURN QUERY SELECT v_booking_id, v_ref, true; RETURN; END IF;
  END IF;

  -- ── Service revalidation (when p_expected_price IS NOT NULL) ──
  IF p_expected_price IS NOT NULL AND p_service_id IS NOT NULL THEN
    SELECT id, price, deposit_amount, is_active, max_capacity, duration_minutes,
           business_id, metadata
    INTO v_service
    FROM services WHERE id = p_service_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'service_not_found:Service % does not exist', p_service_id;
    END IF;
    IF NOT v_service.is_active THEN
      RAISE EXCEPTION 'service_unavailable:Service % is not active', p_service_id;
    END IF;
    IF v_service.business_id != p_business_id THEN
      RAISE EXCEPTION 'service_wrong_business:Service % does not belong to this business', p_service_id;
    END IF;
    IF v_service.price != p_expected_price THEN
      RAISE EXCEPTION 'price_changed:Service price changed from % to %', p_expected_price, v_service.price;
    END IF;
    IF p_expected_deposit IS NOT NULL AND v_service.deposit_amount != p_expected_deposit THEN
      RAISE EXCEPTION 'deposit_changed:Service deposit changed from % to %', p_expected_deposit, v_service.deposit_amount;
    END IF;

    v_effective_max_capacity := COALESCE(v_service.max_capacity, p_max_capacity);
    v_effective_buffer := COALESCE((v_service.metadata->>'buffer_minutes')::int, p_buffer_minutes);
    v_effective_duration := COALESCE(v_service.duration_minutes, p_duration);
    v_service_validated := true;
  ELSE
    v_effective_max_capacity := p_max_capacity;
    v_effective_buffer := p_buffer_minutes;
    v_effective_duration := p_duration;
  END IF;

  -- ── Class session path (unchanged) ──
  IF p_class_session_id IS NOT NULL THEN
    IF p_service_id IS NULL THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF p_appointment_id IS NOT NULL THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    v_lock_key := abs(hashtext('class_session:' || p_class_session_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);
    SELECT cs.id, cs.business_id, cs.service_id, cs.date, cs.start_time,
           cs.capacity, cs.status, cs.staff_id, cs.location_id,
           s.is_class, s.requires_staff, s.duration_minutes, s.is_active AS svc_active,
           s.price AS svc_price, s.deposit_amount AS svc_deposit
    INTO v_cs FROM class_sessions cs JOIN services s ON s.id = cs.service_id
    WHERE cs.id = p_class_session_id;
    IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF v_cs.business_id != p_business_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF v_cs.service_id != p_service_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF NOT COALESCE(v_cs.is_class, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF NOT COALESCE(v_cs.svc_active, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF v_cs.status != 'scheduled' THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    v_cs_duration := COALESCE(v_cs.duration_minutes, 60);
    IF v_cs.staff_id IS NOT NULL THEN
      IF p_staff_id IS NOT NULL AND p_staff_id != v_cs.staff_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
      SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(v_cs.staff_id, p_business_id, v_cs.date, v_cs.start_time::text, v_cs_duration) csa;
      IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
      SELECT bs.name INTO v_canonical_staff_name FROM business_staff bs WHERE bs.id = v_cs.staff_id;
    ELSE
      IF COALESCE(v_cs.requires_staff, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
      v_canonical_staff_name := NULL;
    END IF;
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied FROM bookings b WHERE b.class_session_id = p_class_session_id AND b.status IN ('confirmed', 'pending', 'in_progress');
    IF v_occupied + p_party_size > v_cs.capacity THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    v_committed_deposit := CASE WHEN p_expected_price IS NOT NULL
      THEN COALESCE(v_cs.svc_deposit, 0) ELSE p_deposit_amount END;
    v_committed_total := CASE WHEN p_expected_price IS NOT NULL
      THEN COALESCE(v_cs.svc_price, 0) ELSE p_total_amount END;
    INSERT INTO bookings (business_id, user_id, service_id, appointment_id, staff_id, staff_name, date, time, party_size, flow_type, channel, deposit_amount, deposit_status, status, guest_name, guest_phone, guest_email, special_requests, venue_address, end_date, addons_snapshot, promo_code_id, total_amount, quantity, location_id, bot_session_id, class_session_id)
    VALUES (p_business_id, p_user_id, v_cs.service_id, NULL, v_cs.staff_id, v_canonical_staff_name, v_cs.date, v_cs.start_time, p_party_size, p_flow_type::flow_type, 'whatsapp'::booking_channel, v_committed_deposit, p_deposit_status::deposit_status, p_status::reservation_status, p_guest_name, p_guest_phone, p_guest_email, p_special_requests, p_venue_address, p_end_date, p_addons_snapshot, p_promo_code_id, v_committed_total, p_party_size, v_cs.location_id, p_bot_session_id, p_class_session_id)
    RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;
    RETURN QUERY SELECT v_booking_id, v_ref, true; RETURN;
  END IF;

  -- ── Standard booking path ──
  IF p_service_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM services WHERE id = p_service_id AND is_class = true) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  IF p_appointment_id IS NOT NULL THEN
    SELECT cas.allowed INTO v_sched_allowed FROM check_appointment_schedule(p_appointment_id, p_business_id, p_date, p_time) cas;
    IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  IF p_staff_id IS NOT NULL THEN
    SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(p_staff_id, p_business_id, p_date, p_time, COALESCE(v_effective_duration, 30)) csa;
    IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  IF p_staff_id IS NULL THEN
    v_requires_staff := false;
    IF p_appointment_id IS NOT NULL THEN SELECT COALESCE(a.requires_staff, false) INTO v_requires_staff FROM appointments a WHERE a.id = p_appointment_id;
    ELSIF p_service_id IS NOT NULL THEN SELECT COALESCE(s.requires_staff, false) INTO v_requires_staff FROM services s WHERE s.id = p_service_id;
    END IF;
    IF v_requires_staff THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  v_lock_key := abs(hashtext(p_business_id::text || '|' || p_date::text || '|' || p_time::time::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- ── Capacity check: EXCLUDE table reservations (seating_resource_id IS NOT NULL) ──
  SELECT COUNT(*) INTO v_count FROM bookings
  WHERE business_id = p_business_id AND date = p_date AND time = p_time::time
    AND status IN ('confirmed', 'pending', 'in_progress')
    AND seating_resource_id IS NULL
    AND (p_staff_id IS NULL OR staff_id = p_staff_id);
  IF v_count >= v_effective_max_capacity THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;

  -- ── Buffer check: EXCLUDE table reservations ──
  IF v_effective_buffer > 0 THEN
    SELECT COUNT(*) INTO v_buffer_count FROM bookings
    WHERE business_id = p_business_id AND date = p_date
      AND status IN ('pending', 'confirmed', 'in_progress')
      AND seating_resource_id IS NULL
      AND (p_staff_id IS NULL OR staff_id = p_staff_id)
      AND time != p_time::time
      AND (p_time::time < (time + make_interval(mins => COALESCE(v_effective_duration, 30) + v_effective_buffer))
       AND (p_time::time + make_interval(mins => COALESCE(v_effective_duration, 30))) > (time - make_interval(mins => v_effective_buffer)));
    IF v_buffer_count > 0 THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;

  IF v_service_validated THEN
    v_committed_deposit := v_service.deposit_amount;
    v_committed_total := v_service.price;
  ELSE
    v_committed_deposit := p_deposit_amount;
    v_committed_total := p_total_amount;
  END IF;

  INSERT INTO bookings (business_id, user_id, service_id, appointment_id, staff_id, staff_name, date, time, party_size, flow_type, channel, deposit_amount, deposit_status, status, guest_name, guest_phone, guest_email, special_requests, venue_address, end_date, addons_snapshot, promo_code_id, total_amount, quantity, location_id, bot_session_id)
  VALUES (p_business_id, p_user_id, CASE WHEN p_appointment_id IS NOT NULL THEN NULL ELSE p_service_id END, p_appointment_id, p_staff_id, p_staff_name, p_date, p_time::time, p_party_size, p_flow_type::flow_type, 'whatsapp'::booking_channel, v_committed_deposit, p_deposit_status::deposit_status, p_status::reservation_status, p_guest_name, p_guest_phone, p_guest_email, p_special_requests, p_venue_address, p_end_date, p_addons_snapshot, p_promo_code_id, v_committed_total, p_party_size, p_location_id, p_bot_session_id)
  RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;
  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$function$
;
ALTER FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric) TO service_role;

-- private.scheduling_604_quote: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION private.scheduling_604_quote(p_business uuid, p_service uuid, p_appointment uuid, p_party integer, p_addons jsonb, p_promo uuid, p_expected jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  b record; item jsonb; addon record; promo record; selected jsonb;
  unit_price numeric; unit_deposit numeric; discount numeric := 0;
  addon_total numeric := 0; total numeric; due numeric; reserved bigint;
  mode text; prepay boolean; item_id uuid := COALESCE(p_service,p_appointment);
  raw_price numeric; raw_deposit numeric; variable boolean; bot_claim boolean;
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
  -- appointments.price/deposit_amount are numeric: accept whole amounts such as 1500.00.
  raw_price := COALESCE((item->>'price')::numeric,0);
  raw_deposit := COALESCE((item->>'deposit_amount')::numeric,0);
  IF raw_price<>trunc(raw_price) OR raw_deposit<>trunc(raw_deposit)
     OR raw_price>2147483647 OR raw_deposit>2147483647 THEN RAISE EXCEPTION 'invalid_item_terms'; END IF;
  unit_price := raw_price::numeric;
  unit_deposit := raw_deposit::numeric;
  variable := COALESCE((item->>'price_is_variable')::boolean,false);
  -- Set only by create_booking from the bot session's confirmation claim; callers cannot set it.
  bot_claim := p_expected->>'bot_claim' = 'true';
  -- "Price varies" items (Owner decision 2026-11-05, option A):
  --  * WhatsApp bookings carry a confirmed session claim; the confirmed amount is
  --    used, never below the stored starting price.
  --  * Public page and dashboard bookings have no claim and book at the stored
  --    starting price, as before M518. The terms check below then requires the
  --    caller's expected price to equal that stored price.
  IF variable AND bot_claim THEN
    IF (p_expected->>'price')::numeric IS NULL OR (p_expected->>'price')::numeric<unit_price THEN
       RAISE EXCEPTION 'verified_quote_required';
    END IF;
    unit_price := (p_expected->>'price')::numeric;
  END IF;
  IF unit_price < 0 OR unit_deposit < 0 THEN RAISE EXCEPTION 'invalid_item_terms'; END IF;
  IF p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object'
     OR p_expected->>'price' IS NULL OR p_expected->>'deposit' IS NULL
     OR (p_expected->>'price')::numeric IS DISTINCT FROM unit_price
     OR (p_expected->>'deposit')::numeric IS DISTINCT FROM unit_deposit
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
       OR addon.price < 0 OR (selected->>'price')::numeric IS DISTINCT FROM addon.price THEN
      RAISE EXCEPTION 'addon_terms_changed';
    END IF;
    addon_total := addon_total + addon.price;
  END LOOP;
  -- Required add-ons are offered and chosen only in the WhatsApp flow. The public
  -- page and dashboard never collected them, and keep booking such services as before.
  IF bot_claim AND EXISTS (SELECT 1 FROM public.service_addons a WHERE a.business_id=p_business AND a.is_active
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
      discount := LEAST(unit_price,round(unit_price::numeric*promo.discount_value/100)::numeric);
    ELSIF promo.discount_type='fixed' AND promo.discount_value>0 THEN
      discount := LEAST(unit_price,round(promo.discount_value)::numeric);
    ELSE RAISE EXCEPTION 'invalid_promo'; END IF;
  END IF;
  IF (p_expected->>'discount')::numeric IS DISTINCT FROM discount THEN RAISE EXCEPTION 'terms_changed'; END IF;
  -- Existing fixed discount applies to each participant's service, never addons.
  total := (unit_price::numeric-discount)*p_party + addon_total;
  mode := COALESCE(b.metadata->>'prepay_mode','auto');
  prepay := mode='full' OR (mode='auto' AND b.category::text=ANY(ARRAY[
    'barber','spa','salon','tattoo','gym','clinic','dental','veterinary','consultant',
    'tutor','photographer','car_wash','laundry','coworking']));
  IF p_expected->>'source'='public' THEN due:=COALESCE(NULLIF(unit_deposit,0),unit_price)::numeric*p_party;
  ELSIF mode='free' THEN due:=0;
  -- Fixed price: deposit capped at the discounted service value, add-ons excluded
  -- (resolveRuntimeDeposit, #376). "Price varies": the configured deposit, uncapped.
  ELSIF unit_deposit>0 THEN due:=CASE WHEN variable THEN unit_deposit
    ELSE LEAST(unit_deposit,(unit_price::numeric-discount)*p_party) END;
  ELSIF COALESCE(b.deposit_per_guest,0)>0 THEN due:=b.deposit_per_guest::numeric*p_party;
  ELSIF prepay THEN due:=total;
  ELSE due:=0; END IF;
  -- The final total/due relation is settled in create_booking, after manual and
  -- package bookings set the amount due to zero.
  IF total>2147483647 OR due>2147483647 THEN RAISE EXCEPTION 'invalid_booking_amount'; END IF;
  RETURN jsonb_build_object('total',total,'deposit',due,'price',unit_price,'variable',variable,
    'zero_item',NOT variable AND unit_price=0 AND unit_deposit=0,
    'item_deposit',unit_deposit,'discount',discount,'country',b.country_code,
    'capacity',CASE WHEN item->'metadata'->>'is_dropoff'='true' THEN 9999 ELSE COALESCE((item->>'max_capacity')::integer,1) END,
    'buffer',COALESCE((item->>'buffer_minutes')::integer,(item->'metadata'->>'buffer_minutes')::integer,0),
    'duration',COALESCE((item->>'duration_minutes')::integer,30),
    'auto_approve',COALESCE((item->>'auto_approve')::boolean,true));
END;
$function$
;
ALTER FUNCTION private.scheduling_604_quote(uuid,uuid,uuid,integer,jsonb,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.scheduling_604_quote(uuid,uuid,uuid,integer,jsonb,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- private.scheduling_604_create_booking: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION private.scheduling_604_create_booking(p jsonb, p_mode text DEFAULT 'customer'::text, p_enrollment uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  b public.bookings%ROWTYPE; existing public.bookings%ROWTYPE;
  session_row record; enrollment record; package record; cs record;
  q jsonb; r record; expected jsonb := p->'expected_terms'; claim jsonb;
  due numeric; total numeric; final_status text; selected jsonb;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('customer','manual') THEN RAISE EXCEPTION 'invalid_booking_mode'; END IF;
  SELECT * INTO b FROM jsonb_populate_record(NULL::public.bookings,p);
  IF b.flow_type::text IS DISTINCT FROM 'scheduling' THEN RAISE EXCEPTION 'unsupported_booking_flow'; END IF;
  IF b.bot_session_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('scheduling604:'||b.bot_session_id::text,0));
    SELECT * INTO session_row FROM public.bot_sessions WHERE id=b.bot_session_id FOR SHARE;
    IF (NOT FOUND OR session_row.business_id IS DISTINCT FROM b.business_id
      OR session_row.user_id IS DISTINCT FROM b.user_id
      OR ltrim(session_row.whatsapp_number,'+') IS DISTINCT FROM ltrim(b.guest_phone,'+')) THEN
      RAISE EXCEPTION 'booking_identity_mismatch';
    END IF;
    SELECT * INTO existing FROM public.bookings WHERE bot_session_id=b.bot_session_id
      AND status::text IN ('pending','confirmed')
      ORDER BY created_at DESC, id DESC LIMIT 1;
    IF FOUND THEN
      IF existing.metadata->'scheduling_authority_604'->'request' IS DISTINCT FROM p
        OR existing.metadata->'scheduling_authority_604'->>'enrollment' IS DISTINCT FROM p_enrollment::text THEN
        RAISE EXCEPTION 'booking_intent_changed';
      END IF;
      RETURN jsonb_build_object('booking_id',existing.id,'reference_code',existing.reference_code,
        'slot_available',true,'committed_total',existing.total_amount,'committed_deposit',existing.deposit_amount,
        'package_covered',p_enrollment IS NOT NULL,'success',true);
    END IF;
    claim := session_row.session_data->'_604_confirmation';
    IF claim IS NULL OR claim->>'service_id' IS DISTINCT FROM COALESCE(b.service_id,b.appointment_id)::text
      OR claim->>'date' IS DISTINCT FROM b.date::text
      OR (claim->>'party_size')::integer IS DISTINCT FROM b.party_size
      OR claim->>'time' IS DISTINCT FROM b.time::text
      OR claim->'terms' IS DISTINCT FROM expected THEN RAISE EXCEPTION 'booking_confirmation_required'; END IF;
  END IF;
  q := private.scheduling_604_quote(b.business_id,b.service_id,b.appointment_id,b.party_size,b.addons_snapshot,b.promo_code_id,expected||jsonb_build_object('bot_claim',claim IS NOT NULL));
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
  total := (q->>'total')::numeric;
  due := (q->>'deposit')::numeric;
  IF p_mode='manual' OR p_enrollment IS NOT NULL THEN due:=0; END IF;
  -- Totals as the bot computed them before M518 (scheduling.flow.ts bookingTotalAmount):
  --  * "price varies": at least the amount due upfront (also today's public page);
  --  * no price and no item deposit (e.g. a per-guest business deposit): the amount due.
  IF (q->>'variable')::boolean AND due>total THEN total:=due; END IF;
  IF (q->>'zero_item')::boolean THEN total:=due; END IF;
  IF due>total THEN RAISE EXCEPTION 'invalid_booking_amount'; END IF;
  IF b.total_amount IS DISTINCT FROM total OR b.deposit_amount IS DISTINCT FROM due THEN RAISE EXCEPTION 'terms_changed'; END IF;
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
  final_status := CASE WHEN p_mode='manual' THEN 'confirmed' WHEN due>0 THEN 'pending'
    WHEN (q->>'auto_approve')::boolean THEN 'confirmed' ELSE 'pending' END;
  SELECT * INTO r FROM public.book_slot_atomic(
    b.business_id,b.user_id,b.service_id,b.staff_id,b.date,b.time::text,b.party_size,(q->>'capacity')::integer,
    'scheduling',due,CASE WHEN due>0 THEN 'pending' ELSE 'none' END,final_status,
    b.guest_name,b.guest_phone,b.guest_email,b.special_requests,b.venue_address,b.end_date,
    b.addons_snapshot,b.promo_code_id,total,b.staff_name,b.location_id,b.appointment_id,
    (q->>'buffer')::integer,(q->>'duration')::integer,b.bot_session_id,b.class_session_id,NULL,NULL);
  IF r.slot_available IS NOT TRUE THEN RETURN jsonb_build_object('slot_available',false,'success',false,'reason','slot_full'); END IF;
  UPDATE public.bookings SET metadata=COALESCE(metadata,'{}')||jsonb_build_object('scheduling_authority_604',
    jsonb_build_object('request',p,'terms',q,'enrollment',p_enrollment)), 
    channel=CASE WHEN p_mode='manual' THEN 'dashboard'::booking_channel ELSE channel END,
    notes=CASE WHEN p_mode='manual' THEN b.notes ELSE notes END,
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
$function$
;
ALTER FUNCTION private.scheduling_604_create_booking(jsonb,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.scheduling_604_create_booking(jsonb,text,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.scheduling_604_create_booking(jsonb,text,uuid) TO service_role;

-- public.apply_payment_customer_visit_once: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.apply_payment_customer_visit_once(p_payment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payment RECORD;
  v_existing UUID;
  v_business_id UUID;
  v_customer_phone TEXT;
  v_source RECORD;
  v_spend_amount NUMERIC;
BEGIN
  -- 1. Load payment
  SELECT id, amount, status, booking_id, reservation_id, order_id,
         invoice_id, campaign_id
  INTO v_payment FROM payments WHERE id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_found');
  END IF;
  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_successful');
  END IF;

  -- 2. Idempotency check
  SELECT id INTO v_existing FROM payment_visit_applications
  WHERE payment_id = p_payment_id;
  IF FOUND THEN
    RETURN jsonb_build_object('applied', true, 'already_applied', true);
  END IF;

  -- 3. Derive business_id and customer_phone from entity
  IF v_payment.booking_id IS NOT NULL THEN
    SELECT business_id, guest_phone INTO v_source FROM bookings WHERE id = v_payment.booking_id;
  ELSIF v_payment.reservation_id IS NOT NULL THEN
    SELECT business_id, guest_phone INTO v_source FROM reservations WHERE id = v_payment.reservation_id;
  ELSIF v_payment.order_id IS NOT NULL THEN
    SELECT business_id, delivery_phone AS guest_phone INTO v_source FROM orders WHERE id = v_payment.order_id;
  ELSIF v_payment.invoice_id IS NOT NULL THEN
    SELECT business_id, customer_phone AS guest_phone INTO v_source FROM invoices WHERE id = v_payment.invoice_id;
  ELSIF v_payment.campaign_id IS NOT NULL THEN
    -- Campaign donations: derive business_id from campaign, phone from donation
    SELECT c.business_id, cd.donor_phone AS guest_phone
    INTO v_source
    FROM campaigns c
    LEFT JOIN campaign_donations cd ON cd.payment_id = p_payment_id
    WHERE c.id = v_payment.campaign_id
    LIMIT 1;
  ELSE
    RETURN jsonb_build_object('applied', false, 'reason', 'no_entity');
  END IF;

  IF v_source.business_id IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'entity_not_found');
  END IF;

  v_business_id := v_source.business_id;
  v_customer_phone := v_source.guest_phone;

  IF v_customer_phone IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_customer_phone');
  END IF;

  -- 4. Determine visit spend (booking/reservation spend owned by apply_payment_spend_once)
  v_spend_amount := CASE
    WHEN v_payment.booking_id IS NOT NULL OR v_payment.reservation_id IS NOT NULL THEN 0
    ELSE COALESCE(v_payment.amount, 0)
  END;

  -- 5. Insert marker atomically
  INSERT INTO payment_visit_applications
    (payment_id, business_id, customer_phone, visit_amount)
  VALUES
    (p_payment_id, v_business_id, v_customer_phone, v_spend_amount)
  ON CONFLICT (payment_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', true, 'already_applied', true);
  END IF;

  -- 6. Apply visit increment + profile upsert atomically
  UPDATE customer_profiles
  SET total_visits = total_visits + 1,
      total_bookings = total_bookings + 1,
      total_spent = total_spent + v_spend_amount,
      last_seen_at = NOW()
  WHERE business_id = v_business_id AND phone = v_customer_phone;

  IF NOT FOUND THEN
    INSERT INTO customer_profiles
      (business_id, phone, total_visits, total_bookings, total_spent, last_seen_at, first_seen_at)
    VALUES
      (v_business_id, v_customer_phone, 1, 1, v_spend_amount, NOW(), NOW())
    ON CONFLICT (business_id, phone) DO UPDATE SET
      total_visits = customer_profiles.total_visits + 1,
      total_bookings = customer_profiles.total_bookings + 1,
      total_spent = customer_profiles.total_spent + v_spend_amount,
      last_seen_at = NOW();
  END IF;

  RETURN jsonb_build_object('applied', true, 'already_applied', false,
    'visit_amount', v_spend_amount);
END;
$function$
;
ALTER FUNCTION public.apply_payment_customer_visit_once(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_payment_customer_visit_once(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_payment_customer_visit_once(uuid) TO service_role;

-- public.book_manual_slot_authoritative_604: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.book_manual_slot_authoritative_604(p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid, p_date date, p_time text, p_party_size integer, p_max_capacity integer, p_guest_name text, p_guest_phone text, p_guest_email text, p_notes text, p_total_amount numeric, p_staff_name text, p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30, p_appointment_id uuid DEFAULT NULL::uuid, p_class_session_id uuid DEFAULT NULL::uuid, p_expected_terms jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean, committed_total numeric, committed_deposit numeric)
 LANGUAGE sql
 SET search_path TO 'public', 'extensions'
AS $function$
 SELECT (r->>'booking_id')::uuid,r->>'reference_code',(r->>'slot_available')::boolean,
 (r->>'committed_total')::numeric,(r->>'committed_deposit')::numeric
 FROM (SELECT private.scheduling_604_create_booking(jsonb_build_object('business_id',p_business_id,'user_id',p_user_id,'service_id',p_service_id,'staff_id',p_staff_id,'date',p_date,'time',p_time,'party_size',p_party_size,'guest_name',p_guest_name,'guest_phone',p_guest_phone,'guest_email',p_guest_email,'notes',p_notes,'total_amount',p_total_amount,'staff_name',p_staff_name,'appointment_id',p_appointment_id,'class_session_id',p_class_session_id,'expected_terms',p_expected_terms,
 'flow_type','scheduling','deposit_amount',0),'manual') AS r) result;
$function$
;
ALTER FUNCTION public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,numeric,text,integer,integer,uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,numeric,text,integer,integer,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,numeric,text,integer,integer,uuid,uuid,jsonb) TO service_role;

-- public.book_slot_authoritative_604: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.book_slot_authoritative_604(p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid, p_date date, p_time text, p_party_size integer, p_max_capacity integer, p_flow_type text, p_deposit_amount numeric, p_deposit_status text, p_status text, p_guest_name text, p_guest_phone text, p_guest_email text, p_special_requests text, p_venue_address text, p_end_date date, p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount numeric, p_staff_name text, p_location_id uuid DEFAULT NULL::uuid, p_appointment_id uuid DEFAULT NULL::uuid, p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30, p_bot_session_id uuid DEFAULT NULL::uuid, p_class_session_id uuid DEFAULT NULL::uuid, p_expected_price numeric DEFAULT NULL::integer, p_expected_deposit numeric DEFAULT NULL::integer, p_expected_terms jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean, committed_total numeric, committed_deposit numeric)
 LANGUAGE sql
 SET search_path TO 'public', 'extensions'
AS $function$
 SELECT (r->>'booking_id')::uuid,r->>'reference_code',(r->>'slot_available')::boolean,
 (r->>'committed_total')::numeric,(r->>'committed_deposit')::numeric
 FROM (SELECT private.scheduling_604_create_booking(jsonb_build_object('business_id',p_business_id,'user_id',p_user_id,'service_id',p_service_id,'staff_id',p_staff_id,'date',p_date,'time',p_time,'party_size',p_party_size,'flow_type',p_flow_type,'deposit_amount',p_deposit_amount,'deposit_status',p_deposit_status,'status',p_status,'guest_name',p_guest_name,'guest_phone',p_guest_phone,'guest_email',p_guest_email,'special_requests',p_special_requests,'venue_address',p_venue_address,'end_date',p_end_date,'addons_snapshot',p_addons_snapshot,'promo_code_id',p_promo_code_id,'total_amount',p_total_amount,'staff_name',p_staff_name,'location_id',p_location_id,'appointment_id',p_appointment_id,'bot_session_id',p_bot_session_id,'class_session_id',p_class_session_id,'expected_terms',p_expected_terms)) AS r) result;
$function$
;
ALTER FUNCTION public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb) TO service_role;

-- public.book_with_package_authoritative_604: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.book_with_package_authoritative_604(p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid, p_date date, p_time text, p_party_size integer, p_max_capacity integer, p_flow_type text, p_deposit_amount numeric, p_deposit_status text, p_status text, p_guest_name text, p_guest_phone text, p_guest_email text, p_special_requests text, p_venue_address text, p_end_date date, p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount numeric, p_staff_name text, p_location_id uuid DEFAULT NULL::uuid, p_appointment_id uuid DEFAULT NULL::uuid, p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30, p_bot_session_id uuid DEFAULT NULL::uuid, p_enrollment_id uuid DEFAULT NULL::uuid, p_class_session_id uuid DEFAULT NULL::uuid, p_expected_terms jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public', 'extensions'
AS $function$
 SELECT private.scheduling_604_create_booking(jsonb_build_object('business_id',p_business_id,'user_id',p_user_id,'service_id',p_service_id,'staff_id',p_staff_id,'date',p_date,'time',p_time,'party_size',p_party_size,'flow_type',p_flow_type,'deposit_amount',p_deposit_amount,'deposit_status',p_deposit_status,'status',p_status,'guest_name',p_guest_name,'guest_phone',p_guest_phone,'guest_email',p_guest_email,'special_requests',p_special_requests,'venue_address',p_venue_address,'end_date',p_end_date,'addons_snapshot',p_addons_snapshot,'promo_code_id',p_promo_code_id,'total_amount',p_total_amount,'staff_name',p_staff_name,'location_id',p_location_id,'appointment_id',p_appointment_id,'bot_session_id',p_bot_session_id,'class_session_id',p_class_session_id,'expected_terms',p_expected_terms),'customer',p_enrollment_id);
$function$
;
ALTER FUNCTION public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb) TO service_role;

-- public.claim_payment_finalization_with_verified_fee: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.claim_payment_finalization_with_verified_fee(p_payment_id uuid, p_provider text, p_reference text, p_amount numeric, p_currency text, p_fee_supplied boolean, p_gateway_fee numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_token uuid;
BEGIN
  IF p_fee_supplied IS NULL OR p_provider IS DISTINCT FROM 'paystack'
     OR (NOT p_fee_supplied AND p_gateway_fee IS NOT NULL)
     OR (p_fee_supplied AND (p_gateway_fee IS NULL OR p_gateway_fee::text IN ('NaN','Infinity','-Infinity')
         OR p_gateway_fee < 0 OR p_gateway_fee > 2147483647 OR round(p_gateway_fee, 2) <> p_gateway_fee)) THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'invalid_gateway_fee');
  END IF;
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed', false, 'reason', 'not_found'); END IF;
  IF v_payment.gateway IS DISTINCT FROM p_provider OR v_payment.gateway_reference IS DISTINCT FROM p_reference
     OR v_payment.amount IS DISTINCT FROM p_amount OR v_payment.currency IS DISTINCT FROM p_currency THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'payment_tuple_mismatch');
  END IF;
  IF v_payment.status != 'success' THEN RETURN jsonb_build_object('claimed', false, 'reason', 'not_successful'); END IF;

  -- Unknown historical provenance may recover without changing its numeric fee.
  -- Never convert an equal old scalar into a certified observation.
  IF v_payment.gateway_fee_contract_version IS NULL THEN
    IF p_fee_supplied AND p_gateway_fee IS DISTINCT FROM v_payment.gateway_fee::numeric THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'legacy_fee_reconciliation_required');
    END IF;
    RETURN public.claim_payment_finalization(p_payment_id);
  END IF;
  IF v_payment.gateway_fee_claim_sealed_at IS NOT NULL THEN
    IF p_fee_supplied AND v_payment.verified_gateway_fee IS NULL THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'fee_snapshot_sealed');
    END IF;
    IF p_fee_supplied AND p_gateway_fee IS DISTINCT FROM v_payment.verified_gateway_fee::numeric THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'fee_conflict');
    END IF;
    RETURN public.claim_payment_finalization(p_payment_id);
  END IF;
  -- Defensive handling of attempts predating the seal, without rewriting them.
  IF v_payment.finalization_processing_at IS NOT NULL OR v_payment.finalization_completed_at IS NOT NULL THEN
    IF p_fee_supplied AND p_gateway_fee IS DISTINCT FROM v_payment.gateway_fee::numeric THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'legacy_fee_reconciliation_required');
    END IF;
    RETURN public.claim_payment_finalization(p_payment_id);
  END IF;

  v_token := gen_random_uuid();
  UPDATE public.payments SET
    gateway_fee = CASE WHEN p_fee_supplied THEN p_gateway_fee::numeric ELSE gateway_fee END,
    verified_gateway_fee = CASE WHEN p_fee_supplied THEN p_gateway_fee::numeric ELSE NULL END,
    gateway_fee_claim_snapshot = CASE WHEN p_fee_supplied THEN p_gateway_fee::numeric ELSE gateway_fee END,
    gateway_fee_claim_sealed_at = now(),
    finalization_processing_at = now(), finalization_claim_token = v_token
  WHERE id = p_payment_id RETURNING * INTO v_payment;
  IF v_payment.gateway_fee_claim_sealed_at IS NULL
     OR v_payment.gateway_fee_claim_snapshot IS DISTINCT FROM v_payment.gateway_fee
     OR v_payment.verified_gateway_fee IS DISTINCT FROM (CASE WHEN p_fee_supplied THEN p_gateway_fee::numeric ELSE NULL END)
     OR v_payment.finalization_claim_token IS DISTINCT FROM v_token THEN
    RAISE EXCEPTION 'verified fee claim postcondition failed';
  END IF;
  RETURN jsonb_build_object(
    'claimed', true, 'claim_token', v_token,
    'payment_id', v_payment.id, 'amount', v_payment.amount,
    'booking_id', v_payment.booking_id, 'invoice_id', v_payment.invoice_id,
    'campaign_id', v_payment.campaign_id, 'reservation_id', v_payment.reservation_id,
    'order_id', v_payment.order_id, 'gateway_fee', v_payment.gateway_fee
  );
END;
$function$
;
ALTER FUNCTION public.claim_payment_finalization_with_verified_fee(uuid,text,text,numeric,text,boolean,numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_payment_finalization_with_verified_fee(uuid,text,text,numeric,text,boolean,numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_payment_finalization_with_verified_fee(uuid,text,text,numeric,text,boolean,numeric) TO service_role;

-- public.confirm_nonorder_transfer_atomic: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.confirm_nonorder_transfer_atomic(p_transfer_id uuid, p_business_id uuid, p_confirmed_by uuid, p_approve_fulfillment boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_transfer RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_payment_id UUID;
  v_entity_count INTEGER := 0;
  v_entity_type TEXT := 'none';
  v_rows INTEGER;
  v_payment_amount NUMERIC;
BEGIN
  -- 1. Lock + validate transfer
  SELECT * INTO v_transfer FROM pending_transfers
  WHERE id = p_transfer_id FOR UPDATE;

  IF NOT FOUND THEN RETURN '{"confirmed":false,"reason":"not_found"}'::jsonb; END IF;
  IF v_transfer.status != 'pending' THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'status_' || v_transfer.status);
  END IF;
  IF v_transfer.business_id != p_business_id THEN
    RETURN '{"confirmed":false,"reason":"business_mismatch"}'::jsonb;
  END IF;

  -- 2. Fail-closed: reject non-representable fractional amounts
  IF v_transfer.expected_amount % 100 != 0 THEN
    RETURN '{"confirmed":false,"reason":"fractional_amount_unsupported"}'::jsonb;
  END IF;
  v_payment_amount := v_transfer.expected_amount / 100;

  -- 3. Exactly one linked entity (or standalone payment)
  IF v_transfer.booking_id IS NOT NULL THEN v_entity_count := v_entity_count + 1; v_entity_type := 'booking'; END IF;
  IF v_transfer.invoice_id IS NOT NULL THEN v_entity_count := v_entity_count + 1; v_entity_type := 'invoice'; END IF;
  IF v_transfer.reservation_id IS NOT NULL THEN v_entity_count := v_entity_count + 1; v_entity_type := 'reservation'; END IF;
  IF v_transfer.campaign_id IS NOT NULL THEN v_entity_count := v_entity_count + 1; v_entity_type := 'campaign'; END IF;
  IF v_entity_count > 1 THEN
    RETURN '{"confirmed":false,"reason":"multi_entity_transfer"}'::jsonb;
  END IF;

  -- 4. Validate linked entity: tenant + acceptable state
  IF v_entity_type = 'booking' THEN
    IF NOT EXISTS (SELECT 1 FROM bookings WHERE id = v_transfer.booking_id
        AND business_id = p_business_id AND status = 'pending') THEN
      RETURN '{"confirmed":false,"reason":"booking_not_pending_or_mismatch"}'::jsonb;
    END IF;
  ELSIF v_entity_type = 'reservation' THEN
    IF NOT EXISTS (SELECT 1 FROM reservations WHERE id = v_transfer.reservation_id
        AND business_id = p_business_id AND status = 'pending') THEN
      RETURN '{"confirmed":false,"reason":"reservation_not_pending_or_mismatch"}'::jsonb;
    END IF;
  ELSIF v_entity_type = 'invoice' THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = v_transfer.invoice_id
        AND business_id = p_business_id AND status IN ('sent', 'viewed', 'overdue')) THEN
      RETURN '{"confirmed":false,"reason":"invoice_not_payable_or_mismatch"}'::jsonb;
    END IF;
  END IF;

  -- 5. Confirm transfer
  UPDATE pending_transfers SET status = 'confirmed',
    confirmed_by = p_confirmed_by, confirmed_at = v_now
  WHERE id = p_transfer_id AND status = 'pending';

  -- 6. Create payment (major units, M394 provenance conventions)
  -- #736 Finding 5: Set finalization_completed_at to prevent recovery cron
  -- from selecting non-order direct payments for order-only reconciliation.
  INSERT INTO payments (
    business_id, amount, currency, status, payment_method, gateway,
    gateway_reference, gateway_status, paid_at,
    booking_id, invoice_id, reservation_id, campaign_id,
    payment_authority_version, gateway_fee, fee_policy_version,
    finalization_completed_at,
    metadata
  ) VALUES (
    p_business_id, v_payment_amount,
    COALESCE(v_transfer.currency, 'NGN'),
    'success', 'bank_transfer', 'direct',
    'transfer:' || v_transfer.reference_code, 'merchant_confirmed', v_now,
    v_transfer.booking_id, v_transfer.invoice_id,
    v_transfer.reservation_id, v_transfer.campaign_id,
    1, 0, 0,
    v_now,  -- finalization_completed_at: inline-finalized, exclude from recovery cron
    jsonb_build_object(
      'pending_transfer_id', p_transfer_id,
      'confirmed_by', p_confirmed_by,
      'customer_phone', v_transfer.customer_phone,
      'customer_name', v_transfer.customer_name,
      '_direct_transfer', true
    )
  ) RETURNING id INTO v_payment_id;

  -- 7. Zero-fee platform record (minor units for transaction_amount)
  INSERT INTO platform_fees (
    business_id, payment_id,
    booking_id, invoice_id,
    transaction_amount, fee_percentage, fee_flat, fee_total, gateway_fee,
    tier, is_direct_transfer
  ) VALUES (
    p_business_id, v_payment_id,
    v_transfer.booking_id, v_transfer.invoice_id,
    v_transfer.expected_amount, 0, 0, 0, 0,
    (SELECT COALESCE(subscription_tier, 'free') FROM businesses WHERE id = p_business_id),
    true
  );

  -- 8. Entity effects
  IF v_entity_type = 'booking' THEN
    IF p_approve_fulfillment THEN
      UPDATE bookings SET deposit_status = 'paid', status = 'confirmed',
        confirmed_at = v_now, payment_id = v_payment_id
      WHERE id = v_transfer.booking_id AND status = 'pending';
    ELSE
      UPDATE bookings SET deposit_status = 'paid', payment_id = v_payment_id
      WHERE id = v_transfer.booking_id AND status = 'pending';
    END IF;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows < 1 THEN
      RAISE EXCEPTION 'booking_update_failed: booking % no longer pending', v_transfer.booking_id;
    END IF;

  ELSIF v_entity_type = 'reservation' THEN
    IF p_approve_fulfillment THEN
      UPDATE reservations SET status = 'confirmed', deposit_status = 'paid'
      WHERE id = v_transfer.reservation_id AND status = 'pending';
    ELSE
      UPDATE reservations SET deposit_status = 'paid'
      WHERE id = v_transfer.reservation_id AND status = 'pending';
    END IF;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows < 1 THEN
      RAISE EXCEPTION 'reservation_update_failed: reservation % no longer pending', v_transfer.reservation_id;
    END IF;

  ELSIF v_entity_type = 'invoice' THEN
    -- Invoice: payment IS completion (no separate approval needed)
    UPDATE invoices SET status = 'paid', paid_at = v_now
    WHERE id = v_transfer.invoice_id AND business_id = p_business_id
      AND status IN ('sent', 'viewed', 'overdue');
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows < 1 THEN
      RAISE EXCEPTION 'invoice_update_failed: invoice % not payable', v_transfer.invoice_id;
    END IF;
  END IF;
  -- campaign/standalone: no entity update needed

  RETURN jsonb_build_object(
    'confirmed', true, 'payment_id', v_payment_id,
    'entity_type', v_entity_type, 'approved', p_approve_fulfillment,
    'amount_major', v_payment_amount
  );
END; $function$
;
ALTER FUNCTION public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean) TO service_role;

-- public.create_catalog_order_atomic: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.create_catalog_order_atomic(p_business_id uuid, p_user_id uuid, p_delivery_phone text, p_meta_message_id text, p_customer_note text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order_id UUID;
  v_item JSONB;
  v_product RECORD;
  v_total_amount NUMERIC := 0;
  v_order_items JSONB := '[]'::JSONB;
  v_out_of_stock TEXT[] := '{}';
  v_valid_count INT := 0;
BEGIN
  -- Validate items array
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_items');
  END IF;
  IF jsonb_array_length(p_items) > 50 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'too_many_items');
  END IF;

  -- 1. Check dedup via processed_webhook_events
  IF EXISTS (SELECT 1 FROM processed_webhook_events WHERE event_id = 'meta-order-' || p_meta_message_id) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'duplicate', 'order_id', NULL);
  END IF;

  -- 2. Process each item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    -- Validate quantity is a positive integer within bounds
    IF (v_item->>'quantity')::INT IS NULL OR (v_item->>'quantity')::INT < 1 THEN
      RAISE EXCEPTION 'Invalid quantity for product %: must be a positive integer', v_item->>'product_id';
    END IF;
    IF (v_item->>'quantity')::INT > 100 THEN
      RAISE EXCEPTION 'Quantity exceeds maximum (100) for product %', v_item->>'product_id';
    END IF;

    -- Lock the product row for update
    SELECT id, name, price, stock_quantity, track_inventory, is_active, business_id
    INTO v_product
    FROM products
    WHERE id = (v_item->>'product_id')::UUID
    FOR UPDATE;

    -- Validate product exists
    IF v_product IS NULL THEN
      CONTINUE; -- skip unknown products (Meta may send stale catalog items)
    END IF;

    -- Validate product belongs to business
    IF v_product.business_id != p_business_id THEN
      CONTINUE;
    END IF;

    -- Validate product is active
    IF NOT v_product.is_active THEN
      CONTINUE;
    END IF;

    -- Check inventory
    IF v_product.track_inventory AND v_product.stock_quantity IS NOT NULL THEN
      IF v_product.stock_quantity < (v_item->>'quantity')::INT THEN
        v_out_of_stock := array_append(v_out_of_stock, v_product.name);
        CONTINUE;
      END IF;
      -- Decrement inventory atomically
      UPDATE products SET stock_quantity = stock_quantity - (v_item->>'quantity')::INT
      WHERE id = v_product.id;
    END IF;

    -- Accumulate total using DB-authoritative price (NOT webhook price)
    v_total_amount := v_total_amount + (v_product.price * (v_item->>'quantity')::INT);
    v_valid_count := v_valid_count + 1;

    -- Build order item record
    v_order_items := v_order_items || jsonb_build_object(
      'product_id', v_product.id,
      'product_name', v_product.name,
      'quantity', (v_item->>'quantity')::INT,
      'unit_price', v_product.price
    );
  END LOOP;

  -- If no valid items, return without creating order
  IF v_valid_count = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'no_valid_items',
      'out_of_stock', to_jsonb(v_out_of_stock)
    );
  END IF;

  -- 3. Create order (reference_code auto-generated by trigger)
  INSERT INTO orders (
    business_id, user_id, status, delivery_phone, total_amount, channel, notes
  ) VALUES (
    p_business_id,
    p_user_id,
    CASE WHEN v_total_amount > 0 THEN 'pending'::order_status ELSE 'confirmed'::order_status END,
    p_delivery_phone,
    v_total_amount,
    'whatsapp',
    NULLIF(p_customer_note, '')
  )
  RETURNING id INTO v_order_id;

  -- 4. Create order items
  INSERT INTO order_items (order_id, product_id, quantity, unit_price)
  SELECT
    v_order_id,
    (item->>'product_id')::UUID,
    (item->>'quantity')::INT,
    (item->>'unit_price')::NUMERIC
  FROM jsonb_array_elements(v_order_items) AS item;

  -- 5. Record dedup event
  INSERT INTO processed_webhook_events (event_id, gateway, event_type, processed_at)
  VALUES ('meta-order-' || p_meta_message_id, 'meta_cloud', 'catalog_order', NOW());

  -- 6. Fetch the generated reference_code
  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'reference_code', (SELECT reference_code FROM orders WHERE id = v_order_id),
    'total_amount', v_total_amount,
    'items', v_order_items,
    'out_of_stock', to_jsonb(v_out_of_stock)
  );
END;
$function$
;
ALTER FUNCTION public.create_catalog_order_atomic(uuid,uuid,text,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_catalog_order_atomic(uuid,uuid,text,text,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_catalog_order_atomic(uuid,uuid,text,text,text,jsonb) TO service_role;

-- public.create_order_atomic: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.create_order_atomic(p_bot_session_id uuid, p_business_id uuid, p_user_id uuid, p_status text DEFAULT 'pending'::text, p_delivery_address text DEFAULT NULL::text, p_delivery_phone text DEFAULT NULL::text, p_total_amount numeric DEFAULT 0, p_discount_amount numeric DEFAULT 0, p_shipping_cost numeric DEFAULT 0, p_promo_code_id uuid DEFAULT NULL::uuid, p_channel text DEFAULT 'whatsapp'::text, p_notes text DEFAULT NULL::text, p_delivery_zone_id uuid DEFAULT NULL::uuid, p_delivery_zone_name text DEFAULT NULL::text, p_addons_total numeric DEFAULT 0, p_volume_discount_amount numeric DEFAULT 0, p_pickup_address text DEFAULT NULL::text, p_dropoff_address text DEFAULT NULL::text, p_package_description text DEFAULT NULL::text, p_package_photo_url text DEFAULT NULL::text, p_items jsonb DEFAULT '[]'::jsonb, p_referral_id uuid DEFAULT NULL::uuid, p_validate_products boolean DEFAULT false, p_expected_total numeric DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order_id uuid;
  v_ref text;
  v_item jsonb;
  v_existing_id uuid;
  v_existing_ref text;
  v_existing_fingerprint text;
  v_promo RECORD;
  v_active_count int;
  v_fingerprint text;
  v_product RECORD;
  v_variant RECORD;
  v_addon RECORD;
  v_server_total numeric := 0;
  v_server_subtotal numeric := 0;      -- M435: pre-discount item+addon total
  v_server_discount numeric := 0;      -- M435: server-computed promo discount
  v_server_volume_discount numeric := 0; -- M435: server-computed volume discount
  v_server_addons_total numeric := 0;   -- DB-authoritative addon subtotal
  v_item_total numeric;
  v_addon_entry jsonb;
  v_addon_id uuid;
  v_addon_total numeric;
  v_sorted_items jsonb;
  v_fp_parts text[] := '{}';
  v_fp_item jsonb;
  v_addon_ids text;
  v_zone RECORD;
  v_zone_name TEXT := NULL;
  -- M435 R2-5: idempotent replay validation vars
  v_existing_total numeric;
  v_existing_discount numeric;
  v_existing_promo_id uuid;
  v_existing_biz_id uuid;
  v_existing_user_id uuid;
  v_existing_vol_discount numeric;
  v_existing_zone_id uuid;
  v_existing_shipping numeric;
  -- M435: volume discount per-item vars
  v_vol_rule RECORD;
  v_vol_item_discount numeric;
  v_vol_item_quantity int;
  v_vol_item_unit_price numeric;
  v_vol_item_product_id uuid;
  -- M435: promo eligibility vars
  v_promo_raw_discount numeric;
  v_cart_product_ids uuid[];
BEGIN
  -- ── Phase 1: Lock + idempotency (UNCHANGED from M393) ──
  PERFORM pg_advisory_xact_lock(abs(hashtext(p_bot_session_id::text)));

  SELECT jsonb_agg(elem ORDER BY elem->>'product_id', elem->>'variant_id') INTO v_sorted_items
  FROM jsonb_array_elements(p_items) AS elem;

  IF v_sorted_items IS NOT NULL THEN
    FOR v_fp_item IN SELECT * FROM jsonb_array_elements(v_sorted_items)
    LOOP
      v_addon_ids := '';
      IF v_fp_item->'addons' IS NOT NULL AND v_fp_item->'addons' != 'null'::jsonb THEN
        SELECT string_agg(
          COALESCE(a->>'id', '') || ':' || COALESCE(a->>'quantity', '1'),
          ',' ORDER BY a->>'id'
        ) INTO v_addon_ids
        FROM jsonb_array_elements(v_fp_item->'addons') AS a;
      END IF;
      v_fp_parts := array_append(v_fp_parts,
        COALESCE(v_fp_item->>'product_id', '') || ':' ||
        COALESCE(v_fp_item->>'variant_id', '') || ':' ||
        COALESCE(v_fp_item->>'quantity', '1') || ':' ||
        COALESCE(v_addon_ids, '')
      );
    END LOOP;
    v_fingerprint := md5(array_to_string(v_fp_parts, '|'));
  ELSE
    v_fingerprint := md5('');
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- M435 603-D: Validate all item and addon quantities are positive integers
  -- before any pricing/stock mutation. Negative quantities could inflate stock
  -- and produce free orders via zero-floor.
  -- ══════════════════════════════════════════════════════════════════
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF COALESCE((v_item->>'quantity')::int, 0) < 1 THEN
      RAISE EXCEPTION 'invalid_quantity:Item % has non-positive quantity %',
        v_item->>'product_id', COALESCE(v_item->>'quantity', 'null');
    END IF;
    -- Check addon quantities
    IF v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb THEN
      FOR v_addon_entry IN SELECT * FROM jsonb_array_elements(v_item->'addons')
      LOOP
        IF COALESCE((v_addon_entry->>'quantity')::int, 0) < 1 THEN
          RAISE EXCEPTION 'invalid_addon_quantity:Addon % has non-positive quantity %',
            COALESCE(v_addon_entry->>'id', 'unknown'), COALESCE(v_addon_entry->>'quantity', 'null');
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- Idempotent: check for existing order from same bot session
  SELECT id, reference_code, items_fingerprint, total_amount, discount_amount,
         promo_code_id, business_id, user_id, volume_discount_amount,
         delivery_zone_id, shipping_cost
  INTO v_existing_id, v_existing_ref, v_existing_fingerprint, v_existing_total,
       v_existing_discount, v_existing_promo_id, v_existing_biz_id, v_existing_user_id,
       v_existing_vol_discount, v_existing_zone_id, v_existing_shipping
  FROM orders
  WHERE bot_session_id = p_bot_session_id
    AND status IN ('pending', 'confirmed')
  LIMIT 1;

  IF FOUND THEN
    IF p_validate_products THEN
      IF v_existing_fingerprint IS NOT NULL AND v_existing_fingerprint = v_fingerprint THEN
        -- R2-5: Validate full monetary and tenant contract on replay.
        -- Same cart fingerprint is necessary but not sufficient.

        -- Tenant/user binding (fail-closed)
        IF v_existing_biz_id IS DISTINCT FROM p_business_id THEN
          RAISE EXCEPTION 'replay_business_mismatch:Replay targets different business than committed order';
        END IF;
        IF v_existing_user_id IS DISTINCT FROM p_user_id THEN
          RAISE EXCEPTION 'replay_user_mismatch:Replay targets different user than committed order';
        END IF;

        -- Expected total is REQUIRED on validated replay (no null bypass)
        IF p_expected_total IS NULL THEN
          RAISE EXCEPTION 'expected_total_required:p_expected_total must be provided on validated replay';
        END IF;
        IF v_existing_total != p_expected_total THEN
          RAISE EXCEPTION 'replay_total_mismatch:Existing order total % does not match expected %',
            v_existing_total, p_expected_total;
        END IF;
        IF COALESCE(p_promo_code_id::text, '') != COALESCE(v_existing_promo_id::text, '') THEN
          RAISE EXCEPTION 'replay_promo_mismatch:Replay uses different promo code than committed order';
        END IF;
        IF COALESCE(p_discount_amount, 0) != COALESCE(v_existing_discount, 0) THEN
          RAISE EXCEPTION 'replay_discount_mismatch:Replay discount % does not match committed %',
            COALESCE(p_discount_amount, 0), COALESCE(v_existing_discount, 0);
        END IF;
        IF COALESCE(p_volume_discount_amount, 0) != COALESCE(v_existing_vol_discount, 0) THEN
          RAISE EXCEPTION 'replay_volume_discount_mismatch:Replay volume discount % does not match committed %',
            COALESCE(p_volume_discount_amount, 0), COALESCE(v_existing_vol_discount, 0);
        END IF;

        -- Reject inconsistent payment or delivery quotes on same-session retry.
        IF p_total_amount IS DISTINCT FROM v_existing_total THEN
          RAISE EXCEPTION 'replay_payment_amount_mismatch:Payable % differs from committed %', p_total_amount, v_existing_total;
        END IF;
        IF p_delivery_zone_id IS DISTINCT FROM v_existing_zone_id THEN
          RAISE EXCEPTION 'replay_zone_mismatch:Delivery zone differs from committed order';
        END IF;
        IF p_shipping_cost IS DISTINCT FROM v_existing_shipping THEN
          RAISE EXCEPTION 'replay_shipping_mismatch:Shipping cost differs from committed order';
        END IF;

        -- Return committed order with authoritative total
        RETURN jsonb_build_object(
          'order_id', v_existing_id,
          'reference_code', v_existing_ref,
          'created', false,
          'server_total', v_existing_total
        );
      ELSIF v_existing_fingerprint IS NOT NULL THEN
        RAISE EXCEPTION 'fingerprint_mismatch:Order % exists with different cart contents', v_existing_id;
      END IF;
    END IF;

    DELETE FROM order_items WHERE order_id = v_existing_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      INSERT INTO order_items (order_id, product_id, quantity, unit_price, variant_id, variant_label, addons)
      VALUES (
        v_existing_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'quantity')::int,
        (v_item->>'unit_price')::numeric,
        NULLIF(v_item->>'variant_id', '')::uuid,
        NULLIF(v_item->>'variant_label', ''),
        CASE WHEN v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb
             THEN v_item->'addons' ELSE NULL END
      );
    END LOOP;

    RETURN jsonb_build_object(
      'order_id', v_existing_id,
      'reference_code', v_existing_ref,
      'created', false
    );
  END IF;

  -- ── Phase 2: Validations (only when p_validate_products = true) ──
  IF p_validate_products THEN

    -- ══════════════════════════════════════════════════════════════════
    -- M435 2a: Promo eligibility + capacity (FOR UPDATE on promo_codes)
    -- Reads full promo record for discount computation, not just capacity.
    -- ══════════════════════════════════════════════════════════════════
    IF p_promo_code_id IS NOT NULL THEN
      SELECT id, business_id, is_active, discount_type, discount_value,
             valid_from, valid_until, max_uses, current_uses,
             min_order_amount, applicable_services, applicable_flow_types
      INTO v_promo
      FROM promo_codes WHERE id = p_promo_code_id FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'promo_not_found:Promo code does not exist';
      END IF;

      -- Tenant binding
      IF v_promo.business_id != p_business_id THEN
        RAISE EXCEPTION 'promo_tenant_mismatch:Promo code does not belong to this business';
      END IF;

      -- Active check
      IF NOT v_promo.is_active THEN
        RAISE EXCEPTION 'promo_inactive:Promo code is not active';
      END IF;

      -- Date validity (half-open: valid_from <= now < valid_until)
      IF v_promo.valid_from IS NOT NULL AND NOW() < v_promo.valid_from THEN
        RAISE EXCEPTION 'promo_not_yet_active:Promo code is not yet active';
      END IF;
      IF v_promo.valid_until IS NOT NULL AND NOW() >= v_promo.valid_until THEN
        RAISE EXCEPTION 'promo_expired:Promo code has expired';
      END IF;

      -- Flow type check
      IF v_promo.applicable_flow_types IS NOT NULL
         AND array_length(v_promo.applicable_flow_types, 1) > 0
         AND NOT ('ordering' = ANY(v_promo.applicable_flow_types)) THEN
        RAISE EXCEPTION 'promo_wrong_flow:Promo code is not valid for ordering';
      END IF;

      -- Capacity check (same as M393 but using the full record)
      IF v_promo.max_uses IS NOT NULL THEN
        SELECT count(*) INTO v_active_count
        FROM promo_reservations
        WHERE promo_code_id = p_promo_code_id
          AND state = 'reserved';

        IF (v_promo.current_uses + v_active_count) >= v_promo.max_uses THEN
          RAISE EXCEPTION 'promo_exhausted:Promo code has reached maximum uses';
        END IF;
      END IF;

      -- 603-F: Per-customer promo reuse check (matches bot validation)
      -- A user who already has an order with this promo cannot reuse it
      IF EXISTS (
        SELECT 1 FROM orders
        WHERE user_id = p_user_id
          AND promo_code_id = p_promo_code_id
          AND status IN ('pending', 'confirmed', 'delivered')
          AND id != COALESCE(v_existing_id, '00000000-0000-0000-0000-000000000000')
      ) THEN
        RAISE EXCEPTION 'promo_already_used:This promo code has already been used by this customer';
      END IF;

      -- Product scope and discount computation happen after item prices are locked (below)
    ELSIF COALESCE(p_discount_amount, 0) > 0 THEN
      -- M435: Refuse discount without promo
      RAISE EXCEPTION 'discount_without_promo:Discount amount provided but no promo code';
    END IF;

    -- ══════════════════════════════════════════════════════════════════
    -- 2b. Product validation: lock products ORDER BY product_id, variant_id
    -- (UNCHANGED from M393 except we track v_server_subtotal and per-item prices)
    -- ══════════════════════════════════════════════════════════════════
    v_cart_product_ids := ARRAY[]::uuid[];

    FOR v_item IN
      SELECT * FROM jsonb_array_elements(p_items) AS elem
      ORDER BY elem->>'product_id', elem->>'variant_id'
    LOOP
      v_item_total := 0;

      SELECT id, price, is_active, deleted_at, business_id, track_inventory, stock_quantity
      INTO v_product
      FROM products
      WHERE id = (v_item->>'product_id')::uuid
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'product_not_found:Product % does not exist', v_item->>'product_id';
      END IF;
      IF NOT v_product.is_active THEN
        RAISE EXCEPTION 'product_unavailable:Product % is not active', v_item->>'product_id';
      END IF;
      IF v_product.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'product_deleted:Product % has been deleted', v_item->>'product_id';
      END IF;
      IF v_product.business_id != p_business_id THEN
        RAISE EXCEPTION 'product_wrong_business:Product % does not belong to this business', v_item->>'product_id';
      END IF;

      -- M435: Collect unique product IDs for promo scope check
      IF NOT (v_product.id = ANY(v_cart_product_ids)) THEN
        v_cart_product_ids := array_append(v_cart_product_ids, v_product.id);
      END IF;

      -- Variant validation
      IF NULLIF(v_item->>'variant_id', '') IS NOT NULL THEN
        SELECT id, price, product_id, is_active, stock_quantity
        INTO v_variant
        FROM product_variants
        WHERE id = (v_item->>'variant_id')::uuid
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'variant_not_found:Variant % does not exist', v_item->>'variant_id';
        END IF;
        IF NOT v_variant.is_active THEN
          RAISE EXCEPTION 'variant_unavailable:Variant % is not active', v_item->>'variant_id';
        END IF;
        IF v_variant.product_id != (v_item->>'product_id')::uuid THEN
          RAISE EXCEPTION 'variant_wrong_product:Variant % does not belong to product %',
            v_item->>'variant_id', v_item->>'product_id';
        END IF;

        v_item_total := v_variant.price * COALESCE((v_item->>'quantity')::int, 1);
        -- M435: Track unit price for volume discount
        v_vol_item_unit_price := v_variant.price;
      ELSE
        v_item_total := v_product.price * COALESCE((v_item->>'quantity')::int, 1);
        v_vol_item_unit_price := v_product.price;
      END IF;

      v_vol_item_quantity := COALESCE((v_item->>'quantity')::int, 1);
      v_vol_item_product_id := (v_item->>'product_id')::uuid;

      -- Addon validation (UNCHANGED from M393)
      IF v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb THEN
        FOR v_addon_entry IN SELECT * FROM jsonb_array_elements(v_item->'addons')
        LOOP
          IF v_addon_entry->>'id' IS NULL OR v_addon_entry->>'id' = '' THEN
            RAISE EXCEPTION 'addon_missing_id:Addon entry missing id in product %', v_item->>'product_id';
          END IF;

          v_addon_id := (v_addon_entry->>'id')::uuid;

          SELECT id, price, price_type, is_active, business_id, product_id
          INTO v_addon
          FROM product_addons
          WHERE id = v_addon_id
          FOR UPDATE;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'addon_not_found:Addon % does not exist', v_addon_id;
          END IF;
          IF NOT v_addon.is_active THEN
            RAISE EXCEPTION 'addon_unavailable:Addon % is not active', v_addon_id;
          END IF;
          IF v_addon.business_id != p_business_id THEN
            RAISE EXCEPTION 'addon_wrong_business:Addon % does not belong to this business', v_addon_id;
          END IF;
          IF v_addon.product_id IS NOT NULL AND v_addon.product_id != (v_item->>'product_id')::uuid THEN
            RAISE EXCEPTION 'addon_wrong_product:Addon % does not belong to product %',
              v_addon_id, v_item->>'product_id';
          END IF;
          IF v_addon.price_type = 'quote' THEN
            RAISE EXCEPTION 'addon_quote_price:Addon % has quote price_type and cannot be committed at fixed price', v_addon_id;
          END IF;

          v_addon_total := v_addon.price * COALESCE((v_addon_entry->>'quantity')::int, 1);
          v_item_total := v_item_total + v_addon_total;
          v_server_addons_total := v_server_addons_total + v_addon_total;
        END LOOP;
      END IF;

      v_server_total := v_server_total + v_item_total;

      -- ══════════════════════════════════════════════════════════════
      -- M435: Volume discount per-item (inlined calculate_volume_discount logic)
      -- Uses LOCKED product/variant unit price, not caller-supplied p_unit_price
      -- ══════════════════════════════════════════════════════════════
      v_vol_item_discount := 0;
      -- 603-F: FOR UPDATE serializes concurrent rule edits with discount calculation
      SELECT * INTO v_vol_rule
      FROM volume_discount_rules
      WHERE business_id = p_business_id
        AND is_active = true
        AND (product_id = v_vol_item_product_id OR product_id IS NULL)
        AND v_vol_item_quantity >= min_quantity
        AND (max_quantity IS NULL OR v_vol_item_quantity <= max_quantity)
      ORDER BY
        product_id IS NULL ASC,
        min_quantity DESC
      LIMIT 1
      FOR UPDATE;

      IF FOUND THEN
        CASE v_vol_rule.discount_type
          WHEN 'percentage' THEN
            v_vol_item_discount := ROUND((v_vol_item_unit_price * v_vol_item_quantity * v_vol_rule.discount_value) / 100);
          WHEN 'fixed_per_unit' THEN
            v_vol_item_discount := ROUND(v_vol_rule.discount_value * v_vol_item_quantity);
          WHEN 'fixed_total' THEN
            v_vol_item_discount := ROUND(v_vol_rule.discount_value);
          ELSE
            v_vol_item_discount := 0;
        END CASE;

        -- Cap at item total (product/variant * quantity, excluding addons)
        IF v_vol_item_discount > (v_vol_item_unit_price * v_vol_item_quantity) THEN
          v_vol_item_discount := v_vol_item_unit_price * v_vol_item_quantity;
        END IF;
        IF v_vol_item_discount < 0 THEN
          v_vol_item_discount := 0;
        END IF;
      END IF;

      v_server_volume_discount := v_server_volume_discount + v_vol_item_discount;
    END LOOP;

    -- M435: Capture pre-discount subtotal for promo checks
    v_server_subtotal := v_server_total;

    -- ══════════════════════════════════════════════════════════════════
    -- M435 2c: Promo discount computation (after items are locked)
    -- ══════════════════════════════════════════════════════════════════
    IF p_promo_code_id IS NOT NULL THEN
      -- Product scope: if promo has applicable_services (product IDs), all cart
      -- products must be in the allowed set. Refuse mixed carts (matches PR #599).
      IF v_promo.applicable_services IS NOT NULL
         AND array_length(v_promo.applicable_services, 1) > 0 THEN
        -- Check every cart product is in the allowed set
        IF NOT (v_cart_product_ids <@ v_promo.applicable_services) THEN
          RAISE EXCEPTION 'promo_wrong_product:Promo code does not apply to all products in cart';
        END IF;
      END IF;

      -- Minimum order amount (checked against pre-discount subtotal)
      IF COALESCE(v_promo.min_order_amount, 0) > v_server_subtotal THEN
        RAISE EXCEPTION 'promo_minimum_not_met:Order subtotal % does not meet minimum %',
          v_server_subtotal, v_promo.min_order_amount;
      END IF;

      -- Compute discount from DB values
      IF v_promo.discount_type = 'percentage' THEN
        IF v_promo.discount_value <= 0 OR v_promo.discount_value > 100 THEN
          RAISE EXCEPTION 'promo_invalid_percentage:Invalid percentage discount value %', v_promo.discount_value;
        END IF;
        v_promo_raw_discount := v_server_subtotal * v_promo.discount_value / 100;
        v_server_discount := ROUND(v_promo_raw_discount);
      ELSIF v_promo.discount_type = 'fixed' THEN
        IF v_promo.discount_value <= 0 THEN
          RAISE EXCEPTION 'promo_invalid_fixed:Invalid fixed discount value %', v_promo.discount_value;
        END IF;
        -- Fixed discount capped at subtotal
        v_server_discount := LEAST(ROUND(v_promo.discount_value), v_server_subtotal);
      ELSE
        RAISE EXCEPTION 'promo_unknown_type:Unknown discount type %', v_promo.discount_type;
      END IF;

      -- Clamp: non-negative, cannot exceed subtotal
      v_server_discount := GREATEST(0, LEAST(v_server_discount, v_server_subtotal));

      -- M435: Compare server-computed discount against caller's quote
      IF v_server_discount != COALESCE(p_discount_amount, 0) THEN
        RAISE EXCEPTION 'discount_mismatch:Server discount % does not match caller discount %',
          v_server_discount, COALESCE(p_discount_amount, 0);
      END IF;
    END IF;

    -- Do not allow stacked discounts to exceed the sold item value.
    IF v_server_discount + v_server_volume_discount > v_server_subtotal THEN
      RAISE EXCEPTION 'combined_discount_exceeds_subtotal:Combined discounts exceed merchandise subtotal';
    END IF;
    IF COALESCE(p_shipping_cost, 0) < 0 THEN
      RAISE EXCEPTION 'invalid_shipping_cost:Shipping fee cannot be negative';
    END IF;
    IF COALESCE(p_addons_total, 0) IS DISTINCT FROM v_server_addons_total THEN
      RAISE EXCEPTION 'addons_total_mismatch:Quoted addons % differ from authoritative addons %', p_addons_total, v_server_addons_total;
    END IF;

    -- M435: Compare server-computed volume discount against caller's quote
    IF v_server_volume_discount != COALESCE(p_volume_discount_amount, 0) THEN
      RAISE EXCEPTION 'volume_discount_mismatch:Server volume discount % does not match caller volume discount %',
        v_server_volume_discount, COALESCE(p_volume_discount_amount, 0);
    END IF;

    -- ══════════════════════════════════════════════════════════════════
    -- 2d. Total validation (M435: uses server-computed discounts)
    -- ══════════════════════════════════════════════════════════════════
    v_server_total := v_server_total - v_server_discount - v_server_volume_discount;

    -- Delivery-zone server-authoritative total (UNCHANGED from M393)
    IF p_delivery_zone_id IS NOT NULL THEN
      SELECT id, price, name, business_id, is_active
      INTO v_zone
      FROM delivery_zones
      WHERE id = p_delivery_zone_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'zone_not_found:Delivery zone % does not exist', p_delivery_zone_id;
      END IF;
      IF NOT v_zone.is_active THEN
        RAISE EXCEPTION 'zone_unavailable:Delivery zone % is not active', p_delivery_zone_id;
      END IF;
      IF v_zone.business_id != p_business_id THEN
        RAISE EXCEPTION 'zone_wrong_business:Delivery zone % does not belong to this business', p_delivery_zone_id;
      END IF;

      v_server_total := v_server_total + v_zone.price;
      v_zone_name := v_zone.name;
    ELSE
      v_server_total := v_server_total + COALESCE(p_shipping_cost, 0);
    END IF;

    -- Zero-floor (UNCHANGED from M393)
    v_server_total := GREATEST(0, v_server_total);

    -- Expected total comparison (UNCHANGED from M393)
    IF p_expected_total IS NULL THEN
      RAISE EXCEPTION 'expected_total_required:p_expected_total must be provided when p_validate_products=true';
    END IF;
    IF p_total_amount IS DISTINCT FROM p_expected_total THEN
      RAISE EXCEPTION 'quoted_payment_amount_mismatch:Payable % differs from expected %', p_total_amount, p_expected_total;
    END IF;
    IF v_server_total != p_expected_total THEN
      RAISE EXCEPTION 'total_mismatch:Server total % does not match expected total %',
        v_server_total, p_expected_total;
    END IF;
  END IF;

  -- ── Non-validated promo check (legacy path, UNCHANGED from M393) ──
  IF NOT p_validate_products AND p_promo_code_id IS NOT NULL THEN
    SELECT id, max_uses, current_uses INTO v_promo
    FROM promo_codes WHERE id = p_promo_code_id FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'promo_not_found');
    END IF;

    IF v_promo.max_uses IS NOT NULL THEN
      SELECT count(*) INTO v_active_count
      FROM promo_reservations
      WHERE promo_code_id = p_promo_code_id
        AND state = 'reserved';

      IF (v_promo.current_uses + v_active_count) >= v_promo.max_uses THEN
        RETURN jsonb_build_object('error', 'promo_exhausted');
      END IF;
    END IF;
  END IF;

  -- ── Phase 3: Mutations ──

  -- 3a. Stock decrement (UNCHANGED from M393)
  IF p_validate_products THEN
    FOR v_item IN
      SELECT * FROM jsonb_array_elements(p_items) AS elem
      ORDER BY elem->>'product_id', elem->>'variant_id'
    LOOP
      IF NULLIF(v_item->>'variant_id', '') IS NOT NULL THEN
        UPDATE product_variants
        SET stock_quantity = stock_quantity - (v_item->>'quantity')::int
        WHERE id = (v_item->>'variant_id')::uuid
          AND stock_quantity IS NOT NULL
          AND stock_quantity >= (v_item->>'quantity')::int;

        IF NOT FOUND THEN
          IF EXISTS (
            SELECT 1 FROM product_variants
            WHERE id = (v_item->>'variant_id')::uuid AND stock_quantity IS NOT NULL
          ) THEN
            RAISE EXCEPTION 'insufficient_stock:Variant % has insufficient stock', v_item->>'variant_id';
          END IF;
        END IF;
      ELSE
        UPDATE products
        SET stock_quantity = stock_quantity - (v_item->>'quantity')::int
        WHERE id = (v_item->>'product_id')::uuid
          AND track_inventory = true
          AND stock_quantity IS NOT NULL
          AND stock_quantity >= (v_item->>'quantity')::int;

        IF NOT FOUND THEN
          IF EXISTS (
            SELECT 1 FROM products
            WHERE id = (v_item->>'product_id')::uuid
              AND track_inventory = true
              AND stock_quantity IS NOT NULL
          ) THEN
            RAISE EXCEPTION 'insufficient_stock:Product % has insufficient stock', v_item->>'product_id';
          END IF;
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- 3b. Order INSERT
  -- M435: Store SERVER-COMPUTED discount_amount and volume_discount_amount
  INSERT INTO orders (
    bot_session_id, business_id, user_id, status,
    delivery_address, delivery_phone, total_amount,
    discount_amount, shipping_cost, promo_code_id, channel, notes,
    delivery_zone_id, delivery_zone_name, addons_total, volume_discount_amount,
    pickup_address, dropoff_address, package_description, package_photo_url,
    referral_id, items_fingerprint
  ) VALUES (
    p_bot_session_id, p_business_id, p_user_id, p_status::order_status,
    p_delivery_address, p_delivery_phone,
    CASE WHEN p_validate_products THEN v_server_total ELSE p_total_amount END,
    CASE WHEN p_validate_products THEN v_server_discount ELSE p_discount_amount END,
    p_shipping_cost, p_promo_code_id, p_channel, p_notes,
    p_delivery_zone_id,
    CASE WHEN v_zone_name IS NOT NULL THEN v_zone_name
         ELSE p_delivery_zone_name END,
    CASE WHEN p_validate_products THEN v_server_addons_total ELSE p_addons_total END,
    CASE WHEN p_validate_products THEN v_server_volume_discount ELSE p_volume_discount_amount END,
    p_pickup_address, p_dropoff_address, p_package_description, p_package_photo_url,
    p_referral_id, v_fingerprint
  )
  RETURNING id, reference_code INTO v_order_id, v_ref;

  -- 3c. Items INSERT with server-authoritative prices (UNCHANGED from M393)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF p_validate_products THEN
      IF NULLIF(v_item->>'variant_id', '') IS NOT NULL THEN
        SELECT price INTO v_variant FROM product_variants WHERE id = (v_item->>'variant_id')::uuid;
        INSERT INTO order_items (order_id, product_id, quantity, unit_price, variant_id, variant_label, addons)
        VALUES (
          v_order_id,
          (v_item->>'product_id')::uuid,
          (v_item->>'quantity')::int,
          v_variant.price,
          (v_item->>'variant_id')::uuid,
          NULLIF(v_item->>'variant_label', ''),
          CASE WHEN v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb
               THEN v_item->'addons' ELSE NULL END
        );
      ELSE
        SELECT price INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
        INSERT INTO order_items (order_id, product_id, quantity, unit_price, variant_id, variant_label, addons)
        VALUES (
          v_order_id,
          (v_item->>'product_id')::uuid,
          (v_item->>'quantity')::int,
          v_product.price,
          NULL,
          NULLIF(v_item->>'variant_label', ''),
          CASE WHEN v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb
               THEN v_item->'addons' ELSE NULL END
        );
      END IF;
    ELSE
      INSERT INTO order_items (order_id, product_id, quantity, unit_price, variant_id, variant_label, addons)
      VALUES (
        v_order_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'quantity')::int,
        (v_item->>'unit_price')::numeric,
        NULLIF(v_item->>'variant_id', '')::uuid,
        NULLIF(v_item->>'variant_label', ''),
        CASE WHEN v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb
             THEN v_item->'addons' ELSE NULL END
      );
    END IF;
  END LOOP;

  -- 3d. Stock marker (UNCHANGED from M393)
  IF p_validate_products THEN
    IF p_status = 'confirmed' THEN
      INSERT INTO order_stock_applications (order_id, payment_id, reservation_class, expires_at)
      VALUES (v_order_id, NULL, 'committed', NULL);
    ELSE
      INSERT INTO order_stock_applications (order_id, payment_id, reservation_class, expires_at)
      VALUES (v_order_id, NULL, 'instant', NOW() + INTERVAL '30 minutes');
    END IF;
  END IF;

  -- 3e. Promo reservation (UNCHANGED from M393)
  IF p_promo_code_id IS NOT NULL THEN
    IF p_status = 'confirmed' THEN
      INSERT INTO promo_reservations (order_id, promo_code_id, state)
      VALUES (v_order_id, p_promo_code_id, 'finalized');
      UPDATE promo_codes SET current_uses = current_uses + 1
      WHERE id = p_promo_code_id;
    ELSE
      INSERT INTO promo_reservations (order_id, promo_code_id, state)
      VALUES (v_order_id, p_promo_code_id, 'reserved');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'reference_code', v_ref,
    'created', true,
    'items_fingerprint', v_fingerprint,
    'server_total', CASE WHEN p_validate_products THEN v_server_total ELSE NULL END,
    'server_discount', CASE WHEN p_validate_products THEN v_server_discount ELSE NULL END,
    'server_volume_discount', CASE WHEN p_validate_products THEN v_server_volume_discount ELSE NULL END
  );
END;
$function$
;
ALTER FUNCTION public.create_order_atomic(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,uuid,text,text,uuid,text,numeric,numeric,text,text,text,text,jsonb,uuid,boolean,numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_order_atomic(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,uuid,text,text,uuid,text,numeric,numeric,text,text,text,text,jsonb,uuid,boolean,numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_order_atomic(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,uuid,text,text,uuid,text,numeric,numeric,text,text,text,text,jsonb,uuid,boolean,numeric) TO service_role;

-- public.get_business_revenue: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.get_business_revenue(p_business_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_id = auth.uid()) THEN
    RETURN 0;
  END IF;
  RETURN (SELECT COALESCE(SUM(transaction_amount), 0)::numeric FROM platform_fees WHERE business_id = p_business_id AND refunded_at IS NULL);
END;
$function$
;
ALTER FUNCTION public.get_business_revenue(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_business_revenue(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_business_revenue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_business_revenue(uuid) TO service_role;

-- public.get_business_revenue_totals: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.get_business_revenue_totals(p_business_id uuid)
 RETURNS TABLE(booking_revenue numeric, order_revenue numeric, invoice_revenue numeric, total_revenue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking numeric;
  v_order numeric;
  v_invoice numeric;
BEGIN
  -- Ownership check
  IF NOT EXISTS (
    SELECT 1 FROM public.businesses WHERE id = p_business_id AND owner_id = auth.uid()
  ) THEN
    booking_revenue := 0; order_revenue := 0; invoice_revenue := 0; total_revenue := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Booking revenue: payment-aware net settlement.
  -- Payment-backed bookings: only count successful payments, minus completed refunds.
  -- Non-payment bookings: use booking total_amount/deposit_amount (scheduling, etc.).
  -- Deduplication: DISTINCT ON (booking_id) picks the successful payment when
  -- multiple attempts exist (failed → retry → success).
  -- Booking revenue: payment-aware net settlement.
  -- Payment-backed bookings: only count successful payments, minus completed refunds.
  -- Non-payment bookings: use booking total_amount/deposit_amount (scheduling, etc.).
  -- Deduplication: DISTINCT ON (booking_id) picks the successful payment when
  -- multiple attempts exist (failed -> retry -> success).
  SELECT COALESCE(SUM(net_amount), 0)::numeric INTO v_booking
  FROM (
    -- Payment-backed bookings: net = settled - completed_refunds
    -- Wrapped in subquery because DISTINCT ON + ORDER BY cannot directly UNION
    SELECT net_amount FROM (
      SELECT DISTINCT ON (p.booking_id)
        GREATEST(
          CASE WHEN p.status IN ('success', 'refunded') THEN p.amount ELSE 0 END
          - COALESCE((
            SELECT SUM(r.amount) FROM public.refunds r
            WHERE r.payment_id = p.id AND r.status = 'success'
          ), 0),
          0
        ) AS net_amount
      FROM public.payments p
      JOIN public.bookings b ON b.id = p.booking_id
      WHERE p.business_id = p_business_id
        AND p.booking_id IS NOT NULL
        AND b.status NOT IN ('cancelled', 'no_show')
      ORDER BY p.booking_id, (p.status IN ('success', 'refunded')) DESC, p.created_at DESC
    ) payment_net

    UNION ALL

    -- Non-payment bookings: no linked payment row
    SELECT COALESCE(b.total_amount, b.deposit_amount, 0) AS net_amount
    FROM public.bookings b
    WHERE b.business_id = p_business_id
      AND b.status NOT IN ('cancelled', 'no_show')
      AND NOT EXISTS (
        SELECT 1 FROM public.payments p WHERE p.booking_id = b.id
      )
  ) sub;

  SELECT COALESCE(SUM(COALESCE(o.total_amount, 0)), 0)::numeric INTO v_order
  FROM public.orders o
  WHERE o.business_id = p_business_id
    AND o.deleted_at IS NULL
    AND o.status IN ('confirmed', 'processing', 'ready', 'shipped', 'delivered');

  SELECT COALESCE(SUM(COALESCE(inv.amount_paid, inv.total_amount, 0)), 0)::numeric INTO v_invoice
  FROM public.invoices inv
  WHERE inv.business_id = p_business_id
    AND inv.status = 'paid';

  booking_revenue := v_booking;
  order_revenue := v_order;
  invoice_revenue := v_invoice;
  total_revenue := v_booking + v_order + v_invoice;
  RETURN NEXT;
END;
$function$
;
ALTER FUNCTION public.get_business_revenue_totals(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_business_revenue_totals(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_business_revenue_totals(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_business_revenue_totals(uuid) TO service_role;

-- public.get_business_transactions: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.get_business_transactions(p_business_id uuid, p_limit integer DEFAULT 500, p_offset integer DEFAULT 0)
 RETURNS TABLE(txn_id uuid, txn_type text, flow_type text, reference_code text, purpose text, customer_name text, amount numeric, status text, event_date timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Ownership check
  IF NOT EXISTS (
    SELECT 1 FROM public.businesses WHERE id = p_business_id AND owner_id = auth.uid()
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  (
    -- Bookings: join services for purpose, resolve customer from guest_name
    -- or customer_profiles with durable-ID-first (phone fallback only when
    -- source booking user_id IS NULL)
    SELECT
      b.id AS txn_id,
      'booking'::TEXT AS txn_type,
      COALESCE(b.flow_type::TEXT, 'booking') AS flow_type,
      b.reference_code::TEXT,
      CASE
        WHEN b.flow_type = 'payment' AND s.service_type = 'giving'
          THEN 'Giving' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
        WHEN b.flow_type = 'payment'
          THEN 'Payment' || E' \u2014 ' || b.reference_code
        WHEN b.flow_type = 'ticketing'
          THEN 'Ticket' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
        ELSE 'Booking' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
      END::TEXT AS purpose,
      COALESCE(b.guest_name, cp_u.name, cp_p.name)::TEXT AS customer_name,
      COALESCE(b.total_amount, b.deposit_amount, 0)::numeric AS amount,
      b.status::TEXT,
      b.created_at AS event_date
    FROM public.bookings b
    LEFT JOIN public.services s ON s.id = b.service_id
    LEFT JOIN public.customer_profiles cp_u
      ON cp_u.business_id = b.business_id AND cp_u.user_id = b.user_id
      AND b.user_id IS NOT NULL
    LEFT JOIN public.customer_profiles cp_p
      ON cp_p.business_id = b.business_id AND cp_p.phone = b.guest_phone
      AND b.user_id IS NULL       -- source must be legacy (no durable identity)
      AND cp_p.user_id IS NULL    -- target must also be unlinked (not owned by another user)
    WHERE b.business_id = p_business_id

    UNION ALL

    -- Orders: resolve customer from customer_profiles by user_id (primary)
    -- or delivery_phone (fallback ONLY when source order has no user_id).
    -- Never from profiles RLS.
    SELECT
      o.id AS txn_id,
      'order'::TEXT AS txn_type,
      'ordering'::TEXT AS flow_type,
      o.reference_code::TEXT,
      ('Order' || E' \u2014 ' || o.reference_code)::TEXT AS purpose,
      COALESCE(cp_u.name, cp_p.name)::TEXT AS customer_name,
      COALESCE(o.total_amount, 0)::numeric AS amount,
      o.status::TEXT,
      o.created_at AS event_date
    FROM public.orders o
    LEFT JOIN public.customer_profiles cp_u
      ON cp_u.business_id = o.business_id AND cp_u.user_id = o.user_id
      AND o.user_id IS NOT NULL
    LEFT JOIN public.customer_profiles cp_p
      ON cp_p.business_id = o.business_id AND cp_p.phone = o.delivery_phone
      AND o.user_id IS NULL       -- source must be legacy (no durable identity)
      AND cp_p.user_id IS NULL    -- target must also be unlinked (not owned by another user)
    WHERE o.business_id = p_business_id
      AND o.deleted_at IS NULL

    UNION ALL

    -- Invoices: customer_name is denormalized on the invoice
    SELECT
      inv.id AS txn_id,
      'invoice'::TEXT AS txn_type,
      'invoice'::TEXT AS flow_type,
      inv.reference_code::TEXT,
      ('Invoice' || E' \u2014 ' || inv.reference_code)::TEXT AS purpose,
      inv.customer_name::TEXT AS customer_name,
      COALESCE(inv.amount_paid, inv.total_amount, 0)::numeric AS amount,
      inv.status::TEXT,
      COALESCE(inv.paid_at, inv.created_at) AS event_date
    FROM public.invoices inv
    WHERE inv.business_id = p_business_id
  )
  ORDER BY event_date DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$function$
;
ALTER FUNCTION public.get_business_transactions(uuid,integer,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_business_transactions(uuid,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_business_transactions(uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_business_transactions(uuid,integer,integer) TO service_role;

-- public.get_customer_history: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.get_customer_history(p_business_id uuid, p_customer_profile_id uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(history_type text, subject_id uuid, reference_code text, purpose text, amount numeric, currency text, status text, event_date timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_phone TEXT;
  v_user_id UUID;
BEGIN
  -- Ownership check
  IF NOT EXISTS (
    SELECT 1 FROM public.businesses WHERE id = p_business_id AND owner_id = auth.uid()
  ) THEN
    RETURN;
  END IF;

  -- Load customer identity
  SELECT cp.phone, cp.user_id INTO v_phone, v_user_id
  FROM public.customer_profiles cp
  WHERE cp.id = p_customer_profile_id AND cp.business_id = p_business_id;

  IF v_phone IS NULL AND v_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  (
    -- Bookings: durable user_id primary; phone fallback ONLY for legacy rows
    -- where source booking has no user_id (prevents cross-attribution on shared phones)
    SELECT
      'booking'::TEXT AS history_type,
      b.id AS subject_id,
      b.reference_code::TEXT,
      CASE
        WHEN b.flow_type = 'payment' AND s.service_type = 'giving'
          THEN 'Giving' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
        WHEN b.flow_type = 'payment'
          THEN 'Payment' || E' \u2014 ' || b.reference_code
        WHEN b.flow_type = 'ticketing'
          THEN 'Ticket' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
        WHEN b.flow_type = 'scheduling'
          THEN 'Booking' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
        ELSE COALESCE(initcap(b.flow_type::TEXT), 'Booking') || E' \u2014 ' || COALESCE(s.name, b.reference_code)
      END::TEXT AS purpose,
      COALESCE(b.total_amount, b.deposit_amount, 0)::numeric AS amount,
      'NGN'::TEXT AS currency,
      b.status::TEXT,
      COALESCE(b.date::TIMESTAMPTZ, b.created_at) AS event_date
    FROM public.bookings b
    LEFT JOIN public.services s ON s.id = b.service_id
    WHERE b.business_id = p_business_id
      AND (
        (v_user_id IS NOT NULL AND b.user_id = v_user_id)
        OR (v_phone IS NOT NULL AND b.user_id IS NULL AND b.guest_phone = v_phone)
      )

    UNION ALL

    -- Orders: durable user_id primary; phone fallback ONLY for legacy rows
    SELECT
      'order'::TEXT AS history_type,
      o.id AS subject_id,
      o.reference_code::TEXT,
      ('Order' || E' \u2014 ' || o.reference_code)::TEXT AS purpose,
      COALESCE(o.total_amount, 0)::numeric AS amount,
      'NGN'::TEXT AS currency,
      o.status::TEXT,
      o.created_at AS event_date
    FROM public.orders o
    WHERE o.business_id = p_business_id
      AND o.deleted_at IS NULL
      AND (
        (v_user_id IS NOT NULL AND o.user_id = v_user_id)
        OR (v_phone IS NOT NULL AND o.user_id IS NULL AND o.delivery_phone = v_phone)
      )

    UNION ALL

    -- Standalone payments (no linked booking — avoids double-counting)
    SELECT
      'payment'::TEXT AS history_type,
      p.id AS subject_id,
      p.gateway_reference::TEXT AS reference_code,
      CASE
        WHEN s.service_type = 'giving'
          THEN 'Giving' || E' \u2014 ' || COALESCE(s.name, p.gateway_reference)
        ELSE 'Payment' || E' \u2014 ' || p.gateway_reference
      END::TEXT AS purpose,
      COALESCE(p.amount, 0)::numeric AS amount,
      COALESCE(p.currency, 'NGN')::TEXT AS currency,
      p.status::TEXT,
      COALESCE(p.paid_at, p.created_at) AS event_date
    FROM public.payments p
    LEFT JOIN public.bookings pb ON pb.id = p.booking_id
    LEFT JOIN public.services s ON s.id = pb.service_id
    WHERE p.business_id = p_business_id
      AND p.booking_id IS NULL
      AND v_user_id IS NOT NULL
      AND p.user_id = v_user_id
  )
  ORDER BY event_date DESC
  LIMIT p_limit;
END;
$function$
;
ALTER FUNCTION public.get_customer_history(uuid,uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_customer_history(uuid,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_customer_history(uuid,uuid,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_history(uuid,uuid,integer) TO service_role;

-- public.get_order_revenue: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.get_order_revenue(p_business_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_id = auth.uid()) THEN
    RETURN 0;
  END IF;
  RETURN (SELECT COALESCE(SUM(total_amount), 0)::numeric FROM orders WHERE business_id = p_business_id AND deleted_at IS NULL AND status IN ('confirmed','processing','ready','shipped','delivered'));
END;
$function$
;
ALTER FUNCTION public.get_order_revenue(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_order_revenue(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_order_revenue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_revenue(uuid) TO service_role;

-- public.accept_order_quote_atomic: precision only; authorization and routing preserved.
CREATE OR REPLACE FUNCTION public.accept_order_quote_atomic(p_quote_id uuid, p_customer_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quote RECORD;
  v_biz RECORD;
  v_trusted TEXT;
  v_stored TEXT;
  v_total NUMERIC;
  v_deposit_pct INTEGER;
  v_deposit_amount NUMERIC;
  v_balance_amount NUMERIC;
  v_order_id UUID;
  v_ref TEXT;
  v_item JSONB;
  v_existing_order RECORD;
  v_stock_result JSONB;
  v_custom_config JSONB;
  v_has_custom_data BOOLEAN;
  v_product RECORD;
  v_variant RECORD;
  v_addon RECORD;
  v_addon_entry JSONB;
  v_addon_id UUID;
BEGIN
  -- 1. Identity validation: fail closed
  v_trusted := regexp_replace(COALESCE(p_customer_phone, ''), '^\+', '');
  IF v_trusted = '' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'identity_missing');
  END IF;

  -- 2. Lock quote row
  SELECT * INTO v_quote
  FROM quote_requests WHERE id = p_quote_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_found');
  END IF;

  -- 3. Verify identity
  v_stored := regexp_replace(COALESCE(v_quote.customer_phone, ''), '^\+', '');
  IF v_stored = '' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'quote_phone_missing');
  END IF;
  IF v_trusted != v_stored THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'identity_mismatch');
  END IF;

  -- 4. Status checks
  IF v_quote.status = 'accepted' THEN
    SELECT id, reference_code, total_amount, deposit_amount, balance_amount
    INTO v_existing_order
    FROM orders WHERE quote_request_id = p_quote_id LIMIT 1;
    RETURN jsonb_build_object(
      'accepted', true, 'already_accepted', true,
      'order_id', v_existing_order.id,
      'reference_code', v_existing_order.reference_code,
      'total', COALESCE(v_existing_order.total_amount, 0),
      'deposit_amount', COALESCE(v_existing_order.deposit_amount, 0),
      'balance_amount', COALESCE(v_existing_order.balance_amount, 0),
      'customer_phone', v_quote.customer_phone,
      'business_id', v_quote.business_id
    );
  END IF;

  IF v_quote.status = 'rejected' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'already_rejected');
  END IF;
  IF v_quote.status = 'expired' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'expired');
  END IF;
  IF v_quote.status = 'cancelled' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'cancelled');
  END IF;
  IF v_quote.status = 'pending' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_yet_quoted');
  END IF;
  IF v_quote.status != 'quoted' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'invalid_status');
  END IF;

  -- 5. Check expiry
  IF v_quote.expires_at IS NOT NULL AND v_quote.expires_at < NOW() THEN
    UPDATE quote_requests SET status = 'expired' WHERE id = p_quote_id;
    RETURN jsonb_build_object('accepted', false, 'reason', 'expired');
  END IF;

  -- 6. Derive total — fail closed on NULL quoted_amount
  IF v_quote.quoted_amount IS NULL THEN
    RAISE EXCEPTION 'quoted_amount_missing:Quote % has no quoted_amount — cannot accept', p_quote_id;
  END IF;
  v_total := v_quote.quoted_amount;

  SELECT id, name, country_code, subscription_tier, trial_ends_at, metadata
  INTO v_biz FROM businesses WHERE id = v_quote.business_id;

  v_has_custom_data := v_quote.custom_order_data IS NOT NULL;
  v_custom_config := COALESCE(v_biz.metadata->'custom_order_config', '{}'::jsonb);
  v_deposit_pct := CASE
    WHEN v_has_custom_data THEN COALESCE((v_custom_config->>'deposit_percentage')::int, 0)
    ELSE 0
  END;
  v_deposit_amount := CASE WHEN v_deposit_pct > 0 THEN trunc(v_total * v_deposit_pct / 100) ELSE 0 END;
  v_balance_amount := CASE WHEN v_deposit_pct > 0 THEN v_total - v_deposit_amount ELSE 0 END;

  -- 7. Phase 2: Product/variant/addon validation from cart_snapshot
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_quote.cart_snapshot, '[]'::jsonb))
  LOOP
    -- Validate product
    IF v_item->>'product_id' IS NOT NULL THEN
      SELECT id, is_active, deleted_at, business_id
      INTO v_product
      FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'product_not_found:Product % in quote cart does not exist', v_item->>'product_id';
      END IF;
      IF NOT v_product.is_active THEN
        RAISE EXCEPTION 'product_unavailable:Product % is no longer active', v_item->>'product_id';
      END IF;
      IF v_product.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'product_deleted:Product % has been deleted', v_item->>'product_id';
      END IF;
      IF v_product.business_id != v_quote.business_id THEN
        RAISE EXCEPTION 'product_wrong_business:Product % does not belong to this business', v_item->>'product_id';
      END IF;

      -- Validate variant
      IF NULLIF(v_item->>'variant_id', '') IS NOT NULL THEN
        SELECT id, product_id, is_active
        INTO v_variant
        FROM product_variants WHERE id = (v_item->>'variant_id')::uuid FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'variant_not_found:Variant % does not exist', v_item->>'variant_id';
        END IF;
        IF NOT v_variant.is_active THEN
          RAISE EXCEPTION 'variant_unavailable:Variant % is no longer active', v_item->>'variant_id';
        END IF;
        IF v_variant.product_id != (v_item->>'product_id')::uuid THEN
          RAISE EXCEPTION 'variant_wrong_product:Variant % does not belong to product %',
            v_item->>'variant_id', v_item->>'product_id';
        END IF;
      END IF;

      -- Validate addons
      IF v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb THEN
        FOR v_addon_entry IN SELECT * FROM jsonb_array_elements(v_item->'addons')
        LOOP
          -- snapshot_version-gated addon ID requirement
          IF v_addon_entry->>'id' IS NULL OR v_addon_entry->>'id' = '' THEN
            IF COALESCE(v_quote.snapshot_version, 1) >= 2 THEN
              RAISE EXCEPTION 'addon_missing_id:v2 snapshot requires addon id in product %', v_item->>'product_id';
            END IF;
            -- v1: permissive — skip validation for this addon
            CONTINUE;
          END IF;

          v_addon_id := (v_addon_entry->>'id')::uuid;

          SELECT id, is_active, business_id, product_id
          INTO v_addon
          FROM product_addons WHERE id = v_addon_id FOR UPDATE;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'addon_not_found:Addon % does not exist', v_addon_id;
          END IF;
          IF NOT v_addon.is_active THEN
            RAISE EXCEPTION 'addon_unavailable:Addon % is no longer active', v_addon_id;
          END IF;
          IF v_addon.business_id != v_quote.business_id THEN
            RAISE EXCEPTION 'addon_wrong_business:Addon % does not belong to this business', v_addon_id;
          END IF;
          -- product_id binding: NULL = business-wide, or must match
          IF v_addon.product_id IS NOT NULL AND v_addon.product_id != (v_item->>'product_id')::uuid THEN
            RAISE EXCEPTION 'addon_wrong_product:Addon % does not belong to product %',
              v_addon_id, v_item->>'product_id';
          END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;

  -- 8. Create order
  INSERT INTO orders (
    business_id, user_id, status,
    delivery_address, delivery_phone, total_amount,
    delivery_zone_id, delivery_zone_name,
    quote_request_id, channel, notes,
    custom_order_data,
    deposit_percentage, deposit_amount, balance_amount
  ) VALUES (
    v_quote.business_id,
    v_quote.user_id,
    CASE WHEN v_total > 0 THEN 'pending'::order_status ELSE 'confirmed'::order_status END,
    v_quote.delivery_address,
    v_quote.customer_phone,
    v_total,
    v_quote.delivery_zone_id,
    v_quote.delivery_zone_name,
    p_quote_id,
    COALESCE(v_quote.channel, 'whatsapp'),
    v_quote.quote_notes,
    v_quote.custom_order_data,
    CASE WHEN v_deposit_pct > 0 THEN v_deposit_pct ELSE NULL END,
    v_deposit_amount,
    v_balance_amount
  ) RETURNING id, reference_code INTO v_order_id, v_ref;

  -- 9. Create order items from cart_snapshot
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_quote.cart_snapshot, '[]'::jsonb))
  LOOP
    INSERT INTO order_items (
      order_id, product_id, quantity, unit_price,
      variant_id, variant_label, addons
    ) VALUES (
      v_order_id,
      (v_item->>'product_id')::uuid,
      COALESCE((v_item->>'quantity')::int, 1),
      COALESCE((v_item->>'price')::numeric, 0),
      NULLIF(v_item->>'variant_id', '')::uuid,
      NULLIF(v_item->>'variant_label', ''),
      CASE WHEN v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb
           THEN v_item->'addons' ELSE NULL END
    );
  END LOOP;

  -- 10. Reserve inventory via canonical RPC (same transaction)
  v_stock_result := apply_order_stock_once(v_order_id, NULL, true);

  IF NOT (v_stock_result->>'applied')::boolean THEN
    RAISE EXCEPTION 'stock_application_failed:%', v_stock_result->>'reason';
  END IF;

  -- 11. Update quote
  UPDATE quote_requests SET
    status = 'accepted',
    order_id = v_order_id,
    responded_at = NOW()
  WHERE id = p_quote_id;

  RETURN jsonb_build_object(
    'accepted', true,
    'already_accepted', false,
    'order_id', v_order_id,
    'reference_code', v_ref,
    'total', v_total,
    'deposit_amount', v_deposit_amount,
    'balance_amount', v_balance_amount,
    'customer_phone', v_quote.customer_phone,
    'business_id', v_quote.business_id
  );
END;
$function$
;
ALTER FUNCTION public.accept_order_quote_atomic(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accept_order_quote_atomic(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_order_quote_atomic(uuid,text) TO service_role;

-- Final-state signature/grant/type assertions. No integer overload is retained.
DO $verify$
DECLARE r record;
BEGIN
  IF to_regprocedure('private.scheduling_604_create_booking(jsonb,text,uuid)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: scheduling_604_create_booking'; END IF;
  IF has_function_privilege('anon','private.scheduling_604_create_booking(jsonb,text,uuid)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: scheduling_604_create_booking'; END IF;
  IF has_function_privilege('authenticated','private.scheduling_604_create_booking(jsonb,text,uuid)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 authenticated grant: scheduling_604_create_booking'; END IF;
  IF has_function_privilege('service_role','private.scheduling_604_create_booking(jsonb,text,uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: scheduling_604_create_booking'; END IF;
  IF to_regprocedure('private.scheduling_604_quote(uuid,uuid,uuid,integer,jsonb,uuid,jsonb)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: scheduling_604_quote'; END IF;
  IF has_function_privilege('anon','private.scheduling_604_quote(uuid,uuid,uuid,integer,jsonb,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: scheduling_604_quote'; END IF;
  IF has_function_privilege('authenticated','private.scheduling_604_quote(uuid,uuid,uuid,integer,jsonb,uuid,jsonb)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 authenticated grant: scheduling_604_quote'; END IF;
  IF has_function_privilege('service_role','private.scheduling_604_quote(uuid,uuid,uuid,integer,jsonb,uuid,jsonb)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 service_role grant: scheduling_604_quote'; END IF;
  IF to_regprocedure('public.apply_payment_customer_visit_once(uuid)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: apply_payment_customer_visit_once'; END IF;
  IF has_function_privilege('anon','public.apply_payment_customer_visit_once(uuid)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: apply_payment_customer_visit_once'; END IF;
  IF has_function_privilege('authenticated','public.apply_payment_customer_visit_once(uuid)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 authenticated grant: apply_payment_customer_visit_once'; END IF;
  IF has_function_privilege('service_role','public.apply_payment_customer_visit_once(uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: apply_payment_customer_visit_once'; END IF;
  IF to_regprocedure('public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,numeric,text,integer,integer,uuid,uuid,jsonb)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: book_manual_slot_authoritative_604'; END IF;
  IF to_regprocedure('public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,integer,integer,uuid,uuid,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'M529 ambiguous overload: book_manual_slot_authoritative_604'; END IF;
  IF has_function_privilege('anon','public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,numeric,text,integer,integer,uuid,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: book_manual_slot_authoritative_604'; END IF;
  IF has_function_privilege('authenticated','public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,numeric,text,integer,integer,uuid,uuid,jsonb)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 authenticated grant: book_manual_slot_authoritative_604'; END IF;
  IF has_function_privilege('service_role','public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,numeric,text,integer,integer,uuid,uuid,jsonb)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: book_manual_slot_authoritative_604'; END IF;
  IF to_regprocedure('public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: book_slot_authoritative_604'; END IF;
  IF to_regprocedure('public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'M529 ambiguous overload: book_slot_authoritative_604'; END IF;
  IF has_function_privilege('anon','public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: book_slot_authoritative_604'; END IF;
  IF has_function_privilege('authenticated','public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 authenticated grant: book_slot_authoritative_604'; END IF;
  IF has_function_privilege('service_role','public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: book_slot_authoritative_604'; END IF;
  IF to_regprocedure('public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: book_with_package_authoritative_604'; END IF;
  IF to_regprocedure('public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'M529 ambiguous overload: book_with_package_authoritative_604'; END IF;
  IF has_function_privilege('anon','public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: book_with_package_authoritative_604'; END IF;
  IF has_function_privilege('authenticated','public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 authenticated grant: book_with_package_authoritative_604'; END IF;
  IF has_function_privilege('service_role','public.book_with_package_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,uuid,jsonb)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: book_with_package_authoritative_604'; END IF;
  IF to_regprocedure('public.claim_payment_finalization_with_verified_fee(uuid,text,text,numeric,text,boolean,numeric)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: claim_payment_finalization_with_verified_fee'; END IF;
  IF has_function_privilege('anon','public.claim_payment_finalization_with_verified_fee(uuid,text,text,numeric,text,boolean,numeric)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: claim_payment_finalization_with_verified_fee'; END IF;
  IF has_function_privilege('authenticated','public.claim_payment_finalization_with_verified_fee(uuid,text,text,numeric,text,boolean,numeric)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 authenticated grant: claim_payment_finalization_with_verified_fee'; END IF;
  IF has_function_privilege('service_role','public.claim_payment_finalization_with_verified_fee(uuid,text,text,numeric,text,boolean,numeric)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: claim_payment_finalization_with_verified_fee'; END IF;
  IF to_regprocedure('public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: confirm_nonorder_transfer_atomic'; END IF;
  IF has_function_privilege('anon','public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: confirm_nonorder_transfer_atomic'; END IF;
  IF has_function_privilege('authenticated','public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 authenticated grant: confirm_nonorder_transfer_atomic'; END IF;
  IF has_function_privilege('service_role','public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: confirm_nonorder_transfer_atomic'; END IF;
  IF to_regprocedure('public.create_catalog_order_atomic(uuid,uuid,text,text,text,jsonb)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: create_catalog_order_atomic'; END IF;
  IF has_function_privilege('anon','public.create_catalog_order_atomic(uuid,uuid,text,text,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: create_catalog_order_atomic'; END IF;
  IF has_function_privilege('authenticated','public.create_catalog_order_atomic(uuid,uuid,text,text,text,jsonb)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 authenticated grant: create_catalog_order_atomic'; END IF;
  IF has_function_privilege('service_role','public.create_catalog_order_atomic(uuid,uuid,text,text,text,jsonb)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: create_catalog_order_atomic'; END IF;
  IF to_regprocedure('public.create_order_atomic(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,uuid,text,text,uuid,text,numeric,numeric,text,text,text,text,jsonb,uuid,boolean,numeric)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: create_order_atomic'; END IF;
  IF to_regprocedure('public.create_order_atomic(uuid,uuid,uuid,text,text,text,integer,integer,integer,uuid,text,text,uuid,text,integer,integer,text,text,text,text,jsonb,uuid,boolean,integer)') IS NOT NULL THEN RAISE EXCEPTION 'M529 ambiguous overload: create_order_atomic'; END IF;
  IF has_function_privilege('anon','public.create_order_atomic(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,uuid,text,text,uuid,text,numeric,numeric,text,text,text,text,jsonb,uuid,boolean,numeric)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: create_order_atomic'; END IF;
  IF has_function_privilege('authenticated','public.create_order_atomic(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,uuid,text,text,uuid,text,numeric,numeric,text,text,text,text,jsonb,uuid,boolean,numeric)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 authenticated grant: create_order_atomic'; END IF;
  IF has_function_privilege('service_role','public.create_order_atomic(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,uuid,text,text,uuid,text,numeric,numeric,text,text,text,text,jsonb,uuid,boolean,numeric)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: create_order_atomic'; END IF;
  IF to_regprocedure('public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: book_slot_atomic'; END IF;
  IF to_regprocedure('public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer)') IS NOT NULL THEN RAISE EXCEPTION 'M529 ambiguous overload: book_slot_atomic'; END IF;
  IF has_function_privilege('anon','public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: book_slot_atomic'; END IF;
  IF has_function_privilege('authenticated','public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 authenticated grant: book_slot_atomic'; END IF;
  IF has_function_privilege('service_role','public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: book_slot_atomic'; END IF;
  IF to_regprocedure('public.get_business_revenue(uuid)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: get_business_revenue'; END IF;
  IF has_function_privilege('anon','public.get_business_revenue(uuid)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: get_business_revenue'; END IF;
  IF has_function_privilege('authenticated','public.get_business_revenue(uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 authenticated grant: get_business_revenue'; END IF;
  IF has_function_privilege('service_role','public.get_business_revenue(uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: get_business_revenue'; END IF;
  IF to_regprocedure('public.get_business_revenue_totals(uuid)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: get_business_revenue_totals'; END IF;
  IF has_function_privilege('anon','public.get_business_revenue_totals(uuid)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: get_business_revenue_totals'; END IF;
  IF has_function_privilege('authenticated','public.get_business_revenue_totals(uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 authenticated grant: get_business_revenue_totals'; END IF;
  IF has_function_privilege('service_role','public.get_business_revenue_totals(uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: get_business_revenue_totals'; END IF;
  IF to_regprocedure('public.get_business_transactions(uuid,integer,integer)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: get_business_transactions'; END IF;
  IF has_function_privilege('anon','public.get_business_transactions(uuid,integer,integer)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: get_business_transactions'; END IF;
  IF has_function_privilege('authenticated','public.get_business_transactions(uuid,integer,integer)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 authenticated grant: get_business_transactions'; END IF;
  IF has_function_privilege('service_role','public.get_business_transactions(uuid,integer,integer)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: get_business_transactions'; END IF;
  IF to_regprocedure('public.get_customer_history(uuid,uuid,integer)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: get_customer_history'; END IF;
  IF has_function_privilege('anon','public.get_customer_history(uuid,uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: get_customer_history'; END IF;
  IF has_function_privilege('authenticated','public.get_customer_history(uuid,uuid,integer)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 authenticated grant: get_customer_history'; END IF;
  IF has_function_privilege('service_role','public.get_customer_history(uuid,uuid,integer)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: get_customer_history'; END IF;
  IF to_regprocedure('public.get_order_revenue(uuid)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: get_order_revenue'; END IF;
  IF has_function_privilege('anon','public.get_order_revenue(uuid)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: get_order_revenue'; END IF;
  IF has_function_privilege('authenticated','public.get_order_revenue(uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 authenticated grant: get_order_revenue'; END IF;
  IF has_function_privilege('service_role','public.get_order_revenue(uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: get_order_revenue'; END IF;
  IF to_regprocedure('public.accept_order_quote_atomic(uuid,text)') IS NULL THEN RAISE EXCEPTION 'M529 missing function: accept_order_quote_atomic'; END IF;
  IF has_function_privilege('anon','public.accept_order_quote_atomic(uuid,text)','EXECUTE') THEN RAISE EXCEPTION 'M529 anonymous grant: accept_order_quote_atomic'; END IF;
  IF has_function_privilege('authenticated','public.accept_order_quote_atomic(uuid,text)','EXECUTE') IS DISTINCT FROM false THEN RAISE EXCEPTION 'M529 authenticated grant: accept_order_quote_atomic'; END IF;
  IF has_function_privilege('service_role','public.accept_order_quote_atomic(uuid,text)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'M529 service_role grant: accept_order_quote_atomic'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payments' AND column_name='amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: payments.amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payments' AND column_name='gateway_fee' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: payments.gateway_fee'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payments' AND column_name='verified_gateway_fee' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: payments.verified_gateway_fee'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payments' AND column_name='gateway_fee_claim_snapshot' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: payments.gateway_fee_claim_snapshot'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='platform_fees' AND column_name='transaction_amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: platform_fees.transaction_amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='platform_fees' AND column_name='fee_total' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: platform_fees.fee_total'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='platform_fees' AND column_name='fee_flat' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: platform_fees.fee_flat'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='platform_fees' AND column_name='gateway_fee' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: platform_fees.gateway_fee'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='platform_fees' AND column_name='reseller_commission' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: platform_fees.reseller_commission'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='total_amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: orders.total_amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='platform_fee' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: orders.platform_fee'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='discount_amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: orders.discount_amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='shipping_cost' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: orders.shipping_cost'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='addons_total' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: orders.addons_total'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='volume_discount_amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: orders.volume_discount_amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='deposit_amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: orders.deposit_amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='balance_amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: orders.balance_amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bookings' AND column_name='deposit_amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: bookings.deposit_amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bookings' AND column_name='total_amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: bookings.total_amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bookings' AND column_name='platform_fee' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: bookings.platform_fee'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bookings' AND column_name='discount_amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: bookings.discount_amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_items' AND column_name='unit_price' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: order_items.unit_price'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote_requests' AND column_name='estimated_subtotal' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: quote_requests.estimated_subtotal'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote_requests' AND column_name='quoted_amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: quote_requests.quoted_amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_spend_applications' AND column_name='amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: payment_spend_applications.amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_visit_applications' AND column_name='visit_amount' AND data_type='numeric' AND numeric_scale=2) THEN RAISE EXCEPTION 'M529 type missing: payment_visit_applications.visit_amount'; END IF;
END $verify$;
NOTIFY pgrst, 'reload schema';
COMMIT;
