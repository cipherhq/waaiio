-- M485: Paystack verified fee observation and immutable finalization snapshot.
-- Existing rows remain unclassified. No historical fees are reinterpreted.
BEGIN;

ALTER TABLE public.payments
  ADD COLUMN gateway_fee_contract_version integer,
  ADD COLUMN verified_gateway_fee integer,
  ADD COLUMN gateway_fee_claim_snapshot integer,
  ADD COLUMN gateway_fee_claim_sealed_at timestamptz;
ALTER TABLE public.payments ALTER COLUMN gateway_fee_contract_version SET DEFAULT 1;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_gateway_fee_contract_version_check CHECK (gateway_fee_contract_version IS NULL OR gateway_fee_contract_version = 1),
  ADD CONSTRAINT payments_verified_gateway_fee_check CHECK (verified_gateway_fee IS NULL OR verified_gateway_fee >= 0),
  ADD CONSTRAINT payments_gateway_fee_snapshot_check CHECK (
    (gateway_fee_claim_sealed_at IS NULL AND gateway_fee_claim_snapshot IS NULL AND verified_gateway_fee IS NULL)
    OR (gateway_fee_claim_sealed_at IS NOT NULL AND gateway_fee_claim_snapshot IS NOT NULL
        AND gateway_fee_claim_snapshot >= 0 AND gateway_fee = gateway_fee_claim_snapshot
        AND (verified_gateway_fee IS NULL OR verified_gateway_fee = gateway_fee_claim_snapshot))
  );

-- Invoker trigger: a service-role direct UPDATE is not provider verification.
-- Only the table owner's SECURITY DEFINER claim functions establish a first seal.
-- Once established even the owner cannot change it via ordinary writes.
CREATE FUNCTION public.guard_payment_gateway_fee_claim()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, extensions AS $$
DECLARE
  v_owner name;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO v_owner FROM pg_class WHERE oid = 'public.payments'::regclass;
  IF TG_OP = 'INSERT' THEN
    IF NEW.verified_gateway_fee IS NOT NULL OR NEW.gateway_fee_claim_snapshot IS NOT NULL
       OR NEW.gateway_fee_claim_sealed_at IS NOT NULL THEN
      RAISE EXCEPTION 'fee claim provenance cannot be inserted' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.gateway_fee_contract_version IS DISTINCT FROM OLD.gateway_fee_contract_version THEN
    RAISE EXCEPTION 'fee contract version is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.gateway_fee_claim_sealed_at IS NOT NULL THEN
    -- Older webhook writers also update unrelated card metadata. Preserve that
    -- metadata while suppressing fee changes; this does not accept an observation.
    NEW.gateway_fee := OLD.gateway_fee;
    NEW.verified_gateway_fee := OLD.verified_gateway_fee;
    NEW.gateway_fee_claim_snapshot := OLD.gateway_fee_claim_snapshot;
    NEW.gateway_fee_claim_sealed_at := OLD.gateway_fee_claim_sealed_at;
    RETURN NEW;
  END IF;
  -- No historical markers/ledger is NOT evidence of freshness.
  IF OLD.gateway_fee_contract_version IS NULL
     OR OLD.finalization_processing_at IS NOT NULL
     OR OLD.finalization_completed_at IS NOT NULL THEN
    NEW.gateway_fee := OLD.gateway_fee;
    NEW.verified_gateway_fee := OLD.verified_gateway_fee;
  END IF;
  IF NEW.verified_gateway_fee IS DISTINCT FROM OLD.verified_gateway_fee
     OR NEW.gateway_fee_claim_snapshot IS DISTINCT FROM OLD.gateway_fee_claim_snapshot
     OR NEW.gateway_fee_claim_sealed_at IS DISTINCT FROM OLD.gateway_fee_claim_sealed_at THEN
    IF current_user <> v_owner THEN
      RAISE EXCEPTION 'fee claim provenance requires claim RPC' USING ERRCODE = '42501';
    END IF;
    IF NEW.gateway_fee_claim_sealed_at IS NULL
       OR NEW.gateway_fee_claim_snapshot IS DISTINCT FROM NEW.gateway_fee
       OR NEW.finalization_claim_token IS NULL
       OR NEW.finalization_processing_at IS NULL THEN
      RAISE EXCEPTION 'fee snapshot requires atomic claim' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_payment_gateway_fee_claim() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER guard_payment_gateway_fee_claim
BEFORE INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.guard_payment_gateway_fee_claim();

-- Compatibility entry point: signature, return keys, lease and token fencing
-- are M314's contract. Complete/release remain unchanged and cannot clear seal.
CREATE OR REPLACE FUNCTION public.claim_payment_finalization(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_token uuid;
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed', false, 'reason', 'not_found'); END IF;
  IF v_payment.status != 'success' THEN RETURN jsonb_build_object('claimed', false, 'reason', 'not_successful'); END IF;
  IF v_payment.finalization_completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'already_completed', true, 'reason', 'already_finalized');
  END IF;
  IF v_payment.finalization_processing_at IS NOT NULL
     AND v_payment.finalization_processing_at > now() - interval '5 minutes' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'processing_in_progress');
  END IF;
  v_token := gen_random_uuid();
  UPDATE public.payments SET finalization_processing_at = now(), finalization_claim_token = v_token,
    gateway_fee_claim_snapshot = COALESCE(gateway_fee_claim_snapshot, gateway_fee),
    gateway_fee_claim_sealed_at = COALESCE(gateway_fee_claim_sealed_at, now())
  WHERE id = p_payment_id RETURNING * INTO v_payment;
  IF v_payment.gateway_fee_claim_snapshot IS DISTINCT FROM v_payment.gateway_fee
     OR v_payment.gateway_fee_claim_sealed_at IS NULL
     OR v_payment.finalization_claim_token IS DISTINCT FROM v_token THEN
    RAISE EXCEPTION 'fee claim postcondition failed';
  END IF;
  RETURN jsonb_build_object(
    'claimed', true, 'claim_token', v_token,
    'payment_id', v_payment.id, 'amount', v_payment.amount,
    'booking_id', v_payment.booking_id, 'invoice_id', v_payment.invoice_id,
    'campaign_id', v_payment.campaign_id, 'reservation_id', v_payment.reservation_id,
    'order_id', v_payment.order_id, 'gateway_fee', v_payment.gateway_fee
  );
END;
$$;

CREATE FUNCTION public.claim_payment_finalization_with_verified_fee(
  p_payment_id uuid, p_provider text, p_reference text, p_amount numeric,
  p_currency text, p_fee_supplied boolean, p_gateway_fee numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_token uuid;
BEGIN
  IF p_fee_supplied IS NULL OR p_provider IS DISTINCT FROM 'paystack'
     OR (NOT p_fee_supplied AND p_gateway_fee IS NOT NULL)
     OR (p_fee_supplied AND (p_gateway_fee IS NULL OR p_gateway_fee::text IN ('NaN','Infinity','-Infinity')
         OR p_gateway_fee < 0 OR p_gateway_fee > 2147483647 OR trunc(p_gateway_fee) <> p_gateway_fee)) THEN
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
    gateway_fee = CASE WHEN p_fee_supplied THEN p_gateway_fee::integer ELSE gateway_fee END,
    verified_gateway_fee = CASE WHEN p_fee_supplied THEN p_gateway_fee::integer ELSE NULL END,
    gateway_fee_claim_snapshot = CASE WHEN p_fee_supplied THEN p_gateway_fee::integer ELSE gateway_fee END,
    gateway_fee_claim_sealed_at = now(),
    finalization_processing_at = now(), finalization_claim_token = v_token
  WHERE id = p_payment_id RETURNING * INTO v_payment;
  IF v_payment.gateway_fee_claim_sealed_at IS NULL
     OR v_payment.gateway_fee_claim_snapshot IS DISTINCT FROM v_payment.gateway_fee
     OR v_payment.verified_gateway_fee IS DISTINCT FROM (CASE WHEN p_fee_supplied THEN p_gateway_fee::integer ELSE NULL END)
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
$$;
REVOKE ALL ON FUNCTION public.claim_payment_finalization(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_payment_finalization_with_verified_fee(uuid,text,text,numeric,text,boolean,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_finalization(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_payment_finalization_with_verified_fee(uuid,text,text,numeric,text,boolean,numeric) TO service_role;

DO $$
DECLARE f oid;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.claim_payment_finalization(uuid)'::regprocedure::oid,
    'public.claim_payment_finalization_with_verified_fee(uuid,text,text,numeric,text,boolean,numeric)'::regprocedure::oid
  ] LOOP
    IF NOT (SELECT prosecdef AND proconfig @> ARRAY['search_path=public, extensions']
            AND proowner = (SELECT relowner FROM pg_class WHERE oid='public.payments'::regclass)
            FROM pg_proc WHERE oid=f)
       OR has_function_privilege('anon',f,'EXECUTE')
       OR has_function_privilege('authenticated',f,'EXECUTE')
       OR NOT has_function_privilege('service_role',f,'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                  WHERE p.oid=f AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
      RAISE EXCEPTION 'M485 claim final-state check failed';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.payments'::regclass
                 AND tgname='guard_payment_gateway_fee_claim' AND tgenabled='O') THEN
    RAISE EXCEPTION 'M485 fee guard missing';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.payments'::regclass
      AND conname IN ('payments_gateway_fee_contract_version_check','payments_verified_gateway_fee_check','payments_gateway_fee_snapshot_check')
      AND convalidated) <> 3 THEN RAISE EXCEPTION 'M485 fee constraints missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid='public.payments'::regclass AND a.attname='gateway_fee_contract_version'
      AND pg_get_expr(d.adbin,d.adrelid)='1') THEN RAISE EXCEPTION 'M485 fee default missing'; END IF;
END $$;
COMMIT;
