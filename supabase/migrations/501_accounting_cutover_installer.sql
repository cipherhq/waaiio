-- M501 installs an owner-only activation procedure. It DOES NOT activate accounting.
-- Installation is recorded separately from any later authorized operational CALL.
-- Caller must drain writers and supply an independently approved, project-bound envelope.
BEGIN;
CREATE PROCEDURE accounting_private.activate_merchant_accounting(
 p_environment text,p_project_ref text,p_expected_catalog jsonb,p_manifest jsonb,p_receipt_sha256 text
) LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $activation$
DECLARE precursor text; owner_name text;
BEGIN
 SELECT pg_get_userbyid(proowner) INTO owner_name FROM pg_proc WHERE oid='accounting_private.activate_merchant_accounting(text,text,jsonb,jsonb,text)'::regprocedure;
 IF current_user IS DISTINCT FROM owner_name OR current_user IS DISTINCT FROM (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='accounting_private') THEN RAISE EXCEPTION 'accounting_owner_required'; END IF;
 IF p_environment IS NULL OR p_project_ref IS NULL OR p_manifest IS NULL OR p_expected_catalog IS NULL OR p_manifest->>'environment' IS DISTINCT FROM p_environment OR p_manifest->>'project_ref' IS DISTINCT FROM p_project_ref THEN RAISE EXCEPTION 'accounting_environment_binding_required'; END IF;
 IF p_receipt_sha256 IS NULL OR p_receipt_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'accounting_owner_receipt_required'; END IF;
 -- This consistency check is not proof of Owner approval. The authenticated execution
 -- transport must separately verify the actual approved receipt and exact input hashes.
 PERFORM set_config('app.accounting_enrollment_manifest',p_manifest::text,true);
 PERFORM set_config('app.accounting_expected_catalog',p_expected_catalog::text,true);
 PERFORM set_config('app.accounting_owner_receipt_sha256',p_receipt_sha256,true);
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM set_config('statement_timeout','60s',true);
 PERFORM set_config('TimeZone','UTC',true);
 PERFORM set_config('app.accounting_paystack_variant','legacy',true);
EXECUTE $before$
LOCK TABLE public.businesses,public.payments,public.platform_fees,public.business_payouts,public.payout_adjustments,public.refunds,public.admin_step_up_authorizations,public.admin_audit_logs IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE packet_catalog_before ON COMMIT DROP AS SELECT jsonb_build_object('observed_at',transaction_timestamp(),'read_only',current_setting('transaction_read_only'),
'hold_tables',jsonb_build_object('holds',to_regclass('public.merchant_accounting_holds')::text,'membership',to_regclass('public.legacy_refund_accounting_membership')::text,'exceptions',to_regclass('public.refund_accounting_exceptions')::text),
'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'signature',p.oid::regprocedure::text,'parallel',p.proparallel,'volatility',p.provolatile,'strict',p.proisstrict,'returns',pg_get_function_result(p.oid),'service_execute',has_function_privilege('service_role',p.oid,'EXECUTE'),'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),'body_sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl::text) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('finalize_refund_execution','confirm_manual_settlement','force_settle_manual_payout','force_settle_executed_transfer','claim_payout_for_transfer','reject_payout_and_release_adjustments','mark_payout_provider_submitted','mark_payout_transfer_failed','mark_payout_failed','mark_payout_review_required','check_session_exists','payout_flag_present','payout_flag_adjustment_ids','fn_payout_linkage_guard')),
'table_security',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl::text,'service_select',has_table_privilege('service_role',c.oid,'SELECT'),'service_insert',has_table_privilege('service_role',c.oid,'INSERT'),'service_update',has_table_privilege('service_role',c.oid,'UPDATE'),'service_delete',has_table_privilege('service_role',c.oid,'DELETE'),'authenticated_insert',has_table_privilege('authenticated',c.oid,'INSERT'),'authenticated_update',has_table_privilege('authenticated',c.oid,'UPDATE')) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('business_payouts','platform_fees','payout_adjustments','payments','admin_step_up_authorizations','admin_audit_logs')),
'columns',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type,'udt',udt_name,'default',column_default,'nullable',is_nullable) ORDER BY table_name,ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND ((table_name IN('business_payouts','payout_adjustments') AND column_name IN('currency','status')) OR table_name='admin_step_up_authorizations')),
'constraints',(SELECT jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conrelid,c.conname) FROM pg_constraint c WHERE c.conrelid IN(to_regclass('public.business_payouts'),to_regclass('public.payout_adjustments'),to_regclass('public.admin_step_up_authorizations'))),
'indexes',(SELECT jsonb_agg(jsonb_build_object('table',tablename,'name',indexname,'definition',indexdef) ORDER BY tablename,indexname) FROM pg_indexes WHERE schemaname='public' AND tablename IN('business_payouts','payout_adjustments')),
'triggers',(SELECT jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN(to_regclass('public.business_payouts'),to_regclass('public.platform_fees'),to_regclass('public.payout_adjustments'),to_regclass('public.payments'))),
'global_inflight_payouts',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'business_id',p.business_id,'status',p.status,'row_sha256',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')) ORDER BY p.id),'[]') FROM public.business_payouts p WHERE p.status IN('approved','processing','review_required'))
) AS preflight_catalog;
DO $preflight$ DECLARE c jsonb; BEGIN
 SELECT preflight_catalog INTO c FROM packet_catalog_before;
 IF c-ARRAY['observed_at','read_only','hold_tables','global_inflight_payouts'] IS DISTINCT FROM current_setting('app.accounting_expected_catalog')::jsonb-ARRAY['observed_at','read_only','hold_tables','global_inflight_payouts'] THEN RAISE EXCEPTION 'accounting_expected_before_changed'; END IF;
 IF c->'global_inflight_payouts' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'accounting_inflight_payout'; END IF;
 IF EXISTS(SELECT 1 FROM public.merchant_accounting_holds) OR EXISTS(SELECT 1 FROM public.legacy_refund_accounting_membership) OR EXISTS(SELECT 1 FROM public.refund_accounting_exceptions) THEN RAISE EXCEPTION 'accounting_already_activated_or_enrolled'; END IF;
END $preflight$;

$before$;
EXECUTE $enrollment$
CREATE TEMP TABLE packet_cohort_now ON COMMIT DROP AS WITH pe AS (
 SELECT p.*,CASE WHEN booking_id IS NOT NULL THEN 'booking_id' WHEN invoice_id IS NOT NULL THEN 'invoice_id' WHEN order_id IS NOT NULL THEN 'order_id' END kind,
 COALESCE(booking_id,invoice_id,order_id) entity_id FROM public.payments p
), candidates AS (
 SELECT p.id,p.business_id,p.kind,p.entity_id,p.status,p.currency,
 (SELECT count(*) FROM pe s WHERE s.business_id=p.business_id AND (to_jsonb(s)->>p.kind)::uuid=p.entity_id) sibling_count,
 (SELECT count(*) FROM public.platform_fees f WHERE f.business_id=p.business_id AND (to_jsonb(f)->>p.kind)::uuid=p.entity_id AND f.payment_id IS NULL) legacy_fee_count,
 (SELECT count(*) FROM public.platform_fees f WHERE (to_jsonb(f)->>p.kind)::uuid=p.entity_id AND (f.business_id IS DISTINCT FROM p.business_id OR f.is_direct_transfer IS DISTINCT FROM false OR f.payment_id IS NOT NULL)) unsafe_fee_count
 FROM pe p WHERE p.kind IS NOT NULL
), ambiguous AS (
 SELECT * FROM candidates WHERE legacy_fee_count>0 AND (sibling_count<>1 OR legacy_fee_count<>1)
), unresolved AS (
 SELECT f.business_id,'unlinked_platform_held_fee' reason,'platform_fees' source_table,f.id source_id
 FROM public.platform_fees f WHERE f.is_direct_transfer=false AND f.payment_id IS NULL
 UNION ALL SELECT f.business_id,'linked_platform_fee_currency_or_identity','platform_fees',f.id
 FROM public.platform_fees f LEFT JOIN public.payments p ON p.id=f.payment_id
 WHERE f.is_direct_transfer=false AND f.payment_id IS NOT NULL AND (p.id IS NULL OR p.business_id IS DISTINCT FROM f.business_id OR p.currency IS NULL OR p.currency !~ '^[A-Z]{3}$' OR (f.booking_id IS NOT NULL AND f.booking_id IS DISTINCT FROM p.booking_id) OR (f.invoice_id IS NOT NULL AND f.invoice_id IS DISTINCT FROM p.invoice_id) OR (f.order_id IS NOT NULL AND f.order_id IS DISTINCT FROM p.order_id))
 UNION ALL SELECT business_id,'payout_currency_unclassified','business_payouts',id FROM public.business_payouts WHERE currency IS NULL OR currency !~ '^[A-Z]{3}$'
 UNION ALL SELECT business_id,'adjustment_currency_unclassified','payout_adjustments',id FROM public.payout_adjustments WHERE currency IS NULL OR currency !~ '^[A-Z]{3}$'
), domains AS (SELECT DISTINCT business_id FROM unresolved WHERE business_id IS NOT NULL), snapshots AS (
 SELECT 'businesses' source_table,b.id,b.id business_id,encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex') row_sha256 FROM public.businesses b JOIN domains d ON d.business_id=b.id
 UNION ALL SELECT 'platform_fees',f.id,f.business_id,encode(sha256(convert_to(to_jsonb(f)::text,'UTF8')),'hex') FROM public.platform_fees f JOIN domains d USING(business_id)
 UNION ALL SELECT 'business_payouts',p.id,p.business_id,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM public.business_payouts p JOIN domains d USING(business_id)
 UNION ALL SELECT 'payout_adjustments',a.id,a.business_id,encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') FROM public.payout_adjustments a JOIN domains d USING(business_id)
 UNION ALL SELECT 'refunds',r.id,r.business_id,encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') FROM public.refunds r JOIN domains d USING(business_id)
 UNION ALL SELECT 'payments',p.id,p.business_id,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM public.payments p JOIN domains d USING(business_id)
)
SELECT jsonb_build_object(
 'observed_at',transaction_timestamp(),'database',current_database(),'read_only',current_setting('transaction_read_only'),
 'domains',COALESCE((SELECT jsonb_agg(jsonb_build_object('business_id',d.business_id,'status',b.status,'payout_mode',b.payout_mode,'reasons',(SELECT jsonb_agg(to_jsonb(u) ORDER BY reason,source_id) FROM unresolved u WHERE u.business_id=d.business_id)) ORDER BY d.business_id) FROM domains d LEFT JOIN public.businesses b ON b.id=d.business_id),'[]'),
 'ambiguous_payments',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY business_id,entity_id,id) FROM ambiguous a),'[]'),
 'membership_inputs',COALESCE((SELECT jsonb_agg(jsonb_build_object('payment_id',a.id,'business_id',a.business_id,'entity_kind',a.kind,'entity_id',a.entity_id,'status',a.status,'currency',a.currency,'payment_row_sha256',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),'fee_ids',(SELECT jsonb_agg(f.id ORDER BY f.id) FROM public.platform_fees f WHERE (to_jsonb(f)->>a.kind)::uuid=a.entity_id)) ORDER BY a.business_id,a.id) FROM ambiguous a JOIN public.payments p ON p.id=a.id WHERE unsafe_fee_count=0),'[]'),
 'unsupported_ambiguous_count',(SELECT count(*) FROM ambiguous WHERE unsafe_fee_count<>0),
 'unknown_custody_fee_count',(SELECT count(*) FROM public.platform_fees WHERE is_direct_transfer IS NULL),
 'global_inflight_refunds',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'business_id',business_id,'payment_id',payment_id,'status',status,'row_sha256',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')) ORDER BY id) FROM public.refunds r WHERE status IN('pending','provider_pending','provider_ambiguous','provider_success_unfinalized')),'[]'),
 'domain_inflight_payouts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'business_id',p.business_id,'status',p.status,'row_sha256',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')) ORDER BY p.id) FROM public.business_payouts p JOIN domains d USING(business_id) WHERE p.status IN('approved','processing','review_required')),'[]'),
 'before_rows',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY source_table,id) FROM snapshots s),'[]'),
 'counts',jsonb_build_object('hold_businesses',(SELECT count(*) FROM domains),'membership_payments',(SELECT count(*) FROM ambiguous WHERE unsafe_fee_count=0),'unlinked_fees_all',(SELECT count(*) FROM public.platform_fees WHERE payment_id IS NULL),'unlinked_held_fees',(SELECT count(*) FROM public.platform_fees WHERE payment_id IS NULL AND is_direct_transfer=false),'null_currency_payouts',(SELECT count(*) FROM public.business_payouts WHERE currency IS NULL))
) AS enrollment_discovery;
DO $packet$
DECLARE m jsonb:=current_setting('app.accounting_enrollment_manifest',true)::jsonb; c jsonb; actor uuid; expected jsonb; actual jsonb; item jsonb;
BEGIN
 SELECT enrollment_discovery INTO c FROM packet_cohort_now;
 IF m IS NULL OR m->>'schema_version' IS DISTINCT FROM '1' OR m->>'implementation_sha' IS DISTINCT FROM 'a29af26fe76f286521363aa014205915ec5e4ca3' THEN RAISE EXCEPTION 'packet_manifest_missing_or_wrong_source'; END IF;
 IF m->>'actor_id' IS NULL OR COALESCE(current_setting('app.accounting_owner_receipt_sha256',true),'') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'packet_actor_or_execution_approval_unbound'; END IF;
 actor:=(m->>'actor_id')::uuid;
 PERFORM id FROM auth.users WHERE id=actor FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=actor AND raw_app_meta_data->>'role'='admin' AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<=clock_timestamp())) THEN RAISE EXCEPTION 'packet_actor_not_active_full_admin'; END IF;
 IF m->>'observed_at' IS NULL OR clock_timestamp()-(m->>'observed_at')::timestamptz>interval '15 minutes' OR (m->>'observed_at')::timestamptz>clock_timestamp() THEN RAISE EXCEPTION 'packet_enrollment_snapshot_stale'; END IF;
 IF (c->>'unknown_custody_fee_count')::int<>0 OR (c->>'unsupported_ambiguous_count')::int<>0 OR c->'global_inflight_refunds'<>'[]'::jsonb OR c->'domain_inflight_payouts'<>'[]'::jsonb THEN RAISE EXCEPTION 'packet_unreviewed_or_inflight_domain'; END IF;
 IF c->'before_rows' IS DISTINCT FROM m->'before_rows' THEN RAISE EXCEPTION 'packet_row_hash_or_complete_set_changed'; END IF;
 SELECT COALESCE(jsonb_agg(x->>'business_id' ORDER BY x->>'business_id'),'[]') INTO actual FROM jsonb_array_elements(c->'domains') x;
 SELECT COALESCE(jsonb_agg(x->>'business_id' ORDER BY x->>'business_id'),'[]') INTO expected FROM jsonb_array_elements(m->'business_holds') x;
 IF actual<>expected THEN RAISE EXCEPTION 'packet_complete_business_domain_changed'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(m->'business_holds') LOOP
  SELECT value INTO actual FROM jsonb_array_elements(c->'domains') WHERE value->>'business_id'=item->>'business_id';
  IF actual->'reasons' IS DISTINCT FROM item->'reasons' OR actual->'payout_mode' IS DISTINCT FROM item->'current_payout_mode' THEN RAISE EXCEPTION 'packet_business_domain_semantics_changed'; END IF;
 END LOOP;
 SELECT COALESCE(jsonb_agg(x ORDER BY x->>'business_id',x->>'payment_id'),'[]') INTO actual FROM jsonb_array_elements(c->'membership_inputs') x;
 SELECT COALESCE(jsonb_agg(x-'evidence_sha256'-'evidence_file' ORDER BY x->>'business_id',x->>'payment_id'),'[]') INTO expected FROM jsonb_array_elements(m->'payment_membership') x;
 IF actual<>expected THEN RAISE EXCEPTION 'packet_complete_payment_membership_changed'; END IF;
 IF jsonb_array_length(m->'business_holds')<>(m->'expected_counts'->>'hold_businesses')::int OR jsonb_array_length(m->'payment_membership')<>(m->'expected_counts'->>'membership_payments')::int THEN RAISE EXCEPTION 'packet_counts_changed'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(m->'business_holds') ORDER BY value->>'business_id' LOOP
  PERFORM accounting_private.enroll_merchant_accounting_hold((item->>'business_id')::uuid,item->>'evidence_sha256',actor);
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(m->'payment_membership') ORDER BY value->>'business_id',value->>'payment_id' LOOP
  PERFORM accounting_private.enroll_legacy_refund_accounting((item->>'payment_id')::uuid,(item->>'business_id')::uuid,item->>'evidence_sha256',actor);
 END LOOP;
END $packet$;

$enrollment$;
SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO precursor FROM pg_proc WHERE oid=to_regprocedure('finalize_token_recurring_charge(text,uuid,numeric,text,text,text)');
IF precursor = 'ad028f4425ce6f0c0e38ae42556f66794a67572f28dc59a4eb1545b4d8737ad9' THEN
EXECUTE $recurring_finalize_token_recurring_charge$
-- PRIVATE REVIEW DRAFT. Not authorized for hosted execution. New identity unreserved.
-- LOCAL TEST CANDIDATE ONLY. Not a migration or an operational deployment packet.
-- Preserve the three public precursor definitions; no later cancellation changes.

-- Public 335_recurring_spend_finalization.sql with authoritative payment linkage only.
CREATE OR REPLACE FUNCTION finalize_token_recurring_charge(
  p_stable_ref       TEXT,
  p_subscription_id  UUID,
  p_verified_amount  NUMERIC(12,2),
  p_verified_currency TEXT DEFAULT 'NGN',
  p_gateway          TEXT DEFAULT 'flutterwave',
  p_provider_attempt_ref TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub              RECORD;
  v_claim            RECORD;
  v_now              TIMESTAMPTZ := NOW();
  v_today            DATE := CURRENT_DATE;
  v_time             TEXT;
  v_booking_id       UUID;
  v_booking_ref      TEXT;
  v_payment_id       UUID;
  v_next_charge      TIMESTAMPTZ;
  v_business         RECORD;
  v_fee_pct          NUMERIC(5,2);
  v_fee_flat         NUMERIC(12,2);
  v_fee_total        NUMERIC(12,2);
  v_is_in_trial      BOOLEAN;
  v_tier             TEXT;
  v_authoritative_attempt_ref TEXT;
  v_spend_result     JSONB;  -- #164: spend application result
BEGIN
  -- Lock the claim row to serialize concurrent finalizers (FOR UPDATE from 306).
  SELECT * INTO v_claim FROM processed_webhook_events WHERE event_id = p_stable_ref FOR UPDATE;
  IF NOT FOUND OR v_claim.status NOT IN ('claimed', 'completed', 'provider_success') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_valid_claim');
  END IF;
  IF v_claim.gateway != 'flutterwave' OR v_claim.event_type != 'token_renewal' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'claim_type_mismatch');
  END IF;
  IF p_stable_ref NOT LIKE 'flw-' || p_subscription_id::text || '-%' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'claim_subscription_mismatch');
  END IF;

  -- Extract authoritative provider attempt ref from claim row (sole source of truth).
  v_authoritative_attempt_ref := v_claim.last_error;

  IF p_provider_attempt_ref IS NOT NULL
     AND p_provider_attempt_ref IS DISTINCT FROM v_authoritative_attempt_ref THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt_ref_mismatch',
      'expected', v_authoritative_attempt_ref, 'received', p_provider_attempt_ref);
  END IF;

  -- Idempotency: if already finalized, return success without duplicating.
  IF v_claim.status = 'completed' THEN
    SELECT id INTO v_payment_id FROM payments
      WHERE (gateway_reference = p_stable_ref
             OR (v_authoritative_attempt_ref IS NOT NULL AND gateway_reference = v_authoritative_attempt_ref))
      AND status = 'success' LIMIT 1;
    IF v_payment_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'reason', 'completed_payment_missing',
        'stable_ref', p_stable_ref, 'authoritative_attempt_ref', v_authoritative_attempt_ref);
    END IF;
    RETURN jsonb_build_object('success', true, 'already_finalized', true, 'payment_id', v_payment_id);
  END IF;

  -- Belt + suspenders: check payment doesn't already exist
  IF EXISTS (SELECT 1 FROM payments
     WHERE (gateway_reference = p_stable_ref
            OR (v_authoritative_attempt_ref IS NOT NULL AND gateway_reference = v_authoritative_attempt_ref))
     AND status = 'success') THEN
    UPDATE processed_webhook_events SET status = 'completed', completed_at = v_now WHERE event_id = p_stable_ref;
    SELECT id INTO v_payment_id FROM payments
      WHERE (gateway_reference = p_stable_ref
             OR (v_authoritative_attempt_ref IS NOT NULL AND gateway_reference = v_authoritative_attempt_ref))
      AND status = 'success' LIMIT 1;
    RETURN jsonb_build_object('success', true, 'already_finalized', true, 'payment_id', v_payment_id);
  END IF;

  -- For new finalization, claim MUST have authoritative attempt ref.
  IF v_authoritative_attempt_ref IS NULL OR v_authoritative_attempt_ref = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_authoritative_attempt_ref');
  END IF;

  -- Load and validate subscription
  SELECT * INTO v_sub FROM customer_subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_not_found');
  END IF;
  IF COALESCE(v_sub.gateway, '') != 'flutterwave' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_gateway', 'gateway', v_sub.gateway);
  END IF;
  IF p_gateway != 'flutterwave' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'gateway_mismatch', 'expected', 'flutterwave', 'received', p_gateway);
  END IF;

  IF ABS(p_verified_amount - v_sub.amount) > 0.01 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'amount_mismatch',
      'expected', v_sub.amount, 'received', p_verified_amount);
  END IF;
  IF LOWER(p_verified_currency) != LOWER(COALESCE(v_sub.currency, 'NGN')) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'currency_mismatch',
      'expected', v_sub.currency, 'received', p_verified_currency);
  END IF;

  v_time := TO_CHAR(v_now, 'HH24:MI');

  -- Create booking (recurring accounting record)
  INSERT INTO bookings (
    business_id, user_id, service_id, date, time, party_size,
    flow_type, channel, payment_source, deposit_amount, deposit_status, status,
    total_amount, quantity, guest_name, guest_phone, confirmed_at, notes
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_sub.service_id, v_today, v_time, 1,
    'payment', 'recurring', 'subscription', p_verified_amount, 'paid', 'confirmed',
    p_verified_amount, 1, COALESCE(v_sub.customer_name, ''), COALESCE(v_sub.customer_phone, ''),
    v_now, 'Recurring ' || v_sub.frequency || ' charge'
  ) RETURNING id, reference_code INTO v_booking_id, v_booking_ref;

  -- Create payment
  INSERT INTO payments (
    business_id, user_id, booking_id, amount, currency, gateway,
    gateway_reference, status, gateway_status, payment_method,
    card_last_four, card_brand, paid_at, metadata
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_booking_id, p_verified_amount, p_verified_currency, p_gateway,
    v_authoritative_attempt_ref, 'success', 'success', 'card',
    v_sub.card_last_four, v_sub.card_brand,
    v_now, jsonb_build_object('recurring', true, 'subscription_id', v_sub.id, 'billing_cycle_ref', p_stable_ref, 'provider_attempt_ref', v_authoritative_attempt_ref)
  ) RETURNING id INTO v_payment_id;

  -- ═══════════════════════════════════════════════════════════
  -- #164: Atomic customer spend — reuses existing authority
  -- apply_payment_spend_once derives amount from payments.amount
  -- and source identity from payments.booking_id.
  -- Only applied=true is acceptable (includes already_applied).
  -- Any failure rolls back the entire finalizer transaction.
  -- ═══════════════════════════════════════════════════════════
  v_spend_result := apply_payment_spend_once(v_payment_id);

  IF v_spend_result IS NULL OR (v_spend_result->>'applied')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Recurring spend application failed for payment %: %',
      v_payment_id, COALESCE(v_spend_result::text, 'null_result');
  END IF;

  -- Log subscription charge
  INSERT INTO subscription_charges (
    subscription_id, business_id, user_id, amount, currency,
    status, gateway, gateway_reference, payment_id, booking_id, charged_at
  ) VALUES (
    v_sub.id, v_sub.business_id, v_sub.user_id, p_verified_amount, p_verified_currency,
    'success', p_gateway, v_authoritative_attempt_ref, v_payment_id, v_booking_id, v_now
  );

  -- Platform fee
  SELECT subscription_tier, trial_ends_at, payout_mode INTO v_business FROM businesses WHERE id = v_sub.business_id;
  IF v_business IS NOT NULL AND COALESCE(v_business.payout_mode, 'platform') != 'direct_split' THEN
    v_is_in_trial := v_business.trial_ends_at > v_now;
    v_tier := COALESCE(v_business.subscription_tier, 'free');
    IF v_is_in_trial THEN v_fee_pct := 0; v_fee_flat := 0; v_fee_total := 0;
    ELSE
      SELECT COALESCE((value::jsonb -> v_tier ->> 'feePercentage')::numeric, CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END),
             COALESCE((value::jsonb -> v_tier ->> 'feeFlat')::numeric, 0)
      INTO v_fee_pct, v_fee_flat FROM platform_settings WHERE key = 'pricing_tiers' LIMIT 1;
      IF v_fee_pct IS NULL THEN v_fee_pct := CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END; v_fee_flat := 0; END IF;
      IF v_fee_flat > 0 AND p_verified_amount > 0 AND v_fee_flat / p_verified_amount > 0.10 THEN v_fee_flat := 0; END IF;
      v_fee_total := ROUND(p_verified_amount * v_fee_pct / 100, 2) + v_fee_flat;
    END IF;
    INSERT INTO platform_fees (payment_id, business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
    VALUES (v_payment_id, v_sub.business_id, v_booking_id, p_verified_amount, v_fee_pct, v_fee_flat, v_fee_total, v_tier);
  END IF;

  -- Update subscription totals
  IF v_sub.frequency = 'weekly' THEN v_next_charge := v_now + INTERVAL '7 days';
  ELSIF v_sub.frequency = 'yearly' THEN v_next_charge := v_now + INTERVAL '1 year';
  ELSE v_next_charge := v_now + INTERVAL '1 month';
  END IF;

  UPDATE customer_subscriptions SET
    charge_count = charge_count + 1,
    total_charged = total_charged + p_verified_amount,
    last_charged_at = v_now,
    next_charge_at = v_next_charge,
    failure_count = 0
  WHERE id = v_sub.id;

  -- Mark billing cycle completed
  UPDATE processed_webhook_events SET status = 'completed', completed_at = v_now WHERE event_id = p_stable_ref;

  RETURN jsonb_build_object(
    'success', true,
    'already_finalized', false,
    'subscription_id', v_sub.id,
    'booking_id', v_booking_id,
    'booking_ref', v_booking_ref,
    'payment_id', v_payment_id,
    'amount', p_verified_amount,
    'currency', p_verified_currency,
    'business_id', v_sub.business_id,
    'customer_phone', v_sub.customer_phone,
    'customer_name', v_sub.customer_name
  );
END;
$$;
$recurring_finalize_token_recurring_charge$;
ELSE RAISE EXCEPTION 'accounting_unknown_recurring_precursor: finalize_token_recurring_charge'; END IF;
SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO precursor FROM pg_proc WHERE oid=to_regprocedure('finalize_stripe_recurring_charge(uuid,text,text,integer,text,text)');
IF precursor = '7081feeecd058c0d94cc4dd877dfbb4f3e6a3221b4cb650b21025ca8aaf987e9' THEN
EXECUTE $recurring_finalize_stripe_recurring_charge$
-- Public 339_stripe_recurring_finalization.sql with authoritative payment linkage only.
CREATE OR REPLACE FUNCTION finalize_stripe_recurring_charge(
  p_subscription_id UUID,
  p_stripe_invoice_id TEXT,
  p_stripe_subscription_code TEXT,
  p_amount_cents INT,
  p_currency TEXT DEFAULT 'USD',
  p_payment_intent_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing RECORD;
  v_sub RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_today DATE := CURRENT_DATE;
  v_time TEXT;
  v_booking_id UUID;
  v_booking_ref TEXT;
  v_payment_id UUID;
  v_next_charge TIMESTAMPTZ;
  v_amount NUMERIC(12,2);
  v_business RECORD;
  v_fee_pct NUMERIC(5,2);
  v_fee_flat NUMERIC(12,2);
  v_fee_total NUMERIC(12,2);
  v_is_in_trial BOOLEAN;
  v_tier TEXT;
  v_spend_result JSONB;
BEGIN
  -- ── Input validation: reject null/malformed IDs before any locking ──
  IF p_stripe_invoice_id IS NULL OR p_stripe_invoice_id !~ '^in_' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_invoice_id');
  END IF;
  IF p_stripe_subscription_code IS NULL OR p_stripe_subscription_code !~ '^sub_' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_subscription_code');
  END IF;
  IF p_payment_intent_id IS NULL OR p_payment_intent_id !~ '^pi_' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_payment_intent_id');
  END IF;
  IF p_subscription_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'null_subscription_id');
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;
  IF p_currency IS NULL OR TRIM(p_currency) = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_currency');
  END IF;

  -- ── Invoice-level advisory lock: serializes ALL concurrent callers for this invoice ──
  -- This prevents the race where two workers both see "no finalization marker"
  -- and both attempt to insert (which would cause a unique violation instead
  -- of a clean replay response).
  PERFORM pg_advisory_xact_lock(hashtext(p_stripe_invoice_id));

  -- ── Check for existing finalization (replay path) ──
  SELECT * INTO v_existing FROM stripe_recurring_finalizations
    WHERE stripe_invoice_id = p_stripe_invoice_id;

  IF FOUND THEN
    -- Validate replay identity: all fields must match (null-safe)
    IF v_existing.finalized_amount_cents IS DISTINCT FROM p_amount_cents THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_amount_mismatch');
    END IF;
    IF UPPER(v_existing.finalized_currency) IS DISTINCT FROM UPPER(p_currency) THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_currency_mismatch');
    END IF;
    IF v_existing.customer_subscription_id IS DISTINCT FROM p_subscription_id THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_subscription_mismatch');
    END IF;
    IF v_existing.provider_payment_ref IS DISTINCT FROM p_payment_intent_id THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_provider_ref_mismatch');
    END IF;
    -- Return canonical IDs for Stage 3 recovery
    RETURN jsonb_build_object('success', true, 'already_finalized', true,
      'payment_id', v_existing.canonical_payment_id,
      'booking_id', v_existing.canonical_booking_id,
      'booking_ref', v_existing.canonical_booking_ref,
      'amount', v_existing.finalized_amount_cents / 100.0,
      'currency', v_existing.finalized_currency,
      'subscription_id', v_existing.customer_subscription_id);
  END IF;

  -- ── Lock subscription row for counter serialization ──
  SELECT * INTO v_sub FROM customer_subscriptions
    WHERE id = p_subscription_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_not_found');
  END IF;

  -- ── Validate DB authority (null-safe: NULL gateway/status/code must fail closed) ──
  IF v_sub.gateway IS NULL OR v_sub.gateway != 'stripe' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_gateway',
      'expected', 'stripe', 'actual', v_sub.gateway);
  END IF;

  IF v_sub.status IS NULL OR v_sub.status NOT IN ('active', 'past_due') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_status',
      'status', v_sub.status);
  END IF;

  IF v_sub.gateway_subscription_code IS NULL OR
     v_sub.gateway_subscription_code IS DISTINCT FROM p_stripe_subscription_code THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_code_mismatch');
  END IF;

  -- Amount validation: exact cents equality, no tolerance
  IF v_sub.amount IS NULL OR p_amount_cents IS DISTINCT FROM ROUND(v_sub.amount * 100)::int THEN
    RETURN jsonb_build_object('success', false, 'reason', 'amount_mismatch',
      'expected_cents', ROUND(COALESCE(v_sub.amount, 0) * 100)::int, 'received_cents', p_amount_cents);
  END IF;

  IF v_sub.currency IS NULL OR UPPER(p_currency) IS DISTINCT FROM UPPER(v_sub.currency) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'currency_mismatch');
  END IF;

  -- ── Resolve business BEFORE financial writes ──
  -- Must happen before bookings INSERT (FK: bookings.business_id → businesses.id)
  -- to give a clean error instead of a FK violation on orphaned subscriptions.
  SELECT subscription_tier, trial_ends_at, payout_mode INTO v_business
    FROM businesses WHERE id = v_sub.business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Business % not found for subscription %', v_sub.business_id, v_sub.id;
  END IF;

  -- ── Financial writes: all-or-nothing ──
  v_amount := p_amount_cents / 100.0;
  v_time := TO_CHAR(v_now, 'HH24:MI');

  -- Create booking
  INSERT INTO bookings (
    business_id, user_id, service_id, date, time, party_size,
    flow_type, channel, payment_source, deposit_amount, deposit_status, status,
    total_amount, quantity, guest_name, guest_phone, confirmed_at, notes
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_sub.service_id, v_today, v_time::TIME, 1,
    'payment', 'api', 'subscription',
    v_amount, 'paid', 'confirmed',
    v_amount, 1,
    COALESCE(v_sub.customer_name, ''), COALESCE(v_sub.customer_phone, ''),
    v_now, 'Recurring ' || v_sub.frequency || ' charge (Stripe)'
  ) RETURNING id, reference_code INTO v_booking_id, v_booking_ref;

  -- Create payment (gateway_reference = PaymentIntent ID for refund compatibility)
  INSERT INTO payments (
    business_id, user_id, booking_id, amount, currency, gateway,
    gateway_reference, status, gateway_status, payment_method,
    card_last_four, card_brand, paid_at, metadata
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_booking_id,
    v_amount, v_sub.currency, 'stripe',
    p_payment_intent_id, 'success', 'success', 'card',
    v_sub.card_last_four, v_sub.card_brand, v_now,
    jsonb_build_object('recurring', true, 'subscription_id', v_sub.id,
      'stripe_invoice_id', p_stripe_invoice_id)
  ) RETURNING id INTO v_payment_id;

  -- ── Atomic spend marker: hard gate ──
  v_spend_result := apply_payment_spend_once(v_payment_id);
  IF v_spend_result IS NULL OR (v_spend_result->>'applied')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Stripe recurring spend failed for payment %: %',
      v_payment_id, COALESCE(v_spend_result::text, 'null_result');
  END IF;

  -- Subscription charge record
  INSERT INTO subscription_charges (
    subscription_id, business_id, user_id, amount, currency,
    status, gateway, gateway_reference, payment_id, booking_id, charged_at
  ) VALUES (
    v_sub.id, v_sub.business_id, v_sub.user_id,
    v_amount, v_sub.currency,
    'success', 'stripe', p_payment_intent_id, v_payment_id, v_booking_id, v_now
  );

  -- ── Platform fee: preserves active Stripe fee semantics exactly ──
  -- Uses ROUND(x) = integer rounding to match Math.round in getPlatformFees
  -- Uses strict > 0.10 micro-tx guard (exactly 10% is NOT waived)
  -- Business was resolved above (before financial writes).
  IF COALESCE(v_business.payout_mode, 'platform') != 'direct_split' THEN
    -- NULL trial_ends_at = not in trial (matches process-success.ts semantics)
    v_is_in_trial := COALESCE(v_business.trial_ends_at > v_now, false);
    v_tier := COALESCE(v_business.subscription_tier, 'free');
    IF v_is_in_trial THEN
      v_fee_pct := 0; v_fee_flat := 0; v_fee_total := 0;
    ELSE
      SELECT COALESCE((value::jsonb -> v_tier ->> 'feePercentage')::numeric,
               CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END),
             COALESCE((value::jsonb -> v_tier ->> 'feeFlat')::numeric, 0)
      INTO v_fee_pct, v_fee_flat FROM platform_settings WHERE key = 'pricing_tiers' LIMIT 1;
      IF v_fee_pct IS NULL THEN
        v_fee_pct := CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END;
        v_fee_flat := 0;
      END IF;
      -- Micro-transaction guard: strict > 0.10 (exactly 10% is NOT waived)
      IF v_fee_flat > 0 AND v_amount > 0 AND v_fee_flat / v_amount > 0.10 THEN
        v_fee_flat := 0;
      END IF;
      -- Integer rounding to match Math.round behavior
      v_fee_total := ROUND(v_amount * v_fee_pct / 100) + v_fee_flat;
    END IF;
    INSERT INTO platform_fees (payment_id, business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
    VALUES (v_payment_id, v_sub.business_id, v_booking_id, v_amount, v_fee_pct, v_fee_flat, v_fee_total, v_tier::subscription_tier);
  END IF;

  -- ── Update subscription counters ──
  IF v_sub.frequency = 'weekly' THEN v_next_charge := v_now + INTERVAL '7 days';
  ELSIF v_sub.frequency = 'yearly' THEN v_next_charge := v_now + INTERVAL '1 year';
  ELSE v_next_charge := v_now + INTERVAL '1 month';
  END IF;

  UPDATE customer_subscriptions SET
    charge_count = COALESCE(charge_count, 0) + 1,
    total_charged = COALESCE(total_charged, 0) + v_amount,
    last_charged_at = v_now,
    next_charge_at = v_next_charge,
    failure_count = 0,
    status = 'active'
  WHERE id = v_sub.id;

  -- ── Terminal finalization marker: inserted ONLY at end of successful transaction ──
  -- All canonical fields are NOT NULL. A committed row proves all financial writes succeeded.
  INSERT INTO stripe_recurring_finalizations (
    stripe_invoice_id, customer_subscription_id, stripe_subscription_code,
    canonical_payment_id, canonical_booking_id, canonical_booking_ref,
    finalized_amount_cents, finalized_currency, provider_payment_ref
  ) VALUES (
    p_stripe_invoice_id, p_subscription_id, p_stripe_subscription_code,
    v_payment_id, v_booking_id, v_booking_ref,
    p_amount_cents, p_currency, p_payment_intent_id
  );

  RETURN jsonb_build_object('success', true, 'already_finalized', false,
    'subscription_id', v_sub.id, 'booking_id', v_booking_id,
    'booking_ref', v_booking_ref, 'payment_id', v_payment_id,
    'amount', v_amount, 'currency', v_sub.currency,
    'business_id', v_sub.business_id,
    'customer_phone', v_sub.customer_phone,
    'customer_name', v_sub.customer_name);
END;
$$;
$recurring_finalize_stripe_recurring_charge$;
ELSE RAISE EXCEPTION 'accounting_unknown_recurring_precursor: finalize_stripe_recurring_charge'; END IF;
SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO precursor FROM pg_proc WHERE oid=to_regprocedure('finalize_paystack_recurring_charge(uuid,integer,text,text,text)');
IF precursor = '74963a47f500c16f5802db7c6d0b88550042093b0d28b0473f7cbad34c58bc2d' THEN
EXECUTE $recurring_finalize_paystack_recurring_charge$
-- Public 337_paystack_recurring_finalization.sql with authoritative payment linkage only.
CREATE OR REPLACE FUNCTION finalize_paystack_recurring_charge(
  p_attempt_id UUID,
  p_provider_amount_minor INT,
  p_provider_currency TEXT DEFAULT 'NGN',
  p_provider_transaction_id TEXT DEFAULT NULL,
  p_provider_invoice_code TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempt RECORD;
  v_sub RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_today DATE := CURRENT_DATE;
  v_time TEXT;
  v_booking_id UUID;
  v_booking_ref TEXT;
  v_payment_id UUID;
  v_next_charge TIMESTAMPTZ;
  v_business RECORD;
  v_fee_pct NUMERIC(5,2);
  v_fee_flat NUMERIC(12,2);
  v_fee_total NUMERIC(12,2);
  v_is_in_trial BOOLEAN;
  v_tier TEXT;
  v_spend_result JSONB;
BEGIN
  -- Lock the attempt to serialize concurrent finalization
  SELECT * INTO v_attempt FROM paystack_billing_attempts
    WHERE id = p_attempt_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt_not_found');
  END IF;

  IF v_attempt.status = 'finalized' THEN
    -- Replay identity validation: incoming evidence must match ALL persisted identity
    IF p_provider_amount_minor != v_attempt.intended_amount_minor THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_amount_mismatch');
    END IF;
    IF LOWER(p_provider_currency) != LOWER(v_attempt.intended_currency) THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_currency_mismatch');
    END IF;
    -- Validate transaction_id if both present
    IF p_provider_transaction_id IS NOT NULL AND v_attempt.provider_transaction_id IS NOT NULL
       AND p_provider_transaction_id IS DISTINCT FROM v_attempt.provider_transaction_id THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_transaction_id_mismatch');
    END IF;
    -- Validate invoice_code if both present
    IF p_provider_invoice_code IS NOT NULL AND v_attempt.provider_invoice_code IS NOT NULL
       AND p_provider_invoice_code IS DISTINCT FROM v_attempt.provider_invoice_code THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_invoice_mismatch');
    END IF;
    -- Return canonical IDs for safe Stage 3 recovery
    RETURN jsonb_build_object('success', true, 'already_finalized', true,
      'payment_id', v_attempt.canonical_payment_id,
      'booking_id', v_attempt.canonical_booking_id,
      'booking_ref', v_attempt.canonical_booking_ref,
      'amount', v_attempt.intended_amount_minor / 100.0,
      'currency', v_attempt.intended_currency,
      'subscription_id', v_attempt.customer_subscription_id);
  END IF;

  -- Guard: only dispatched/charged/failed may finalize. 'reserved' cannot.
  IF v_attempt.status NOT IN ('dispatched', 'charged', 'failed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_status', 'status', v_attempt.status);
  END IF;

  -- Exact amount/currency validation — no tolerance
  IF p_provider_amount_minor != v_attempt.intended_amount_minor THEN
    RETURN jsonb_build_object('success', false, 'reason', 'amount_mismatch',
      'expected', v_attempt.intended_amount_minor, 'received', p_provider_amount_minor);
  END IF;

  IF LOWER(p_provider_currency) != LOWER(v_attempt.intended_currency) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'currency_mismatch',
      'expected', v_attempt.intended_currency, 'received', p_provider_currency);
  END IF;

  -- Load subscription
  SELECT * INTO v_sub FROM customer_subscriptions
    WHERE id = v_attempt.customer_subscription_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_not_found');
  END IF;

  v_time := TO_CHAR(v_now, 'HH24:MI');

  -- Create booking (recurring accounting record)
  INSERT INTO bookings (
    business_id, user_id, service_id, date, time, party_size,
    flow_type, channel, payment_source, deposit_amount, deposit_status, status,
    total_amount, quantity, guest_name, guest_phone, confirmed_at, notes
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_sub.service_id, v_today, v_time, 1,
    'payment', 'recurring', 'subscription',
    p_provider_amount_minor / 100.0, 'paid', 'confirmed',
    p_provider_amount_minor / 100.0, 1,
    COALESCE(v_sub.customer_name, ''), COALESCE(v_sub.customer_phone, ''),
    v_now, 'Recurring ' || v_sub.frequency || ' charge'
  ) RETURNING id, reference_code INTO v_booking_id, v_booking_ref;

  -- Create payment
  INSERT INTO payments (
    business_id, user_id, booking_id, amount, currency, gateway,
    gateway_reference, status, gateway_status, payment_method,
    card_last_four, card_brand, paid_at, metadata
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_booking_id,
    p_provider_amount_minor / 100.0, v_attempt.intended_currency, 'paystack',
    v_attempt.provider_reference, 'success', 'success', 'card',
    v_sub.card_last_four, v_sub.card_brand, v_now,
    jsonb_build_object('recurring', true, 'subscription_id', v_sub.id,
      'billing_attempt_id', v_attempt.id, 'cycle_key', v_attempt.cycle_key)
  ) RETURNING id INTO v_payment_id;

  -- Atomic customer spend (#176 + #164 pattern)
  v_spend_result := apply_payment_spend_once(v_payment_id);
  IF v_spend_result IS NULL OR (v_spend_result->>'applied')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Paystack recurring spend failed for payment %: %',
      v_payment_id, COALESCE(v_spend_result::text, 'null_result');
  END IF;

  -- Subscription charge record
  INSERT INTO subscription_charges (
    subscription_id, business_id, user_id, amount, currency,
    status, gateway, gateway_reference, payment_id, booking_id, charged_at
  ) VALUES (
    v_sub.id, v_sub.business_id, v_sub.user_id,
    p_provider_amount_minor / 100.0, v_attempt.intended_currency,
    'success', 'paystack', v_attempt.provider_reference, v_payment_id, v_booking_id, v_now
  );

  -- Platform fee
  SELECT subscription_tier, trial_ends_at, payout_mode INTO v_business
    FROM businesses WHERE id = v_sub.business_id;

  IF v_business IS NOT NULL AND COALESCE(v_business.payout_mode, 'platform') != 'direct_split' THEN
    v_is_in_trial := v_business.trial_ends_at > v_now;
    v_tier := COALESCE(v_business.subscription_tier, 'free');
    IF v_is_in_trial THEN v_fee_pct := 0; v_fee_flat := 0; v_fee_total := 0;
    ELSE
      SELECT COALESCE((value::jsonb -> v_tier ->> 'feePercentage')::numeric,
               CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END),
             COALESCE((value::jsonb -> v_tier ->> 'feeFlat')::numeric, 0)
      INTO v_fee_pct, v_fee_flat FROM platform_settings WHERE key = 'pricing_tiers' LIMIT 1;
      IF v_fee_pct IS NULL THEN
        v_fee_pct := CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END;
        v_fee_flat := 0;
      END IF;
      IF v_fee_flat > 0 AND (p_provider_amount_minor / 100.0) > 0
         AND v_fee_flat / (p_provider_amount_minor / 100.0) > 0.10 THEN
        v_fee_flat := 0;
      END IF;
      v_fee_total := ROUND((p_provider_amount_minor / 100.0) * v_fee_pct / 100, 2) + v_fee_flat;
    END IF;
    INSERT INTO platform_fees (payment_id, business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
    VALUES (v_payment_id, v_sub.business_id, v_booking_id, p_provider_amount_minor / 100.0, v_fee_pct, v_fee_flat, v_fee_total, v_tier);
  END IF;

  -- Update subscription totals
  IF v_sub.frequency = 'weekly' THEN v_next_charge := v_now + INTERVAL '7 days';
  ELSIF v_sub.frequency = 'yearly' THEN v_next_charge := v_now + INTERVAL '1 year';
  ELSE v_next_charge := v_now + INTERVAL '1 month';
  END IF;

  UPDATE customer_subscriptions SET
    charge_count = COALESCE(charge_count, 0) + 1,
    total_charged = COALESCE(total_charged, 0) + (p_provider_amount_minor / 100.0),
    last_charged_at = v_now, next_charge_at = v_next_charge, failure_count = 0
  WHERE id = v_sub.id;

  -- Mark attempt finalized with canonical IDs for replay recovery
  UPDATE paystack_billing_attempts SET
    status = 'finalized', finalized_at = v_now,
    provider_transaction_id = p_provider_transaction_id,
    provider_invoice_code = p_provider_invoice_code,
    canonical_payment_id = v_payment_id,
    canonical_booking_id = v_booking_id,
    canonical_booking_ref = v_booking_ref
  WHERE id = p_attempt_id;

  RETURN jsonb_build_object('success', true, 'already_finalized', false,
    'subscription_id', v_sub.id, 'booking_id', v_booking_id,
    'booking_ref', v_booking_ref, 'payment_id', v_payment_id,
    'amount', p_provider_amount_minor / 100.0,
    'currency', v_attempt.intended_currency,
    'business_id', v_sub.business_id,
    'customer_phone', v_sub.customer_phone,
    'customer_name', v_sub.customer_name);
END;
$$;
$recurring_finalize_paystack_recurring_charge$;
ELSIF precursor = 'c679723153443f999ec9c9859363358799a407b528ac2bd750379647d662ee3c' THEN
PERFORM set_config('app.accounting_paystack_variant','canonical',true);
EXECUTE $canonical_paystack$
-- Finalizer: preserve M337 accounting/body; change only locking order.
-- Requires runtime pg_get_functiondef parity verification before application.
CREATE OR REPLACE FUNCTION finalize_paystack_recurring_charge(
  p_attempt_id UUID,
  p_provider_amount_minor INT,
  p_provider_currency TEXT DEFAULT 'NGN',
  p_provider_transaction_id TEXT DEFAULT NULL,
  p_provider_invoice_code TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_attempt RECORD;
  v_parent UUID;
  v_locked_parent UUID;
  v_sub RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_today DATE := CURRENT_DATE;
  v_time TEXT;
  v_booking_id UUID;
  v_booking_ref TEXT;
  v_payment_id UUID;
  v_next_charge TIMESTAMPTZ;
  v_business RECORD;
  v_fee_pct NUMERIC(5,2);
  v_fee_flat NUMERIC(12,2);
  v_fee_total NUMERIC(12,2);
  v_is_in_trial BOOLEAN;
  v_tier TEXT;
  v_spend_result JSONB;
BEGIN
  -- Acquire the subscription lock first, matching claim and dispatch.
  -- The initial parent lookup is only an identifier lookup, not authorization.
  SELECT customer_subscription_id INTO v_parent
    FROM public.paystack_billing_attempts WHERE id = p_attempt_id;
  IF v_parent IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt_not_found');
  END IF;

  SELECT id INTO v_locked_parent
    FROM public.customer_subscriptions WHERE id = v_parent FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_not_found');
  END IF;

  SELECT * INTO v_attempt FROM public.paystack_billing_attempts
    WHERE id = p_attempt_id FOR UPDATE;
  IF FOUND AND v_attempt.customer_subscription_id IS DISTINCT FROM v_parent THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt_changed');
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt_not_found');
  END IF;

  IF v_attempt.status = 'finalized' THEN
    -- Replay identity validation: incoming evidence must match ALL persisted identity
    IF p_provider_amount_minor != v_attempt.intended_amount_minor THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_amount_mismatch');
    END IF;
    IF LOWER(p_provider_currency) != LOWER(v_attempt.intended_currency) THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_currency_mismatch');
    END IF;
    -- Validate transaction_id if both present
    IF p_provider_transaction_id IS NOT NULL AND v_attempt.provider_transaction_id IS NOT NULL
       AND p_provider_transaction_id IS DISTINCT FROM v_attempt.provider_transaction_id THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_transaction_id_mismatch');
    END IF;
    -- Validate invoice_code if both present
    IF p_provider_invoice_code IS NOT NULL AND v_attempt.provider_invoice_code IS NOT NULL
       AND p_provider_invoice_code IS DISTINCT FROM v_attempt.provider_invoice_code THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_invoice_mismatch');
    END IF;
    -- Return canonical IDs for safe Stage 3 recovery
    RETURN jsonb_build_object('success', true, 'already_finalized', true,
      'payment_id', v_attempt.canonical_payment_id,
      'booking_id', v_attempt.canonical_booking_id,
      'booking_ref', v_attempt.canonical_booking_ref,
      'amount', v_attempt.intended_amount_minor / 100.0,
      'currency', v_attempt.intended_currency,
      'subscription_id', v_attempt.customer_subscription_id);
  END IF;

  -- Guard: only dispatched/charged/failed may finalize. 'reserved' cannot.
  IF v_attempt.status NOT IN ('dispatched', 'charged', 'failed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_status', 'status', v_attempt.status);
  END IF;

  -- Exact amount/currency validation — no tolerance
  IF p_provider_amount_minor != v_attempt.intended_amount_minor THEN
    RETURN jsonb_build_object('success', false, 'reason', 'amount_mismatch',
      'expected', v_attempt.intended_amount_minor, 'received', p_provider_amount_minor);
  END IF;

  IF LOWER(p_provider_currency) != LOWER(v_attempt.intended_currency) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'currency_mismatch',
      'expected', v_attempt.intended_currency, 'received', p_provider_currency);
  END IF;

  -- Load subscription
  SELECT * INTO v_sub FROM customer_subscriptions
    WHERE id = v_attempt.customer_subscription_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_not_found');
  END IF;

  v_time := TO_CHAR(v_now, 'HH24:MI');

  -- Create booking (recurring accounting record)
  INSERT INTO bookings (
    business_id, user_id, service_id, date, time, party_size,
    flow_type, channel, payment_source, deposit_amount, deposit_status, status,
    total_amount, quantity, guest_name, guest_phone, confirmed_at, notes
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_sub.service_id, v_today, v_time, 1,
    'payment', 'recurring', 'subscription',
    p_provider_amount_minor / 100.0, 'paid', 'confirmed',
    p_provider_amount_minor / 100.0, 1,
    COALESCE(v_sub.customer_name, ''), COALESCE(v_sub.customer_phone, ''),
    v_now, 'Recurring ' || v_sub.frequency || ' charge'
  ) RETURNING id, reference_code INTO v_booking_id, v_booking_ref;

  -- Create payment
  INSERT INTO payments (
    business_id, user_id, booking_id, amount, currency, gateway,
    gateway_reference, status, gateway_status, payment_method,
    card_last_four, card_brand, paid_at, metadata
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_booking_id,
    p_provider_amount_minor / 100.0, v_attempt.intended_currency, 'paystack',
    v_attempt.provider_reference, 'success', 'success', 'card',
    v_sub.card_last_four, v_sub.card_brand, v_now,
    jsonb_build_object('recurring', true, 'subscription_id', v_sub.id,
      'billing_attempt_id', v_attempt.id, 'cycle_key', v_attempt.cycle_key)
  ) RETURNING id INTO v_payment_id;

  -- Atomic customer spend (#176 + #164 pattern)
  v_spend_result := apply_payment_spend_once(v_payment_id);
  IF v_spend_result IS NULL OR (v_spend_result->>'applied')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Paystack recurring spend failed for payment %: %',
      v_payment_id, COALESCE(v_spend_result::text, 'null_result');
  END IF;

  -- Subscription charge record
  INSERT INTO subscription_charges (
    subscription_id, business_id, user_id, amount, currency,
    status, gateway, gateway_reference, payment_id, booking_id, charged_at
  ) VALUES (
    v_sub.id, v_sub.business_id, v_sub.user_id,
    p_provider_amount_minor / 100.0, v_attempt.intended_currency,
    'success', 'paystack', v_attempt.provider_reference, v_payment_id, v_booking_id, v_now
  );

  -- Platform fee
  SELECT subscription_tier, trial_ends_at, payout_mode INTO v_business
    FROM businesses WHERE id = v_sub.business_id;

  IF v_business IS NOT NULL AND COALESCE(v_business.payout_mode, 'platform') != 'direct_split' THEN
    v_is_in_trial := v_business.trial_ends_at > v_now;
    v_tier := COALESCE(v_business.subscription_tier, 'free');
    IF v_is_in_trial THEN v_fee_pct := 0; v_fee_flat := 0; v_fee_total := 0;
    ELSE
      SELECT COALESCE((value::jsonb -> v_tier ->> 'feePercentage')::numeric,
               CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END),
             COALESCE((value::jsonb -> v_tier ->> 'feeFlat')::numeric, 0)
      INTO v_fee_pct, v_fee_flat FROM platform_settings WHERE key = 'pricing_tiers' LIMIT 1;
      IF v_fee_pct IS NULL THEN
        v_fee_pct := CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END;
        v_fee_flat := 0;
      END IF;
      IF v_fee_flat > 0 AND (p_provider_amount_minor / 100.0) > 0
         AND v_fee_flat / (p_provider_amount_minor / 100.0) > 0.10 THEN
        v_fee_flat := 0;
      END IF;
      v_fee_total := ROUND((p_provider_amount_minor / 100.0) * v_fee_pct / 100, 2) + v_fee_flat;
    END IF;
    INSERT INTO platform_fees (payment_id, business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
    VALUES (v_payment_id, v_sub.business_id, v_booking_id, p_provider_amount_minor / 100.0, v_fee_pct, v_fee_flat, v_fee_total, v_tier);
  END IF;

  -- Update subscription totals
  IF v_sub.frequency = 'weekly' THEN v_next_charge := v_now + INTERVAL '7 days';
  ELSIF v_sub.frequency = 'yearly' THEN v_next_charge := v_now + INTERVAL '1 year';
  ELSE v_next_charge := v_now + INTERVAL '1 month';
  END IF;

  UPDATE customer_subscriptions SET
    charge_count = COALESCE(charge_count, 0) + 1,
    total_charged = COALESCE(total_charged, 0) + (p_provider_amount_minor / 100.0),
    last_charged_at = v_now, next_charge_at = v_next_charge, failure_count = 0
  WHERE id = v_sub.id;

  -- Mark attempt finalized with canonical IDs for replay recovery
  UPDATE paystack_billing_attempts SET
    status = 'finalized', finalized_at = v_now,
    provider_transaction_id = p_provider_transaction_id,
    provider_invoice_code = p_provider_invoice_code,
    canonical_payment_id = v_payment_id,
    canonical_booking_id = v_booking_id,
    canonical_booking_ref = v_booking_ref
  WHERE id = p_attempt_id;

  RETURN jsonb_build_object('success', true, 'already_finalized', false,
    'subscription_id', v_sub.id, 'booking_id', v_booking_id,
    'booking_ref', v_booking_ref, 'payment_id', v_payment_id,
    'amount', p_provider_amount_minor / 100.0,
    'currency', v_attempt.intended_currency,
    'business_id', v_sub.business_id,
    'customer_phone', v_sub.customer_phone,
    'customer_name', v_sub.customer_name);
END;
$$;
$canonical_paystack$;
ELSE RAISE EXCEPTION 'accounting_unknown_recurring_precursor: finalize_paystack_recurring_charge'; END IF;
EXECUTE $financial$
-- 440_payout_linkage_guard.sql
-- Additive, safe before or after the app deploy, unapplied until Owner authorization.
--
-- Adds two helper functions and a BEFORE INSERT OR UPDATE trigger on
-- business_payouts that enforces adjustment-linkage invariants at the
-- database level (R1-R5).  All functions are SECURITY INVOKER with
-- SET search_path = public, pg_temp.

-- ============================================================
-- 1. payout_flag_present(flags jsonb, flag_type text) -> boolean
-- ============================================================
CREATE OR REPLACE FUNCTION public.payout_flag_present(
  flags jsonb,
  flag_type text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  elem jsonb;
BEGIN
  -- NULL or non-array input -> false
  IF flags IS NULL OR jsonb_typeof(flags) <> 'array' THEN
    RETURN false;
  END IF;

  FOR elem IN SELECT jsonb_array_elements(flags)
  LOOP
    -- Only inspect JSON objects; skip strings and malformed elements
    IF jsonb_typeof(elem) = 'object'
       AND elem ? 'type'
       AND jsonb_typeof(elem -> 'type') = 'string'
       AND (elem ->> 'type') = flag_type
    THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$$;

-- ============================================================
-- 2. payout_flag_adjustment_ids(flags jsonb, flag_type text) -> uuid[]
-- ============================================================
CREATE OR REPLACE FUNCTION public.payout_flag_adjustment_ids(
  flags jsonb,
  flag_type text
)
RETURNS uuid[]
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  elem       jsonb;
  ids_jsonb  jsonb;
  result     uuid[];
  id_text    text;
BEGIN
  -- NULL or non-array input -> NULL
  IF flags IS NULL OR jsonb_typeof(flags) <> 'array' THEN
    RETURN NULL;
  END IF;

  FOR elem IN SELECT jsonb_array_elements(flags)
  LOOP
    IF jsonb_typeof(elem) = 'object'
       AND elem ? 'type'
       AND jsonb_typeof(elem -> 'type') = 'string'
       AND (elem ->> 'type') = flag_type
    THEN
      -- Found the matching flag; extract adjustment_ids
      IF NOT (elem ? 'adjustment_ids')
         OR jsonb_typeof(elem -> 'adjustment_ids') <> 'array'
      THEN
        RETURN NULL;
      END IF;

      ids_jsonb := elem -> 'adjustment_ids';
      result := ARRAY[]::uuid[];

      FOR id_text IN SELECT jsonb_array_elements_text(ids_jsonb)
      LOOP
        BEGIN
          result := result || id_text::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          -- Fail closed: any malformed UUID invalidates the entire flag
          RETURN NULL;
        END;
      END LOOP;

      -- Return distinct IDs (deduplicate)
      SELECT array_agg(DISTINCT u) INTO result FROM unnest(result) u;

      IF array_length(result, 1) IS NULL THEN
        RETURN NULL;
      END IF;

      RETURN result;
    END IF;
  END LOOP;

  -- Flag not found
  RETURN NULL;
END;
$$;

-- ============================================================
-- 3. Trigger function: fn_payout_linkage_guard()
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_payout_linkage_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  has_pending_new   boolean;
  has_failed_new    boolean;
  has_pending_old   boolean;
  has_failed_old    boolean;
  ids_pending_new   uuid[];
  ids_pending_old   uuid[];
  linked_count      int;
BEGIN
  -- Pre-compute flag presence for NEW
  has_pending_new := payout_flag_present(NEW.flags, 'adjustment_link_pending');
  has_failed_new  := payout_flag_present(NEW.flags, 'adjustment_link_failed');

  -- ----------------------------------------------------------------
  -- R1: No advancing to approved/processing/paid while carrying
  --     a pending or failed adjustment-link flag.
  -- ----------------------------------------------------------------
  IF NEW.status IN ('approved', 'processing', 'paid')
     AND (has_pending_new OR has_failed_new)
  THEN
    RAISE EXCEPTION 'linkage_guard_r1: cannot set status to % while adjustment_link_pending or adjustment_link_failed flag is present',
      NEW.status;
  END IF;

  -- ----------------------------------------------------------------
  -- R2: A pending flag must always carry a non-empty adjustment_ids.
  --     Applies to both INSERT and UPDATE.
  -- ----------------------------------------------------------------
  IF has_pending_new THEN
    ids_pending_new := payout_flag_adjustment_ids(NEW.flags, 'adjustment_link_pending');
    IF ids_pending_new IS NULL OR array_length(ids_pending_new, 1) IS NULL OR array_length(ids_pending_new, 1) = 0 THEN
      RAISE EXCEPTION 'linkage_guard_r2: adjustment_link_pending flag must carry a non-empty adjustment_ids array';
    END IF;
  END IF;

  -- Remaining rules apply to UPDATE only
  IF TG_OP = 'UPDATE' THEN
    has_pending_old := payout_flag_present(OLD.flags, 'adjustment_link_pending');
    has_failed_old  := payout_flag_present(OLD.flags, 'adjustment_link_failed');

    -- ----------------------------------------------------------------
    -- R3: Once adjustment_link_failed is set, it cannot be removed.
    --     Recovery is a future audited operation (#620).
    -- ----------------------------------------------------------------
    IF has_failed_old AND NOT has_failed_new THEN
      RAISE EXCEPTION 'linkage_guard_r3: adjustment_link_failed flag cannot be cleared; recovery requires audited operation (#620)';
    END IF;

    -- ----------------------------------------------------------------
    -- R4: Clearing adjustment_link_pending requires either:
    --     (a) NEW has adjustment_link_failed (the blocked swap), OR
    --     (b) Every id in OLD's pending adjustment_ids exists in
    --         payout_adjustments with applied_to_payout_id = NEW.id.
    -- ----------------------------------------------------------------
    IF has_pending_old AND NOT has_pending_new THEN
      -- Path (a): swap to failed is allowed
      IF NOT has_failed_new THEN
        -- Path (b): verify all adjustments are linked
        ids_pending_old := payout_flag_adjustment_ids(OLD.flags, 'adjustment_link_pending');
        IF ids_pending_old IS NULL OR array_length(ids_pending_old, 1) IS NULL THEN
          RAISE EXCEPTION 'linkage_guard_r4: cannot clear adjustment_link_pending — OLD flag has no adjustment_ids to verify';
        END IF;

        SELECT count(DISTINCT id)
          INTO linked_count
          FROM public.payout_adjustments
         WHERE id = ANY(ids_pending_old)
           AND applied_to_payout_id = OLD.id;

        IF linked_count <> array_length(ids_pending_old, 1) THEN
          RAISE EXCEPTION 'linkage_guard_r4: cannot clear adjustment_link_pending — only %/% adjustment(s) are linked to this payout',
            linked_count, array_length(ids_pending_old, 1);
        END IF;
      END IF;
      -- If has_failed_new is true, path (a) allows the clear — fall through
    END IF;

    -- ----------------------------------------------------------------
    -- R5: If both OLD and NEW carry adjustment_link_pending, the
    --     adjustment_ids must be identical (no silent mutation).
    -- ----------------------------------------------------------------
    IF has_pending_old AND has_pending_new THEN
      ids_pending_old := payout_flag_adjustment_ids(OLD.flags, 'adjustment_link_pending');
      -- ids_pending_new was already computed in R2 if has_pending_new
      IF ids_pending_new IS NULL THEN
        ids_pending_new := payout_flag_adjustment_ids(NEW.flags, 'adjustment_link_pending');
      END IF;

      IF ids_pending_old IS DISTINCT FROM ids_pending_new THEN
        RAISE EXCEPTION 'linkage_guard_r5: adjustment_ids in adjustment_link_pending flag cannot be changed once set';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_payout_and_release_adjustments(
  p_payout_id  uuid,
  p_reason     text
)
RETURNS TABLE (
  rejected_id           uuid,
  adjustments_released  int
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payout        record;
  v_has_pending   boolean;
  v_has_failed    boolean;
  v_released      int := 0;
BEGIN
  -- Lock the payout row to prevent concurrent modifications
  SELECT id, status, transfer_method, flags
    INTO v_payout
    FROM public.business_payouts
   WHERE id = p_payout_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout_not_found';
  END IF;

  -- Only eligible statuses can be rejected
  IF v_payout.status NOT IN ('pending', 'approved', 'held') THEN
    RAISE EXCEPTION 'ineligible_status: %', v_payout.status;
  END IF;

  -- Approval may commit after the route precheck while this RPC waits for
  -- its row lock. Recheck the manual settlement state under that same lock.
  IF v_payout.status = 'approved' AND v_payout.transfer_method = 'manual_bank' THEN
    RAISE EXCEPTION 'manual_settlement_in_flight';
  END IF;

  -- Check adjustment linkage flags (compliant with R1-R5).
  -- R3 says adjustment_link_failed cannot be cleared. We do not clear flags
  -- on rejection, so R3 is satisfied. However, a payout with a pending or
  -- failed linkage flag represents an unresolved adjustment state: rejecting
  -- it would orphan the deductions. Block rejection until linkage resolves.
  v_has_pending := payout_flag_present(v_payout.flags, 'adjustment_link_pending');
  v_has_failed  := payout_flag_present(v_payout.flags, 'adjustment_link_failed');

  IF v_has_pending OR v_has_failed THEN
    RAISE EXCEPTION 'linkage_flag_blocks_rejection: %',
      CASE WHEN v_has_failed THEN 'adjustment_link_failed'
           ELSE 'adjustment_link_pending'
      END;
  END IF;

  -- Reject the payout. The trigger fn_payout_linkage_guard fires on this
  -- UPDATE. Since we are not changing flags and the target status is
  -- 'rejected' (not in R1's blocked set), the trigger will allow it.
  -- business_payouts has: rejected_reason, updated_at — no rejected_by/rejected_at columns.
  UPDATE public.business_payouts
     SET status          = 'rejected',
         rejected_reason = p_reason,
         updated_at      = now()
   WHERE id = p_payout_id;

  -- Release linked adjustments so they roll into the next payout
  UPDATE public.payout_adjustments
     SET applied_to_payout_id = NULL
   WHERE applied_to_payout_id = p_payout_id;

  GET DIAGNOSTICS v_released = ROW_COUNT;

  RETURN QUERY SELECT p_payout_id, v_released;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- §4. Guard claim_payout_for_transfer against manual_bank payouts
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.claim_payout_for_transfer(
  p_payout_id       UUID,
  p_transfer_method TEXT,
  p_approved_by     UUID DEFAULT NULL
)
RETURNS TABLE(
  claimed_id        UUID,
  claimed_token     UUID,
  idempotency_key   TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_token UUID;
  v_key TEXT;
BEGIN
  -- Only automated transfer methods may claim
  IF p_transfer_method NOT IN ('paystack_transfer', 'stripe_transfer') THEN
    RAISE EXCEPTION 'Unsupported transfer method: %', p_transfer_method
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Generate server-side values
  v_token := gen_random_uuid();
  v_key := 'payout_' || p_payout_id::text;

  -- RETURN QUERY: returns zero rows when CAS predicate fails (M292 contract).
  -- DO NOT use INTO + RETURN NEXT — that returns one NULL row on miss.
  RETURN QUERY
  UPDATE public.business_payouts
  SET status = 'processing',
    claim_token = v_token,
    provider_idempotency_key = v_key,
    processing_started_at = NOW(),
    transfer_method = p_transfer_method,
    approved_by = COALESCE(p_approved_by, approved_by),
    approved_at = COALESCE(approved_at, NOW()),
    updated_at = NOW()
  WHERE id = p_payout_id
    AND status IN ('pending', 'approved', 'held')
    AND (transfer_method IS NULL OR transfer_method IS DISTINCT FROM 'manual_bank')
  RETURNING
    id AS claimed_id,
    claim_token AS claimed_token,
    provider_idempotency_key AS idempotency_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_manual_settlement(
  p_payout_id       UUID,
  p_transfer_ref    TEXT,
  p_attestation     BOOLEAN,
  p_admin_id        UUID
)
RETURNS TABLE(confirmed_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_payout RECORD;
  v_gross NUMERIC;
  v_fees NUMERIC;
  v_gw_fees NUMERIC;
  v_adj_sum NUMERIC;
  v_prior_paid NUMERIC;
  v_available NUMERIC;
BEGIN
  -- Validate inputs before any locking
  IF p_attestation IS NOT TRUE THEN
    RAISE EXCEPTION 'attestation_required'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_transfer_ref IS NULL OR trim(p_transfer_ref) = '' THEN
    RAISE EXCEPTION 'transfer_reference_required'
      USING ERRCODE = 'P0001';
  END IF;

  -- Lock the payout row
  SELECT id, business_id, net_amount, status, transfer_method, currency
  INTO v_payout
  FROM public.business_payouts
  WHERE id = p_payout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_payout.status <> 'approved' THEN
    RAISE EXCEPTION 'ineligible_status: %', v_payout.status
      USING ERRCODE = 'P0001';
  END IF;

  IF v_payout.transfer_method <> 'manual_bank' THEN
    RAISE EXCEPTION 'ineligible_method: %', v_payout.transfer_method
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock: serializes against finalize_refund_execution for this business.
  -- Both RPCs acquire this lock before reading platform_fees or transitioning payouts.
  PERFORM pg_advisory_xact_lock(hashtext('payout_settle:' || v_payout.business_id::text));

 IF v_payout.currency IS NULL OR v_payout.currency !~ '^[A-Z]{3}$' THEN
   RAISE EXCEPTION 'currency_reconciliation_required:payout' USING ERRCODE='P0001';
 END IF;
 IF EXISTS (SELECT 1 FROM public.business_payouts h WHERE h.business_id=v_payout.business_id
  AND (h.currency IS NULL OR h.currency !~ '^[A-Z]{3}$')) THEN
   RAISE EXCEPTION 'currency_reconciliation_required:payout_history' USING ERRCODE='P0001';
 END IF;
 IF EXISTS (SELECT 1 FROM public.payout_adjustments h WHERE h.business_id=v_payout.business_id
  AND (h.currency IS NULL OR h.currency !~ '^[A-Z]{3}$')) THEN
   RAISE EXCEPTION 'currency_reconciliation_required:adjustments' USING ERRCODE='P0001';
 END IF;
 IF EXISTS (SELECT 1 FROM public.platform_fees f LEFT JOIN public.payments pay ON pay.id=f.payment_id
  WHERE f.business_id=v_payout.business_id AND f.is_direct_transfer=false AND f.refunded_at IS NULL
   AND (pay.id IS NULL OR pay.currency IS NULL OR pay.currency !~ '^[A-Z]{3}$'
    OR pay.business_id IS DISTINCT FROM v_payout.business_id)) THEN
   RAISE EXCEPTION 'currency_reconciliation_required:fees' USING ERRCODE='P0001';
 END IF;


  -- Authoritative balance check UNDER the advisory lock.
  -- Same formula as computePlatformHeldTotals in payable-fees.ts:
  --   eligible = platform_fees WHERE is_direct_transfer = false AND refunded_at IS NULL
  --   gross = SUM(transaction_amount)
  --   fees = SUM(fee_total) WHERE NOT waived
  --   gw = SUM(gateway_fee)
  --   adj = SUM(payout_adjustments.amount)
  --   prior = SUM(business_payouts.net_amount) WHERE status IN (paid,processing,review_required) AND id != this
  --   available = MAX(0, gross - fees - gw + adj - prior)

  SELECT COALESCE(SUM(f.transaction_amount),0),
    COALESCE(SUM(CASE WHEN NOT f.waived THEN f.fee_total ELSE 0 END),0),
    COALESCE(SUM(f.gateway_fee),0)
  INTO v_gross,v_fees,v_gw_fees
  FROM public.platform_fees f JOIN public.payments pay ON pay.id=f.payment_id
  WHERE f.business_id=v_payout.business_id AND f.is_direct_transfer=false
   AND f.refunded_at IS NULL AND pay.currency=v_payout.currency
   AND pay.business_id=v_payout.business_id;

  SELECT COALESCE(SUM(amount), 0) INTO v_adj_sum
  FROM public.payout_adjustments
  WHERE business_id = v_payout.business_id AND currency = v_payout.currency;

  SELECT COALESCE(SUM(net_amount), 0) INTO v_prior_paid
  FROM public.business_payouts
  WHERE business_id = v_payout.business_id
    AND status IN ('paid', 'processing', 'review_required', 'approved')
    AND id <> p_payout_id AND currency = v_payout.currency;

  v_available := GREATEST(0, v_gross - v_fees - v_gw_fees + v_adj_sum - v_prior_paid);

  IF v_payout.net_amount > v_available + 0.01 THEN
    RAISE EXCEPTION 'insufficient_balance: payout=%, available=%', v_payout.net_amount, v_available
      USING ERRCODE = 'P0001';
  END IF;

  -- Atomic transition: approved → paid
  UPDATE public.business_payouts
  SET status = 'paid',
      transfer_reference = trim(p_transfer_ref),
      paid_at = NOW(),
      updated_at = NOW()
  WHERE id = p_payout_id
    AND status = 'approved'
    AND transfer_method = 'manual_bank';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cas_conflict'
      USING ERRCODE = 'P0001';
  END IF;

  -- Atomic audit log — same transaction, rolls back with status change
  INSERT INTO public.admin_audit_logs (
    actor_id, action, entity_type, entity_id, details
  ) VALUES (
    p_admin_id,
    'confirm_payout_settlement',
    'business_payout',
    p_payout_id,
    jsonb_build_object(
      'business_id', v_payout.business_id,
      'amount', v_payout.net_amount,
      'currency', v_payout.currency,
      'transfer_reference', trim(p_transfer_ref),
      'attestation', 'Admin attested that the bank transfer has been completed'
    )
  );

  RETURN QUERY SELECT p_payout_id AS confirmed_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_payout_and_release_adjustments(uuid,text),public.claim_payout_for_transfer(uuid,text,uuid),public.confirm_manual_settlement(uuid,text,boolean,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reject_payout_and_release_adjustments(uuid,text),public.claim_payout_for_transfer(uuid,text,uuid),public.confirm_manual_settlement(uuid,text,boolean,uuid) TO service_role;
DROP TRIGGER IF EXISTS trg_payout_linkage_guard ON public.business_payouts;
CREATE TRIGGER trg_payout_linkage_guard BEFORE INSERT OR UPDATE ON public.business_payouts FOR EACH ROW EXECUTE FUNCTION public.fn_payout_linkage_guard();
DROP INDEX public.idx_business_payouts_period_unique;
CREATE UNIQUE INDEX idx_business_payouts_period_unique ON public.business_payouts (business_id,period_start,period_end,COALESCE(currency,'__legacy__')) WHERE status NOT IN ('rejected','failed');

$financial$;
EXECUTE $dispatcher$
CREATE TRIGGER guard_enrolled_payment_identity BEFORE UPDATE OR DELETE ON public.payments FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_enrolled_payment_identity();

CREATE TRIGGER guard_accounting_held_payout BEFORE INSERT OR UPDATE OR DELETE ON public.business_payouts FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_accounting_held_payout();

CREATE TRIGGER guard_accounting_fee_provenance BEFORE INSERT OR UPDATE OR DELETE ON public.platform_fees FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_accounting_fee_provenance();

CREATE OR REPLACE FUNCTION public.finalize_refund_execution(p_refund_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r record; p record; m record; business uuid; h record; total numeric; full_refund boolean;
BEGIN
 SELECT business_id INTO business FROM public.refunds WHERE id=p_refund_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('finalized',false,'reason','refund_not_found'); END IF;
 PERFORM accounting_private.accounting_business_lock(business);
 SELECT * INTO r FROM public.refunds WHERE id=p_refund_id FOR UPDATE;
 IF r.business_id IS DISTINCT FROM business THEN RAISE EXCEPTION 'refund_business_mismatch'; END IF;
 IF r.status='success' THEN RETURN jsonb_build_object('finalized',true,'reason','already_finalized'); END IF;
 IF r.status<>'provider_success_unfinalized' THEN RETURN jsonb_build_object('finalized',false,'reason','invalid_state','current_status',r.status); END IF;
 SELECT * INTO p FROM public.payments WHERE id=r.payment_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('finalized',false,'reason','payment_not_found'); END IF;
 IF p.business_id IS DISTINCT FROM business THEN RAISE EXCEPTION 'refund_business_mismatch'; END IF;
 SELECT * INTO m FROM public.legacy_refund_accounting_membership WHERE payment_id=p.id;
 IF NOT FOUND THEN RETURN accounting_private.finalize_refund_accounting_modern(p_refund_id); END IF;
 IF m.business_id IS DISTINCT FROM business OR p.currency IS DISTINCT FROM m.payment_currency OR p.amount IS DISTINCT FROM m.payment_amount OR p.gateway IS DISTINCT FROM m.gateway OR p.gateway_reference IS DISTINCT FROM m.gateway_reference OR p.metadata->>'provider_connection_id' IS DISTINCT FROM m.provider_connection_id OR p.metadata->>'connect_account_id' IS DISTINCT FROM m.connect_account_id
 OR p.booking_id IS DISTINCT FROM m.booking_id OR p.invoice_id IS DISTINCT FROM m.invoice_id OR p.order_id IS DISTINCT FROM m.order_id
 OR p.reservation_id IS DISTINCT FROM m.reservation_id THEN RAISE EXCEPTION 'enrolled_payment_identity_mismatch'; END IF;
 SELECT * INTO h FROM public.merchant_accounting_holds WHERE business_id=business FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'enrolled_payment_hold_missing'; END IF;
 IF r.amount IS NULL OR r.amount<=0 OR COALESCE(p.refund_amount,0)+r.amount>p.amount THEN RAISE EXCEPTION 'refund_amount_invalid'; END IF;
 IF NOT h.active THEN
  UPDATE public.merchant_accounting_holds SET active=true,epoch=epoch+1,activated_at=clock_timestamp() WHERE business_id=business RETURNING * INTO h;
 END IF;
 total:=COALESCE(p.refund_amount,0)+r.amount;full_refund:=total>=p.amount;
 INSERT INTO public.refund_accounting_exceptions(refund_id,payment_id,business_id,amount,currency,provider_evidence,membership_evidence_sha256,hold_epoch)
 VALUES(r.id,p.id,business,r.amount,p.currency,jsonb_build_object('gateway',to_jsonb(r)->'gateway','provider_refund_id',to_jsonb(r)->'provider_refund_id','provider_connection_id',to_jsonb(r)->'provider_connection_id','connect_account_id',to_jsonb(r)->'connect_account_id','durable_status',r.status),m.evidence_sha256,h.epoch);
 UPDATE public.payments SET refund_amount=total,refund_reason=r.reason,refunded_at=now(),refunded_by=r.initiated_by,
 status=CASE WHEN full_refund THEN 'refunded'::public.payment_status ELSE status END WHERE id=p.id;
 IF full_refund AND p.booking_id IS NOT NULL THEN UPDATE public.bookings SET deposit_status='refunded' WHERE id=p.booking_id; END IF;
 IF full_refund AND p.reservation_id IS NOT NULL THEN UPDATE public.reservations SET deposit_status='refunded' WHERE id=p.reservation_id; END IF;
 UPDATE public.refunds SET status='success',finalized_at=now() WHERE id=r.id;
 INSERT INTO public.admin_audit_logs(actor_id,action,entity_type,entity_id,details)
 VALUES(r.initiated_by,'refund_accounting_deferred','refund',r.id,jsonb_build_object('business_id',business,'payment_id',p.id,'amount',r.amount,'currency',p.currency,'hold_epoch',h.epoch));
 RETURN jsonb_build_object('finalized',true,'fully_refunded',full_refund,'accounting_status','deferred');
END $$;

REVOKE ALL ON FUNCTION public.finalize_refund_execution(uuid) FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION public.finalize_refund_execution(uuid) TO service_role;

CREATE TRIGGER guard_accounting_adjustment_provenance BEFORE INSERT OR UPDATE OR DELETE ON public.payout_adjustments FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_accounting_adjustment_provenance();

$dispatcher$;
EXECUTE $after$
CREATE TEMP TABLE packet_catalog_after ON COMMIT DROP AS SELECT jsonb_build_object('observed_at',transaction_timestamp(),'read_only',current_setting('transaction_read_only'),
'hold_tables',jsonb_build_object('holds',to_regclass('public.merchant_accounting_holds')::text,'membership',to_regclass('public.legacy_refund_accounting_membership')::text,'exceptions',to_regclass('public.refund_accounting_exceptions')::text),
'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'signature',p.oid::regprocedure::text,'parallel',p.proparallel,'volatility',p.provolatile,'strict',p.proisstrict,'returns',pg_get_function_result(p.oid),'service_execute',has_function_privilege('service_role',p.oid,'EXECUTE'),'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),'body_sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl::text) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('finalize_refund_execution','confirm_manual_settlement','force_settle_manual_payout','force_settle_executed_transfer','claim_payout_for_transfer','reject_payout_and_release_adjustments','mark_payout_provider_submitted','mark_payout_transfer_failed','mark_payout_failed','mark_payout_review_required','check_session_exists','payout_flag_present','payout_flag_adjustment_ids','fn_payout_linkage_guard')),
'table_security',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl::text,'service_select',has_table_privilege('service_role',c.oid,'SELECT'),'service_insert',has_table_privilege('service_role',c.oid,'INSERT'),'service_update',has_table_privilege('service_role',c.oid,'UPDATE'),'service_delete',has_table_privilege('service_role',c.oid,'DELETE'),'authenticated_insert',has_table_privilege('authenticated',c.oid,'INSERT'),'authenticated_update',has_table_privilege('authenticated',c.oid,'UPDATE')) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('business_payouts','platform_fees','payout_adjustments','payments','admin_step_up_authorizations','admin_audit_logs')),
'columns',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type,'udt',udt_name,'default',column_default,'nullable',is_nullable) ORDER BY table_name,ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND ((table_name IN('business_payouts','payout_adjustments') AND column_name IN('currency','status')) OR table_name='admin_step_up_authorizations')),
'constraints',(SELECT jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conrelid,c.conname) FROM pg_constraint c WHERE c.conrelid IN(to_regclass('public.business_payouts'),to_regclass('public.payout_adjustments'),to_regclass('public.admin_step_up_authorizations'))),
'indexes',(SELECT jsonb_agg(jsonb_build_object('table',tablename,'name',indexname,'definition',indexdef) ORDER BY tablename,indexname) FROM pg_indexes WHERE schemaname='public' AND tablename IN('business_payouts','payout_adjustments')),
'triggers',(SELECT jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN(to_regclass('public.business_payouts'),to_regclass('public.platform_fees'),to_regclass('public.payout_adjustments'),to_regclass('public.payments'))),
'global_inflight_payouts',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'business_id',p.business_id,'status',p.status,'row_sha256',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')) ORDER BY p.id),'[]') FROM public.business_payouts p WHERE p.status IN('approved','processing','review_required'))
) AS preflight_catalog;
DO $packet$
DECLARE target jsonb:='[{"schema":"accounting_private","name":"accounting_business_lock","signature":"accounting_private.accounting_business_lock(uuid)","returns":"void","config":["search_path=\"\""],"volatility":"v","parallel":"u","strict":false,"body_sha256":"7fcc6816b29d0082b4a1ce23de0ddf0f11b397dfbc85ae3cc2ffb2a6694d4333","definer":true},{"schema":"public","name":"assert_merchant_settlement_available","signature":"public.assert_merchant_settlement_available(uuid)","returns":"void","config":["search_path=\"\""],"volatility":"v","parallel":"u","strict":false,"body_sha256":"9a03896729e0161f5697a705ce68696947895a1f00be48927f90134620c022cd","definer":false},{"schema":"accounting_private","name":"enroll_merchant_accounting_hold","signature":"accounting_private.enroll_merchant_accounting_hold(uuid,text,uuid)","returns":"void","config":["search_path=\"\""],"volatility":"v","parallel":"u","strict":false,"body_sha256":"2bf329bfb7c738e97eff144c7266b514de127b3318c6e46bcc391c04fc684f63","definer":true},{"schema":"accounting_private","name":"enroll_legacy_refund_accounting","signature":"accounting_private.enroll_legacy_refund_accounting(uuid,uuid,text,uuid)","returns":"void","config":["search_path=\"\""],"volatility":"v","parallel":"u","strict":false,"body_sha256":"47a6d7ebc98469de951a26e5875eaf31f0eb37a1b8328647358e41cad071084c","definer":true},{"schema":"accounting_private","name":"guard_enrolled_payment_identity","signature":"accounting_private.guard_enrolled_payment_identity()","returns":"trigger","config":["search_path=\"\""],"volatility":"v","parallel":"u","strict":false,"body_sha256":"cec025ee6b4c8d4a0d45ad52238981b9c263012bfaf61c1a740ab9e3e3266e8a","definer":true},{"schema":"accounting_private","name":"guard_accounting_held_payout","signature":"accounting_private.guard_accounting_held_payout()","returns":"trigger","config":["search_path=\"\""],"volatility":"v","parallel":"u","strict":false,"body_sha256":"e9089866d2c3160ff5c6860240ae5633ba16fe98e47d1a7cb21d34990b287175","definer":true},{"schema":"accounting_private","name":"guard_accounting_fee_provenance","signature":"accounting_private.guard_accounting_fee_provenance()","returns":"trigger","config":["search_path=\"\""],"volatility":"v","parallel":"u","strict":false,"body_sha256":"e147e6ab4a2d379a274fd069190d499ceec2f9b004248227ea63998b418302de","definer":true},{"schema":"accounting_private","name":"finalize_refund_accounting_modern","signature":"accounting_private.finalize_refund_accounting_modern(uuid)","returns":"jsonb","config":["search_path=\"\""],"volatility":"v","parallel":"u","strict":false,"body_sha256":"a87d30b00fb5c6ed6a55b7acd45b746a58da8a890420e106ee50df322985069a","definer":true},{"schema":"accounting_private","name":"guard_accounting_adjustment_provenance","signature":"accounting_private.guard_accounting_adjustment_provenance()","returns":"trigger","config":["search_path=\"\""],"volatility":"v","parallel":"u","strict":false,"body_sha256":"104af61230505ab6c46cd6cf87c1a7bd8593a7bdd643efeacbafd857c17f56a5","definer":true},{"schema":"public","name":"payout_flag_present","signature":"public.payout_flag_present(jsonb,text)","returns":"boolean","config":["search_path=public, pg_temp"],"volatility":"i","parallel":"u","strict":false,"body_sha256":"8696e734f51b42ba685ba520d050ae831ae2b4622647856364169a66e2e61bd5","definer":false},{"schema":"public","name":"payout_flag_adjustment_ids","signature":"public.payout_flag_adjustment_ids(jsonb,text)","returns":"uuid[]","config":["search_path=public, pg_temp"],"volatility":"i","parallel":"u","strict":false,"body_sha256":"9fe825b98dd1c522c940cb66918f444a16aa29ddc77c2a7df35eb240fde0eca6","definer":false},{"schema":"public","name":"fn_payout_linkage_guard","signature":"public.fn_payout_linkage_guard()","returns":"trigger","config":["search_path=public, pg_temp"],"volatility":"v","parallel":"u","strict":false,"body_sha256":"a0812d479775f083e858972aca2afc0f54f11aa4672334ea7b97ba20acf09f1b","definer":false},{"schema":"public","name":"reject_payout_and_release_adjustments","signature":"public.reject_payout_and_release_adjustments(uuid,text)","returns":"table(rejected_iduuid,adjustments_releasedinteger)","config":["search_path=public, pg_temp"],"volatility":"v","parallel":"u","strict":false,"body_sha256":"1f97fddb1a7f59656bc3f045c3d6a235bd4f596d589c407cfd30663e346baa77","definer":false},{"schema":"public","name":"claim_payout_for_transfer","signature":"public.claim_payout_for_transfer(uuid,text,uuid)","returns":"table(claimed_iduuid,claimed_tokenuuid,idempotency_keytext)","config":["search_path=public, extensions"],"volatility":"v","parallel":"u","strict":false,"body_sha256":"d2efb99ccc55749cf22e653fc1887fc10c559605a8728cfbdb5c1338c2d54cc9","definer":true},{"schema":"public","name":"confirm_manual_settlement","signature":"public.confirm_manual_settlement(uuid,text,boolean,uuid)","returns":"table(confirmed_iduuid)","config":["search_path=public, extensions"],"volatility":"v","parallel":"u","strict":false,"body_sha256":"6c7f7a3031bdaf66516c414a964b108e3e938b95bd9709aea9509b3fff7b212b","definer":true},{"schema":"public","name":"finalize_token_recurring_charge","signature":"public.finalize_token_recurring_charge(text,uuid,numeric,text,text,text)","returns":"jsonb","config":["search_path=public"],"volatility":"v","parallel":"u","strict":false,"body_sha256":"3980973cf6da922f21e41653a3f383bc7bb4cdaaf4ea55a08aee2a0601c87371","definer":true},{"schema":"public","name":"finalize_stripe_recurring_charge","signature":"public.finalize_stripe_recurring_charge(uuid,text,text,int,text,text)","returns":"jsonb","config":["search_path=public"],"volatility":"v","parallel":"u","strict":false,"body_sha256":"1e6cd91c1e1fe607b43e46399212b87033745982768df81a89d988245e8fb56f","definer":true},{"schema":"public","name":"finalize_paystack_recurring_charge","signature":"public.finalize_paystack_recurring_charge(uuid,int,text,text,text)","returns":"jsonb","config":["search_path=public"],"volatility":"v","parallel":"u","strict":false,"body_sha256":"8c237dcab859d6c18c307640dade3d6916a5af0ecd7b38f832613f2a594ca37d","definer":true},{"schema":"public","name":"finalize_refund_execution","signature":"public.finalize_refund_execution(uuid)","returns":"jsonb","config":["search_path=\"\""],"volatility":"v","parallel":"u","strict":false,"body_sha256":"3981a0a7fea422f9498218bcd1e7a569bcfc38d01c8512820e0d021e18786660","definer":true}]'::jsonb; f jsonb; row record; before jsonb; after jsonb; expected jsonb; actual jsonb;
BEGIN
 SELECT preflight_catalog INTO before FROM packet_catalog_before;SELECT preflight_catalog INTO after FROM packet_catalog_after;
 IF before->'table_security' IS DISTINCT FROM after->'table_security' OR before->'columns' IS DISTINCT FROM after->'columns' OR before->'constraints' IS DISTINCT FROM after->'constraints' THEN RAISE EXCEPTION 'packet_unrelated_schema_or_acl_changed'; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(target) LOOP
 IF f->>'name'='finalize_paystack_recurring_charge' AND current_setting('app.accounting_paystack_variant',true)='canonical' THEN f=jsonb_set(f,'{config}','["search_path=public, extensions"]'::jsonb); END IF;
  SELECT p.*,pg_get_userbyid(p.proowner) owner_name INTO row FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=to_regprocedure(f->>'signature');
  IF NOT FOUND OR row.owner_name<>current_user OR row.prosecdef<>(f->>'definer')::boolean OR to_jsonb(row.proconfig) IS DISTINCT FROM f->'config' OR row.provolatile::text<>f->>'volatility' OR row.proparallel::text<>f->>'parallel' OR row.proisstrict<>(f->>'strict')::boolean OR (SELECT lanname FROM pg_language WHERE oid=row.prolang)<>'plpgsql' OR regexp_replace(lower(pg_get_function_result(row.oid)),'\s','','g')<>f->>'returns' OR (encode(sha256(convert_to(row.prosrc,'UTF8')),'hex')<>f->>'body_sha256' AND NOT (f->>'name'='finalize_paystack_recurring_charge' AND encode(sha256(convert_to(row.prosrc,'UTF8')),'hex')='c69b93ff28a01edbddac47e1205f0d9a94c5eceeca824098bec01ed3c4f0783c')) THEN RAISE EXCEPTION 'packet_target_function_contract_failed: %',f->>'name'; END IF;
  IF f->>'schema'='accounting_private' AND (has_function_privilege('service_role',row.oid,'EXECUTE') OR has_function_privilege('anon',row.oid,'EXECUTE') OR has_function_privilege('authenticated',row.oid,'EXECUTE')) THEN RAISE EXCEPTION 'packet_private_function_exposed'; END IF;
  IF f->>'schema'='public' AND f->>'name'=ANY(ARRAY['confirm_manual_settlement','reject_payout_and_release_adjustments','claim_payout_for_transfer','finalize_refund_execution','assert_merchant_settlement_available','finalize_token_recurring_charge','finalize_stripe_recurring_charge','finalize_paystack_recurring_charge']) AND (NOT has_function_privilege('service_role',row.oid,'EXECUTE') OR has_function_privilege('anon',row.oid,'EXECUTE') OR has_function_privilege('authenticated',row.oid,'EXECUTE')) THEN RAISE EXCEPTION 'packet_financial_function_acl_failed'; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.idx_business_payouts_period_unique') AND indisunique AND indisvalid AND indisready AND pg_get_indexdef(indexrelid,0,false)='CREATE UNIQUE INDEX idx_business_payouts_period_unique ON public.business_payouts USING btree (business_id, period_start, period_end, COALESCE(currency, ''__legacy__''::character varying)) WHERE ((status)::text <> ALL ((ARRAY[''rejected''::character varying, ''failed''::character varying])::text[]))') THEN RAISE EXCEPTION 'packet_target_index_failed'; END IF;
 FOR row IN SELECT oid,relrowsecurity FROM pg_class WHERE oid IN('public.merchant_accounting_holds'::regclass,'public.legacy_refund_accounting_membership'::regclass,'public.refund_accounting_exceptions'::regclass) LOOP
  IF NOT row.relrowsecurity OR NOT has_table_privilege('service_role',row.oid,'SELECT') OR has_table_privilege('service_role',row.oid,'INSERT,UPDATE,DELETE') OR has_table_privilege('anon',row.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated',row.oid,'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'packet_new_table_acl_failed'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM merchant_accounting_holds)<>jsonb_array_length(current_setting('app.accounting_enrollment_manifest')::jsonb->'business_holds') OR (SELECT count(*) FROM legacy_refund_accounting_membership)<>jsonb_array_length(current_setting('app.accounting_enrollment_manifest')::jsonb->'payment_membership') OR EXISTS(SELECT 1 FROM refund_accounting_exceptions) THEN RAISE EXCEPTION 'packet_enrollment_after_count_failed'; END IF;
END $packet$;
CREATE TEMP TABLE packet_structure_after ON COMMIT DROP AS SELECT jsonb_build_object(
 'schema',(SELECT jsonb_build_object('name',n.nspname,'owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl::text,'anon_usage',has_schema_privilege('anon',n.oid,'USAGE'),'authenticated_usage',has_schema_privilege('authenticated',n.oid,'USAGE'),'service_usage',has_schema_privilege('service_role',n.oid,'USAGE')) FROM pg_namespace n WHERE n.nspname='accounting_private'),
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'owner_default_acl_exact',((SELECT jsonb_agg(to_jsonb(x) ORDER BY privilege_type) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE grantee=c.relowner) IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(x) ORDER BY privilege_type) FROM aclexplode(acldefault('r',c.relowner)) x)),'nonowner_acl',(SELECT COALESCE(jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee,x.privilege_type),'[]') FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE x.grantee<>c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'definition',pg_get_constraintdef(x.oid),'validated',x.convalidated) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid,0,false),'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),'policies',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',p.polname,'cmd',p.polcmd)),'[]') FROM pg_policy p WHERE p.polrelid=c.oid)) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('merchant_accounting_holds','legacy_refund_accounting_membership','refund_accounting_exceptions')),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'table',c.relname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,false),'function',p.oid::regprocedure::text,'type',t.tgtype) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgname IN('trg_payout_linkage_guard','guard_enrolled_payment_identity','guard_accounting_held_payout','guard_accounting_fee_provenance','guard_accounting_adjustment_provenance'))
) AS structural_contract;
DO $packet$ BEGIN IF (SELECT structural_contract FROM packet_structure_after) IS DISTINCT FROM replace('{"schema":{"acl":"{postgres=UC/postgres}","name":"accounting_private","owner":"postgres","anon_usage":false,"service_usage":false,"authenticated_usage":false},"tables":[{"rls":true,"name":"legacy_refund_accounting_membership","owner":"postgres","columns":[{"name":"payment_id","type":"uuid","default":null,"not_null":true},{"name":"business_id","type":"uuid","default":null,"not_null":true},{"name":"payment_currency","type":"text","default":null,"not_null":false},{"name":"payment_amount","type":"numeric","default":null,"not_null":true},{"name":"gateway","type":"text","default":null,"not_null":false},{"name":"gateway_reference","type":"text","default":null,"not_null":false},{"name":"provider_connection_id","type":"text","default":null,"not_null":false},{"name":"connect_account_id","type":"text","default":null,"not_null":false},{"name":"booking_id","type":"uuid","default":null,"not_null":false},{"name":"invoice_id","type":"uuid","default":null,"not_null":false},{"name":"order_id","type":"uuid","default":null,"not_null":false},{"name":"reservation_id","type":"uuid","default":null,"not_null":false},{"name":"evidence_sha256","type":"text","default":null,"not_null":true},{"name":"created_at","type":"timestamp with time zone","default":"now()","not_null":true}],"indexes":[{"name":"legacy_refund_accounting_membership_pkey","ready":true,"valid":true,"unique":true,"definition":"CREATE UNIQUE INDEX legacy_refund_accounting_membership_pkey ON public.legacy_refund_accounting_membership USING btree (payment_id)"}],"policies":[],"force_rls":false,"constraints":[{"name":"legacy_refund_accounting_membership_business_id_fkey","validated":true,"definition":"FOREIGN KEY (business_id) REFERENCES merchant_accounting_holds(business_id) ON DELETE RESTRICT"},{"name":"legacy_refund_accounting_membership_evidence_sha256_check","validated":true,"definition":"CHECK ((evidence_sha256 ~ ''^[a-f0-9]{64}$''::text))"},{"name":"legacy_refund_accounting_membership_payment_id_fkey","validated":true,"definition":"FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT"},{"name":"legacy_refund_accounting_membership_pkey","validated":true,"definition":"PRIMARY KEY (payment_id)"}],"owner_default_acl_exact":true,"nonowner_acl":[{"grantee":"service_role","grantor":"postgres","privilege":"SELECT","grantable":false}]},{"rls":true,"name":"merchant_accounting_holds","owner":"postgres","columns":[{"name":"business_id","type":"uuid","default":null,"not_null":true},{"name":"active","type":"boolean","default":"true","not_null":true},{"name":"epoch","type":"bigint","default":"1","not_null":true},{"name":"evidence_sha256","type":"text","default":null,"not_null":true},{"name":"activated_at","type":"timestamp with time zone","default":"clock_timestamp()","not_null":true},{"name":"created_at","type":"timestamp with time zone","default":"now()","not_null":true}],"indexes":[{"name":"merchant_accounting_holds_pkey","ready":true,"valid":true,"unique":true,"definition":"CREATE UNIQUE INDEX merchant_accounting_holds_pkey ON public.merchant_accounting_holds USING btree (business_id)"}],"policies":[],"force_rls":false,"constraints":[{"name":"merchant_accounting_holds_business_id_fkey","validated":true,"definition":"FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT"},{"name":"merchant_accounting_holds_epoch_check","validated":true,"definition":"CHECK ((epoch > 0))"},{"name":"merchant_accounting_holds_evidence_sha256_check","validated":true,"definition":"CHECK ((evidence_sha256 ~ ''^[a-f0-9]{64}$''::text))"},{"name":"merchant_accounting_holds_pkey","validated":true,"definition":"PRIMARY KEY (business_id)"}],"owner_default_acl_exact":true,"nonowner_acl":[{"grantee":"service_role","grantor":"postgres","privilege":"SELECT","grantable":false}]},{"rls":true,"name":"refund_accounting_exceptions","owner":"postgres","columns":[{"name":"refund_id","type":"uuid","default":null,"not_null":true},{"name":"payment_id","type":"uuid","default":null,"not_null":true},{"name":"business_id","type":"uuid","default":null,"not_null":true},{"name":"amount","type":"numeric","default":null,"not_null":true},{"name":"currency","type":"text","default":null,"not_null":false},{"name":"provider_evidence","type":"jsonb","default":null,"not_null":true},{"name":"membership_evidence_sha256","type":"text","default":null,"not_null":true},{"name":"hold_epoch","type":"bigint","default":null,"not_null":true},{"name":"created_at","type":"timestamp with time zone","default":"now()","not_null":true}],"indexes":[{"name":"refund_accounting_exceptions_pkey","ready":true,"valid":true,"unique":true,"definition":"CREATE UNIQUE INDEX refund_accounting_exceptions_pkey ON public.refund_accounting_exceptions USING btree (refund_id)"}],"policies":[],"force_rls":false,"constraints":[{"name":"refund_accounting_exceptions_amount_check","validated":true,"definition":"CHECK ((amount > (0)::numeric))"},{"name":"refund_accounting_exceptions_business_id_fkey","validated":true,"definition":"FOREIGN KEY (business_id) REFERENCES merchant_accounting_holds(business_id) ON DELETE RESTRICT"},{"name":"refund_accounting_exceptions_payment_id_fkey","validated":true,"definition":"FOREIGN KEY (payment_id) REFERENCES legacy_refund_accounting_membership(payment_id) ON DELETE RESTRICT"},{"name":"refund_accounting_exceptions_pkey","validated":true,"definition":"PRIMARY KEY (refund_id)"},{"name":"refund_accounting_exceptions_refund_id_fkey","validated":true,"definition":"FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE RESTRICT"}],"owner_default_acl_exact":true,"nonowner_acl":[{"grantee":"service_role","grantor":"postgres","privilege":"SELECT","grantable":false}]}],"triggers":[{"name":"guard_accounting_held_payout","type":31,"table":"business_payouts","enabled":"O","function":"accounting_private.guard_accounting_held_payout()","definition":"CREATE TRIGGER guard_accounting_held_payout BEFORE INSERT OR DELETE OR UPDATE ON public.business_payouts FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_accounting_held_payout()"},{"name":"trg_payout_linkage_guard","type":23,"table":"business_payouts","enabled":"O","function":"fn_payout_linkage_guard()","definition":"CREATE TRIGGER trg_payout_linkage_guard BEFORE INSERT OR UPDATE ON public.business_payouts FOR EACH ROW EXECUTE FUNCTION fn_payout_linkage_guard()"},{"name":"guard_enrolled_payment_identity","type":27,"table":"payments","enabled":"O","function":"accounting_private.guard_enrolled_payment_identity()","definition":"CREATE TRIGGER guard_enrolled_payment_identity BEFORE DELETE OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_enrolled_payment_identity()"},{"name":"guard_accounting_adjustment_provenance","type":31,"table":"payout_adjustments","enabled":"O","function":"accounting_private.guard_accounting_adjustment_provenance()","definition":"CREATE TRIGGER guard_accounting_adjustment_provenance BEFORE INSERT OR DELETE OR UPDATE ON public.payout_adjustments FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_accounting_adjustment_provenance()"},{"name":"guard_accounting_fee_provenance","type":31,"table":"platform_fees","enabled":"O","function":"accounting_private.guard_accounting_fee_provenance()","definition":"CREATE TRIGGER guard_accounting_fee_provenance BEFORE INSERT OR DELETE OR UPDATE ON public.platform_fees FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_accounting_fee_provenance()"}]}','postgres',current_user)::jsonb THEN RAISE EXCEPTION 'packet_structural_contract_failed'; END IF; END $packet$;

$after$;
END $activation$;
REVOKE ALL ON PROCEDURE accounting_private.activate_merchant_accounting(text,text,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
