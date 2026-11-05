-- PRIVATE UNNUMBERED FORWARD CANDIDATE. Not applied. Enrollment is separate data authorization.
BEGIN;
CREATE SCHEMA accounting_private;
REVOKE ALL ON SCHEMA accounting_private FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.merchant_accounting_holds (
 business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE RESTRICT,
 active boolean NOT NULL DEFAULT true,
 epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.legacy_refund_accounting_membership (
 payment_id uuid PRIMARY KEY REFERENCES public.payments(id) ON DELETE RESTRICT,
 business_id uuid NOT NULL REFERENCES public.merchant_accounting_holds(business_id) ON DELETE RESTRICT,
 payment_currency text, payment_amount numeric NOT NULL, gateway text, gateway_reference text, provider_connection_id text, connect_account_id text,
 booking_id uuid, invoice_id uuid, order_id uuid, reservation_id uuid,
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.refund_accounting_exceptions (
 refund_id uuid PRIMARY KEY REFERENCES public.refunds(id) ON DELETE RESTRICT,
 payment_id uuid NOT NULL REFERENCES public.legacy_refund_accounting_membership(payment_id) ON DELETE RESTRICT,
 business_id uuid NOT NULL REFERENCES public.merchant_accounting_holds(business_id) ON DELETE RESTRICT,
 amount numeric NOT NULL CHECK(amount>0), currency text,
 provider_evidence jsonb NOT NULL,
 membership_evidence_sha256 text NOT NULL,
 hold_epoch bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.merchant_accounting_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_refund_accounting_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refund_accounting_exceptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.merchant_accounting_holds,public.legacy_refund_accounting_membership,public.refund_accounting_exceptions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.merchant_accounting_holds,public.legacy_refund_accounting_membership,public.refund_accounting_exceptions TO service_role;

CREATE FUNCTION accounting_private.accounting_business_lock(p_business_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_business_id IS NULL THEN RAISE EXCEPTION 'accounting_business_required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('payout_settle:' || p_business_id::text));
END $$;
REVOKE ALL ON FUNCTION accounting_private.accounting_business_lock(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.assert_merchant_settlement_available(p_business_id uuid) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF p_business_id IS NULL THEN RAISE EXCEPTION 'accounting_business_required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('payout_settle:' || p_business_id::text));
 IF EXISTS(SELECT 1 FROM public.merchant_accounting_holds WHERE business_id=p_business_id AND active) THEN
  RAISE EXCEPTION 'merchant_accounting_held' USING ERRCODE='P0001';
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_merchant_settlement_available(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.assert_merchant_settlement_available(uuid) TO service_role;

-- Business-domain enrollment is independent of the narrower refund-payment cohort.
-- Owner-only reviewed packet; no application role can activate or release holds.
CREATE FUNCTION accounting_private.enroll_merchant_accounting_hold(p_business_id uuid,p_evidence_sha256 text,p_actor_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM accounting_private.accounting_business_lock(p_business_id);
 IF p_actor_id IS NULL OR p_evidence_sha256 IS NULL OR p_evidence_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'accounting_enrollment_evidence'; END IF;
 IF EXISTS(SELECT 1 FROM public.business_payouts WHERE business_id=p_business_id AND status IN('approved','processing','review_required')) THEN RAISE EXCEPTION 'accounting_enrollment_inflight_requires_review'; END IF;
 INSERT INTO public.merchant_accounting_holds(business_id,evidence_sha256) VALUES(p_business_id,p_evidence_sha256);
 INSERT INTO public.admin_audit_logs(actor_id,action,entity_type,entity_id,details)
 VALUES(p_actor_id,'merchant_accounting_held','business',p_business_id,jsonb_build_object('evidence_sha256',p_evidence_sha256));
END $$;
REVOKE ALL ON FUNCTION accounting_private.enroll_merchant_accounting_hold(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Enrollment helper has NO application-role EXECUTE. Owner-reviewed SQL packet only.
CREATE FUNCTION accounting_private.enroll_legacy_refund_accounting(p_payment_id uuid,p_business_id uuid,p_evidence_sha256 text,p_actor_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p record; entity_col text; entity_id uuid; fee_count integer; unsafe_count integer;
BEGIN
 PERFORM accounting_private.accounting_business_lock(p_business_id);
 SELECT * INTO p FROM public.payments WHERE id=p_payment_id FOR UPDATE;
 IF NOT FOUND OR p.business_id IS DISTINCT FROM p_business_id THEN RAISE EXCEPTION 'accounting_enrollment_identity'; END IF;
 IF p_actor_id IS NULL THEN RAISE EXCEPTION 'accounting_enrollment_actor_required'; END IF;
 IF p_evidence_sha256 IS NULL OR p_evidence_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'accounting_enrollment_evidence'; END IF;
 IF p.booking_id IS NOT NULL THEN entity_col:='booking_id';entity_id:=p.booking_id;
 ELSIF p.invoice_id IS NOT NULL THEN entity_col:='invoice_id';entity_id:=p.invoice_id;
 ELSIF p.order_id IS NOT NULL THEN entity_col:='order_id';entity_id:=p.order_id;
 ELSE RAISE EXCEPTION 'accounting_enrollment_entity'; END IF;
 EXECUTE format('SELECT count(*),count(*) FILTER(WHERE business_id IS DISTINCT FROM $2 OR is_direct_transfer IS DISTINCT FROM false OR payment_id IS NOT NULL) FROM public.platform_fees WHERE %I=$1',entity_col)
 INTO fee_count,unsafe_count USING entity_id,p_business_id;
 IF fee_count=0 OR unsafe_count>0 THEN RAISE EXCEPTION 'accounting_enrollment_mixed_or_unproven'; END IF;
 IF EXISTS(SELECT 1 FROM public.refunds WHERE business_id=p_business_id AND status IN('pending','provider_pending','provider_ambiguous','provider_success_unfinalized'))
 OR EXISTS(SELECT 1 FROM public.business_payouts WHERE business_id=p_business_id AND status IN('approved','processing','review_required')) THEN
  RAISE EXCEPTION 'accounting_enrollment_inflight_requires_review';
 END IF;
 INSERT INTO public.merchant_accounting_holds(business_id,evidence_sha256) VALUES(p_business_id,p_evidence_sha256)
 ON CONFLICT(business_id) DO NOTHING;
 IF EXISTS(SELECT 1 FROM public.merchant_accounting_holds WHERE business_id=p_business_id AND NOT active) THEN RAISE EXCEPTION 'accounting_enrollment_packet_conflict'; END IF;
 INSERT INTO public.legacy_refund_accounting_membership(payment_id,business_id,payment_currency,payment_amount,gateway,gateway_reference,provider_connection_id,connect_account_id,booking_id,invoice_id,order_id,reservation_id,evidence_sha256)
 VALUES(p.id,p.business_id,p.currency,p.amount,p.gateway,p.gateway_reference,p.metadata->>'provider_connection_id',p.metadata->>'connect_account_id',p.booking_id,p.invoice_id,p.order_id,p.reservation_id,p_evidence_sha256);
 INSERT INTO public.admin_audit_logs(actor_id,action,entity_type,entity_id,details)
 VALUES(p_actor_id,'legacy_accounting_enrolled','payment',p.id,jsonb_build_object('business_id',p_business_id,'evidence_sha256',p_evidence_sha256));
END $$;
REVOKE ALL ON FUNCTION accounting_private.enroll_legacy_refund_accounting(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION accounting_private.guard_enrolled_payment_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE m record;
BEGIN
 IF TG_OP='UPDATE' AND NEW.business_id IS DISTINCT FROM OLD.business_id THEN
  PERFORM accounting_private.accounting_business_lock(LEAST(OLD.business_id,NEW.business_id));
  PERFORM accounting_private.accounting_business_lock(GREATEST(OLD.business_id,NEW.business_id));
 ELSE
  PERFORM accounting_private.accounting_business_lock(OLD.business_id);
 END IF;
 SELECT * INTO m FROM public.legacy_refund_accounting_membership WHERE payment_id=OLD.id;
 IF FOUND AND (TG_OP='DELETE' OR NEW.business_id IS DISTINCT FROM m.business_id OR NEW.currency IS DISTINCT FROM m.payment_currency OR NEW.amount IS DISTINCT FROM m.payment_amount OR NEW.gateway IS DISTINCT FROM m.gateway OR NEW.gateway_reference IS DISTINCT FROM m.gateway_reference OR NEW.metadata->>'provider_connection_id' IS DISTINCT FROM m.provider_connection_id OR NEW.metadata->>'connect_account_id' IS DISTINCT FROM m.connect_account_id
 OR NEW.booking_id IS DISTINCT FROM m.booking_id OR NEW.invoice_id IS DISTINCT FROM m.invoice_id OR NEW.order_id IS DISTINCT FROM m.order_id OR NEW.reservation_id IS DISTINCT FROM m.reservation_id) THEN
  RAISE EXCEPTION 'enrolled_payment_identity_immutable';
 END IF;
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM public.platform_fees WHERE payment_id=OLD.id) THEN RAISE EXCEPTION 'accounting_payment_identity_immutable'; END IF;
 IF TG_OP='UPDATE' AND (NEW.business_id,NEW.currency,NEW.booking_id,NEW.invoice_id,NEW.order_id,NEW.reservation_id)
 IS DISTINCT FROM (OLD.business_id,OLD.currency,OLD.booking_id,OLD.invoice_id,OLD.order_id,OLD.reservation_id)
 AND (EXISTS(SELECT 1 FROM public.platform_fees WHERE payment_id=OLD.id) OR EXISTS(SELECT 1 FROM public.refunds WHERE payment_id=OLD.id)) THEN RAISE EXCEPTION 'accounting_payment_identity_immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_enrolled_payment_identity BEFORE UPDATE OR DELETE ON public.payments FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_enrolled_payment_identity();

-- Held payouts may be cancelled, and prior provider authority may report its true outcome.
-- No fresh generation/approval/claim or unproven direct-paid write is permitted.
CREATE FUNCTION accounting_private.guard_accounting_held_payout() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h record;
BEGIN
 IF TG_OP='UPDATE' AND NEW.business_id IS DISTINCT FROM OLD.business_id THEN
  PERFORM accounting_private.accounting_business_lock(LEAST(OLD.business_id,NEW.business_id));
  PERFORM accounting_private.accounting_business_lock(GREATEST(OLD.business_id,NEW.business_id));
  IF EXISTS(SELECT 1 FROM public.merchant_accounting_holds WHERE business_id IN(OLD.business_id,NEW.business_id) AND active) THEN RAISE EXCEPTION 'merchant_accounting_prior_authority_mismatch'; END IF;
 END IF;
 PERFORM accounting_private.accounting_business_lock(COALESCE(NEW.business_id,OLD.business_id));
 SELECT * INTO h FROM public.merchant_accounting_holds WHERE business_id=COALESCE(NEW.business_id,OLD.business_id) AND active;
 IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'merchant_accounting_held'; END IF;
 IF TG_OP='INSERT' THEN RAISE EXCEPTION 'merchant_accounting_held'; END IF;
 IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.net_amount IS DISTINCT FROM OLD.net_amount OR NEW.currency IS DISTINCT FROM OLD.currency
 OR NEW.transfer_method IS DISTINCT FROM OLD.transfer_method OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
 OR NEW.provider_idempotency_key IS DISTINCT FROM OLD.provider_idempotency_key OR NEW.processing_started_at IS DISTINCT FROM OLD.processing_started_at THEN
  RAISE EXCEPTION 'merchant_accounting_prior_authority_mismatch';
 END IF;
 IF OLD.gateway_transfer_code IS NOT NULL AND NEW.gateway_transfer_code IS DISTINCT FROM OLD.gateway_transfer_code THEN RAISE EXCEPTION 'merchant_accounting_provider_reference_mismatch'; END IF;
 IF OLD.status IN('processing','review_required','paid') AND OLD.claim_token IS NOT NULL AND OLD.provider_idempotency_key IS NOT NULL
 AND OLD.processing_started_at IS NOT NULL AND OLD.processing_started_at<=h.activated_at
 AND NEW.status IN('processing','review_required','paid','failed')
 AND NOT (OLD.status='paid' AND NEW.status='processing') THEN
  IF NEW.status='paid' AND (OLD.gateway_transfer_code IS NULL OR btrim(OLD.gateway_transfer_code)='') THEN RAISE EXCEPTION 'merchant_accounting_provider_reference_required'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status IN('pending','held') AND NEW.status='rejected' THEN RETURN NEW; END IF;
 IF NEW.status=OLD.status AND NEW.status NOT IN('approved','processing','paid') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'merchant_accounting_held';
END $$;
CREATE TRIGGER guard_accounting_held_payout BEFORE INSERT OR UPDATE OR DELETE ON public.business_payouts FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_accounting_held_payout();

-- Forward fee writers must provide authoritative identity; legacy enrolled rows remain
-- immutable in attribution/custody but may retain existing amounts until reconciliation.
CREATE FUNCTION accounting_private.guard_accounting_fee_provenance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE pay record;
BEGIN
 PERFORM accounting_private.accounting_business_lock(COALESCE(NEW.business_id,OLD.business_id));
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'accounting_fee_removal_requires_reconciliation'; END IF;
 IF TG_OP='UPDATE' AND (NEW.business_id,NEW.payment_id,NEW.booking_id,NEW.invoice_id,NEW.order_id,NEW.is_direct_transfer)
 IS NOT DISTINCT FROM (OLD.business_id,OLD.payment_id,OLD.booking_id,OLD.invoice_id,OLD.order_id,OLD.is_direct_transfer) THEN RETURN NEW; END IF;
 -- Existing direct-fee billing uses invoice_id for platform_fee_invoices, not payment attribution.
 IF TG_OP='UPDATE' AND OLD.is_direct_transfer=true AND NEW.is_direct_transfer=true
 AND NEW.invoiced_at IS NOT NULL AND NEW.invoice_id IS NOT NULL
 AND (to_jsonb(NEW)-ARRAY['invoice_id','invoiced_at'])=(to_jsonb(OLD)-ARRAY['invoice_id','invoiced_at'])
 AND EXISTS(SELECT 1 FROM public.platform_fee_invoices WHERE id=NEW.invoice_id AND business_id=NEW.business_id) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'accounting_fee_identity_requires_reconciliation'; END IF;
 IF NEW.payment_id IS NULL OR NEW.is_direct_transfer IS NULL THEN RAISE EXCEPTION 'accounting_fee_provenance_required'; END IF;
 SELECT * INTO pay FROM public.payments WHERE id=NEW.payment_id;
 IF NOT FOUND OR pay.business_id IS DISTINCT FROM NEW.business_id OR pay.currency IS NULL OR pay.currency !~ '^[A-Z]{3}$'
 OR (NEW.booking_id IS NOT NULL AND NEW.booking_id IS DISTINCT FROM pay.booking_id)
 OR (NEW.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM pay.invoice_id)
 OR (NEW.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM pay.order_id) THEN RAISE EXCEPTION 'accounting_fee_provenance_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_accounting_fee_provenance BEFORE INSERT OR UPDATE OR DELETE ON public.platform_fees FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_accounting_fee_provenance();

CREATE OR REPLACE FUNCTION accounting_private.finalize_refund_accounting_modern(p_refund_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_refund RECORD; v_payment RECORD;
  v_new_refund_amount NUMERIC; v_is_fully_refunded BOOLEAN;
  v_fee_entity_col TEXT; v_fee_entity_val UUID;
  v_fee RECORD; v_fee_reduction NUMERIC;
  v_paid_payout RECORD;
  v_payment_currency VARCHAR(3);
  v_legacy_fee_id UUID;
  v_legacy_fee_count INTEGER;
  v_entity_payment_count INTEGER;
  v_fee_allocated_at DATE;
  v_linked_only BOOLEAN := false;
  v_linked_count integer;
BEGIN
  SELECT r.* INTO v_refund FROM public.refunds r WHERE r.id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('finalized', false, 'reason', 'refund_not_found'); END IF;
  IF v_refund.status = 'success' THEN RETURN jsonb_build_object('finalized', true, 'reason', 'already_finalized'); END IF;
  IF v_refund.status != 'provider_success_unfinalized' THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'invalid_state', 'current_status', v_refund.status);
  END IF;

  SELECT p.* INTO v_payment FROM public.payments p WHERE p.id = v_refund.payment_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('finalized', false, 'reason', 'payment_not_found'); END IF;

  IF v_payment.business_id IS DISTINCT FROM v_refund.business_id THEN
    RAISE EXCEPTION 'refund_business_mismatch' USING ERRCODE='P0001';
  END IF;
  v_payment_currency := v_payment.currency;
  IF v_payment_currency IS NULL OR v_payment_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'refund_currency_unclassified' USING ERRCODE='P0001';
  END IF;
  -- Advisory lock: serializes against confirm_manual_settlement for this business.
  PERFORM pg_advisory_xact_lock(hashtext('payout_settle:' || v_refund.business_id::text));

  v_new_refund_amount := COALESCE(v_payment.refund_amount, 0) + v_refund.amount;
  v_is_fully_refunded := v_new_refund_amount >= v_payment.amount;

  UPDATE public.payments
  SET refund_amount = v_new_refund_amount, refund_reason = v_refund.reason,
      refunded_at = now(), refunded_by = v_refund.initiated_by,
      status = CASE WHEN v_is_fully_refunded THEN 'refunded'::public.payment_status ELSE status END
  WHERE id = v_refund.payment_id;

  IF v_is_fully_refunded AND v_payment.booking_id IS NOT NULL THEN
    UPDATE public.bookings SET deposit_status = 'refunded' WHERE id = v_payment.booking_id;
  END IF;
  IF v_is_fully_refunded AND v_payment.reservation_id IS NOT NULL THEN
    UPDATE public.reservations SET deposit_status = 'refunded' WHERE id = v_payment.reservation_id;
  END IF;

  -- Scope fee reversal to the original payment. Legacy fees with a NULL
  -- payment_id may be used only when there is exactly one fee and one payment
  -- for the same business and whitelisted entity. Do not backfill payment_id.
  IF v_payment.booking_id IS NOT NULL THEN
    v_fee_entity_col := 'booking_id'; v_fee_entity_val := v_payment.booking_id;
  ELSIF v_payment.invoice_id IS NOT NULL THEN
    v_fee_entity_col := 'invoice_id'; v_fee_entity_val := v_payment.invoice_id;
  ELSIF v_payment.order_id IS NOT NULL THEN
    v_fee_entity_col := 'order_id'; v_fee_entity_val := v_payment.order_id;
  END IF;

  IF EXISTS(SELECT 1 FROM public.merchant_accounting_holds WHERE business_id=v_refund.business_id AND active)
  AND EXISTS(SELECT 1 FROM public.platform_fees WHERE payment_id=v_payment.id AND is_direct_transfer=false) THEN
    SELECT count(*) INTO v_linked_count FROM public.platform_fees WHERE payment_id=v_payment.id;
    IF v_linked_count<>1 OR EXISTS(SELECT 1 FROM public.platform_fees WHERE payment_id=v_payment.id
      AND (business_id IS DISTINCT FROM v_refund.business_id OR is_direct_transfer IS DISTINCT FROM false)) THEN
      RAISE EXCEPTION 'refund_strict_linked_proof_required';
    END IF;
    IF v_fee_entity_col IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.platform_fees WHERE %I=$1 AND (business_id IS DISTINCT FROM $2 OR is_direct_transfer IS DISTINCT FROM false)',v_fee_entity_col)
      INTO v_linked_count USING v_fee_entity_val,v_refund.business_id;
      IF v_linked_count<>0 THEN RAISE EXCEPTION 'refund_strict_linked_proof_required'; END IF;
    END IF;
    v_linked_only:=true;
  END IF;
  IF v_fee_entity_col IS NOT NULL AND NOT v_linked_only THEN
    EXECUTE format('SELECT COUNT(*) FROM public.payments WHERE business_id=$1 AND %I=$2',v_fee_entity_col)
      INTO v_entity_payment_count USING v_refund.business_id,v_fee_entity_val;
    EXECUTE format('SELECT COUNT(*),MIN(id::text)::uuid FROM public.platform_fees WHERE business_id=$1 AND %I=$2 AND payment_id IS NULL',v_fee_entity_col)
      INTO v_legacy_fee_count,v_legacy_fee_id USING v_refund.business_id,v_fee_entity_val;
    IF v_legacy_fee_count > 0 AND
       (v_legacy_fee_count <> 1 OR v_entity_payment_count <> 1) THEN
      RAISE EXCEPTION 'refund_fee_payment_provenance_required' USING ERRCODE='P0001';
    END IF;
  END IF;

  IF v_is_fully_refunded THEN
    UPDATE public.platform_fees SET fee_total=0,refunded_at=now()
    WHERE business_id=v_refund.business_id
      AND (payment_id=v_payment.id OR id=v_legacy_fee_id)
      AND refunded_at IS NULL;
  ELSE
    FOR v_fee IN SELECT id,fee_total,fee_percentage,fee_flat,transaction_amount
      FROM public.platform_fees
      WHERE business_id=v_refund.business_id
        AND (payment_id=v_payment.id OR id=v_legacy_fee_id)
        AND refunded_at IS NULL
    LOOP
      IF v_fee.transaction_amount > 0 THEN
        v_fee_reduction := ROUND(
          (v_fee.fee_percentage / 100.0 * v_refund.amount)
          + (v_fee.fee_flat::NUMERIC * v_refund.amount / v_fee.transaction_amount)
        );
        UPDATE public.platform_fees
        SET fee_total=GREATEST(0,fee_total-v_fee_reduction)
        WHERE id=v_fee.id;
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM public.platform_fees f WHERE
    (f.payment_id=v_payment.id OR f.id=v_legacy_fee_id)
    AND f.business_id=v_refund.business_id AND f.is_direct_transfer=false) THEN
    -- Use the fee's created_at (allocation time) for payout-period matching,
    -- not payments.created_at. Payout generators filter by platform_fees.created_at,
    -- so that timestamp determines which period the fee was allocated to.
    SELECT f.created_at::date INTO v_fee_allocated_at FROM public.platform_fees f
    WHERE (f.payment_id=v_payment.id OR f.id=v_legacy_fee_id)
      AND f.business_id=v_refund.business_id AND f.is_direct_transfer=false
    ORDER BY f.created_at LIMIT 1;
    IF v_fee_allocated_at IS NULL THEN v_fee_allocated_at := v_payment.created_at::date; END IF;
    IF EXISTS (SELECT 1 FROM public.business_payouts bp WHERE bp.business_id=v_refund.business_id
      AND bp.status='paid' AND (bp.currency IS NULL OR bp.currency !~ '^[A-Z]{3}$')
      AND bp.period_start <= v_fee_allocated_at AND bp.period_end >= v_fee_allocated_at) THEN
      RAISE EXCEPTION 'refund_payout_currency_reconciliation_required' USING ERRCODE='P0001';
    END IF;
    -- Overlapping same-currency paid periods are ambiguous without an explicit
    -- payment-to-payout ledger link. Never choose an arbitrary candidate.
    IF (SELECT COUNT(*) FROM public.business_payouts bp
        WHERE bp.business_id=v_refund.business_id AND bp.status='paid'
          AND bp.currency=v_payment_currency
          AND bp.period_start <= v_fee_allocated_at
          AND bp.period_end >= v_fee_allocated_at) > 1 THEN
      RAISE EXCEPTION 'refund_payout_allocation_ambiguous' USING ERRCODE='P0001';
    END IF;
    SELECT bp.id INTO v_paid_payout FROM public.business_payouts bp
    WHERE bp.business_id=v_refund.business_id AND bp.status='paid'
      AND bp.currency=v_payment_currency
      AND bp.period_start <= v_fee_allocated_at AND bp.period_end >= v_fee_allocated_at
    ORDER BY bp.period_end DESC,bp.id LIMIT 1;
    IF FOUND THEN
      INSERT INTO public.payout_adjustments(business_id,payout_id,amount,reason,payment_id,currency)
      VALUES(v_refund.business_id,v_paid_payout.id,-v_refund.amount,
       'Refund for payment ' || v_payment.gateway_reference,v_refund.payment_id,v_payment_currency);
    END IF;
  END IF;
  UPDATE public.refunds SET status = 'success', finalized_at = now() WHERE id = p_refund_id;
  RETURN jsonb_build_object('finalized', true, 'fully_refunded', v_is_fully_refunded);
END;
$$;


REVOKE ALL ON FUNCTION accounting_private.finalize_refund_accounting_modern(uuid) FROM PUBLIC,anon,authenticated,service_role;

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

-- Functions are trigger-only/private implementation details, never direct caller bypasses.
REVOKE ALL ON FUNCTION accounting_private.guard_enrolled_payment_identity(),accounting_private.guard_accounting_held_payout(),accounting_private.guard_accounting_fee_provenance() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION accounting_private.guard_accounting_adjustment_provenance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE pay record;
BEGIN
 PERFORM accounting_private.accounting_business_lock(COALESCE(NEW.business_id,OLD.business_id));
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'accounting_adjustment_removal_requires_reconciliation'; END IF;
 IF NEW.applied_to_payout_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.business_payouts WHERE id=NEW.applied_to_payout_id AND business_id=NEW.business_id AND currency=NEW.currency) THEN RAISE EXCEPTION 'accounting_adjustment_target_mismatch'; END IF;
 IF TG_OP='INSERT' AND NEW.payout_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.business_payouts WHERE id=NEW.payout_id AND business_id=NEW.business_id AND currency=NEW.currency) THEN RAISE EXCEPTION 'accounting_adjustment_source_mismatch'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.business_id,NEW.payment_id,NEW.currency,NEW.amount,NEW.payout_id) IS DISTINCT FROM (OLD.business_id,OLD.payment_id,OLD.currency,OLD.amount,OLD.payout_id) THEN RAISE EXCEPTION 'accounting_adjustment_identity_requires_reconciliation'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.currency IS NULL OR NEW.currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'accounting_adjustment_currency_required'; END IF;
 IF NEW.payment_id IS NOT NULL THEN
  SELECT * INTO pay FROM public.payments WHERE id=NEW.payment_id;
  IF NOT FOUND OR pay.business_id IS DISTINCT FROM NEW.business_id OR pay.currency IS DISTINCT FROM NEW.currency THEN RAISE EXCEPTION 'accounting_adjustment_payment_mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_accounting_adjustment_provenance BEFORE INSERT OR UPDATE OR DELETE ON public.payout_adjustments FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_accounting_adjustment_provenance();
REVOKE ALL ON FUNCTION accounting_private.guard_accounting_adjustment_provenance() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
