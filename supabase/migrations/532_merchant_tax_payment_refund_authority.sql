-- #980: immutable payment/refund tax allocation authority. DRAFT / NOT APPLIED.
-- Money in allocations is integer minor units; existing payment rows use major units.
BEGIN;

-- M501 operational cutover is a prerequisite: changing only the private modern
-- branch has no effect when an older public dispatcher remains installed.
DO $$ BEGIN
  IF to_regprocedure('public.finalize_refund_execution(uuid)') IS NULL OR
    md5(pg_get_functiondef(to_regprocedure('public.finalize_refund_execution(uuid)')))
      IS DISTINCT FROM 'b516f6b27b8a5e42f2e5cfc6a09490e8' THEN
    RAISE EXCEPTION 'M532 requires the approved M501 public refund dispatcher';
  END IF;
END $$;

ALTER TABLE public.payments ADD COLUMN tax_allocation jsonb, ADD COLUMN tax_fee_basis jsonb;
ALTER TABLE public.refunds ADD COLUMN tax_allocation jsonb;

-- Tax refunds can precede the first settlement. Keep genuine refund provenance
-- instead of fabricating a source payout or mutating an earlier adjustment.
ALTER TABLE public.payout_adjustments ADD COLUMN tax_refund_id uuid UNIQUE REFERENCES public.refunds(id);
ALTER TABLE public.payout_adjustments ALTER COLUMN payout_id DROP NOT NULL;
ALTER TABLE public.payout_adjustments ADD CONSTRAINT tax_adjustment_source_980
  CHECK (payout_id IS NOT NULL OR tax_refund_id IS NOT NULL);
ALTER TABLE public.payout_adjustments ADD CONSTRAINT tax_adjustment_unlinked_980
  CHECK (tax_refund_id IS NULL OR applied_to_payout_id IS NULL);
CREATE FUNCTION private.guard_tax_adjustment_980() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.tax_refund_id IS NOT NULL THEN RAISE EXCEPTION 'tax_adjustment_append_only'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (OLD.tax_refund_id IS NOT NULL OR NEW.tax_refund_id IS NOT NULL) AND
    (NEW.tax_refund_id,NEW.business_id,NEW.payment_id,NEW.currency,NEW.amount,NEW.payout_id) IS DISTINCT FROM
    (OLD.tax_refund_id,OLD.business_id,OLD.payment_id,OLD.currency,OLD.amount,OLD.payout_id) THEN
    RAISE EXCEPTION 'tax_adjustment_identity_immutable';
  END IF;
  IF NEW.tax_refund_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.refunds r JOIN public.payments p ON p.id=r.payment_id
    WHERE r.id=NEW.tax_refund_id AND r.payment_id=NEW.payment_id
      AND r.business_id=NEW.business_id AND p.currency=NEW.currency
      AND r.tax_allocation IS NOT NULL AND p.tax_allocation IS NOT NULL
      AND r.status IN ('provider_success_unfinalized','success')
      AND EXISTS(SELECT 1 FROM public.merchant_tax_refund_ledger l WHERE l.refund_id=r.id AND l.payment_id=p.id AND l.business_id=NEW.business_id)
  ) THEN RAISE EXCEPTION 'tax_adjustment_refund_mismatch'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.guard_tax_adjustment_980() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER tax_adjustment_identity_980 BEFORE INSERT OR UPDATE OR DELETE ON public.payout_adjustments
FOR EACH ROW EXECUTE FUNCTION private.guard_tax_adjustment_980();


CREATE TABLE public.merchant_tax_payment_ledger (
  payment_id uuid PRIMARY KEY REFERENCES public.payments(id) DEFERRABLE INITIALLY DEFERRED,
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  entity_kind text NOT NULL CHECK (entity_kind IN ('order','booking','invoice')),
  entity_id uuid NOT NULL,
  allocation jsonb NOT NULL,
  intent_reference text NOT NULL,
  fee_basis jsonb,
  released_at timestamptz,
  release_reason text CHECK (release_reason IN ('not_dispatched','provider_declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((released_at IS NULL) = (release_reason IS NULL))
);
CREATE INDEX merchant_tax_payment_entity ON public.merchant_tax_payment_ledger(business_id,entity_kind,entity_id);
ALTER TABLE public.merchant_tax_payment_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.merchant_tax_payment_ledger FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.merchant_tax_refund_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id uuid UNIQUE REFERENCES public.refunds(id) DEFERRABLE INITIALLY DEFERRED,
  payment_id uuid NOT NULL REFERENCES public.payments(id),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  entity_kind text NOT NULL CHECK (entity_kind IN ('order','booking','invoice')),
  entity_id uuid NOT NULL,
  selection jsonb NOT NULL,
  request_id uuid,
  quantities jsonb NOT NULL DEFAULT '{}',
  allocation jsonb NOT NULL,
  zero_value boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((refund_id IS NULL) = zero_value)
);
CREATE UNIQUE INDEX merchant_tax_refund_request ON public.merchant_tax_refund_ledger(business_id,request_id) WHERE request_id IS NOT NULL;
CREATE INDEX merchant_tax_refund_entity ON public.merchant_tax_refund_ledger(business_id,entity_kind,entity_id);
ALTER TABLE public.merchant_tax_refund_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.merchant_tax_refund_ledger FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.tax_980_source(p jsonb, p_lock boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE kind text; source_id uuid; business uuid; snapshot jsonb; sources integer;
BEGIN
  sources := (NULLIF(p->>'order_id','') IS NOT NULL)::integer
    +(NULLIF(p->>'booking_id','') IS NOT NULL)::integer+(NULLIF(p->>'invoice_id','') IS NOT NULL)::integer;
  IF sources=0 THEN RETURN NULL; END IF;
  IF sources<>1 OR NULLIF(p->>'campaign_id','') IS NOT NULL OR NULLIF(p->>'reservation_id','') IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM public.orders WHERE id=(p->>'order_id')::uuid AND tax_snapshot IS NOT NULL)
      OR EXISTS(SELECT 1 FROM public.bookings WHERE id=(p->>'booking_id')::uuid AND tax_snapshot IS NOT NULL)
      OR EXISTS(SELECT 1 FROM public.invoices WHERE id=(p->>'invoice_id')::uuid AND tax_snapshot IS NOT NULL) THEN
      RAISE EXCEPTION 'tax_source_ambiguous';
    END IF;
    RETURN NULL;
  END IF;
  IF p->>'order_id' IS NOT NULL THEN kind:='order'; source_id:=(p->>'order_id')::uuid;
    IF p_lock THEN SELECT business_id,tax_snapshot INTO business,snapshot FROM public.orders WHERE id=source_id FOR UPDATE;
    ELSE SELECT business_id,tax_snapshot INTO business,snapshot FROM public.orders WHERE id=source_id; END IF;
  ELSIF p->>'booking_id' IS NOT NULL THEN kind:='booking'; source_id:=(p->>'booking_id')::uuid;
    IF p_lock THEN SELECT business_id,tax_snapshot INTO business,snapshot FROM public.bookings WHERE id=source_id FOR UPDATE;
    ELSE SELECT business_id,tax_snapshot INTO business,snapshot FROM public.bookings WHERE id=source_id; END IF;
  ELSE kind:='invoice'; source_id:=(p->>'invoice_id')::uuid;
    IF p_lock THEN SELECT business_id,tax_snapshot INTO business,snapshot FROM public.invoices WHERE id=source_id FOR UPDATE;
    ELSE SELECT business_id,tax_snapshot INTO business,snapshot FROM public.invoices WHERE id=source_id; END IF;
  END IF;
  IF snapshot IS NULL THEN RETURN NULL; END IF;
  IF business IS NULL OR business IS DISTINCT FROM (p->>'business_id')::uuid THEN RAISE EXCEPTION 'tax_source_business_mismatch'; END IF;
  RETURN jsonb_build_object('kind',kind,'id',source_id,'businessId',business,'snapshot',snapshot);
END $$;
REVOKE ALL ON FUNCTION private.tax_980_source(jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Largest remainder allocation against a REMAINING pool, never a difference of
-- independently recomputed cumulative apportionments (which can be non-monotonic).
CREATE FUNCTION private.tax_980_allocate_pool(p_amount numeric,p_pool jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE denominator numeric; result jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount<0 OR p_amount<>trunc(p_amount) OR p_amount>9007199254740991
    OR jsonb_typeof(p_pool)<>'array' OR jsonb_array_length(p_pool)>200 THEN RAISE EXCEPTION 'invalid_tax_allocation_pool'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_pool) x WHERE jsonb_typeof(x->'amount') IS DISTINCT FROM 'number'
    OR (x->>'amount')::numeric<0 OR (x->>'amount')::numeric<>trunc((x->>'amount')::numeric)) THEN RAISE EXCEPTION 'invalid_tax_allocation_pool'; END IF;
  SELECT COALESCE(sum((x->>'amount')::numeric),0) INTO denominator FROM jsonb_array_elements(p_pool) x;
  IF p_amount>denominator THEN RAISE EXCEPTION 'tax_allocation_pool_exceeded'; END IF;
  WITH weights AS (SELECT x->>'id' id,ord,(x->>'amount')::numeric weight FROM jsonb_array_elements(p_pool) WITH ORDINALITY e(x,ord)),
  parts AS (SELECT *,CASE WHEN denominator=0 THEN 0 ELSE floor(p_amount*weight/denominator) END base,
    CASE WHEN denominator=0 THEN 0 ELSE mod(p_amount*weight,denominator) END remainder FROM weights),
  ranked AS (SELECT *,row_number() OVER(ORDER BY remainder DESC,ord) rank,sum(base) OVER() assigned FROM parts)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'amount',base+CASE WHEN rank<=p_amount-assigned THEN 1 ELSE 0 END) ORDER BY ord),'[]')
    INTO result FROM ranked;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION private.tax_980_allocate_pool(numeric,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.reserve_merchant_tax_payment_980(p_payment jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions AS $$
DECLARE p public.payments%ROWTYPE; source jsonb; snapshot jsonb; prior numeric; requested numeric; tax numeric;
  net_pool jsonb:='[]'; tax_pool jsonb:='[]'; net_parts jsonb; tax_parts jsonb; line jsonb; allocated jsonb;
  used_net numeric; used_tax numeric; net_value numeric; tax_value numeric; lines jsonb:='[]'; existing record;
BEGIN
  IF jsonb_typeof(p_payment) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid_tax_payment'; END IF;
  IF jsonb_typeof(p_payment->'amount') IS DISTINCT FROM 'number'
    OR (p_payment->>'amount')::numeric*100<>trunc((p_payment->>'amount')::numeric*100)
    OR (p_payment->>'amount')::numeric*100>9007199254740991 THEN RAISE EXCEPTION 'invalid_tax_payment'; END IF;
  p:=jsonb_populate_record(NULL::public.payments,p_payment);
  IF p.business_id IS NULL OR p.amount IS NULL OR p.amount<=0 OR p.amount*100<>trunc(p.amount*100)
    OR p.currency IS NULL OR p.currency NOT IN ('NGN','USD','GBP','CAD') OR p.gateway IS NULL OR NULLIF(p.gateway_reference,'') IS NULL THEN
    RAISE EXCEPTION 'invalid_tax_payment'; END IF;
  PERFORM accounting_private.accounting_business_lock(p.business_id);
  source:=private.tax_980_source(p_payment,true);
  IF source IS NULL THEN RETURN jsonb_build_object('taxable',false); END IF;
  snapshot:=source->'snapshot';
  IF snapshot->>'currency' IS DISTINCT FROM p.currency THEN RAISE EXCEPTION 'tax_currency_mismatch'; END IF;
  -- Reusing a reservation never grants a second dispatch: callers still require CAS.
  SELECT pay.*,l.intent_reference INTO existing FROM public.merchant_tax_payment_ledger l JOIN public.payments pay ON pay.id=l.payment_id
    WHERE l.business_id=p.business_id AND l.entity_kind=source->>'kind' AND l.entity_id=(source->>'id')::uuid
      AND l.released_at IS NULL AND pay.status NOT IN ('success','refunded') LIMIT 1;
  IF FOUND THEN
    IF existing.intent_reference=p.gateway_reference AND existing.gateway=p.gateway AND existing.amount=p.amount
      AND existing.currency=p.currency THEN RETURN jsonb_build_object('taxable',true,'reused',true,'payment',to_jsonb(existing)); END IF;
    RAISE EXCEPTION 'tax_payment_unresolved';
  END IF;
  SELECT COALESCE(sum((l.allocation->>'grossAmount')::numeric),0) INTO prior
    FROM public.merchant_tax_payment_ledger l JOIN public.payments pay ON pay.id=l.payment_id
    WHERE l.business_id=p.business_id AND l.entity_kind=source->>'kind' AND l.entity_id=(source->>'id')::uuid
      AND l.released_at IS NULL AND pay.status IN ('success','refunded');
  requested:=p.amount*100;
  IF requested+prior>(snapshot->>'grossAmount')::numeric THEN RAISE EXCEPTION 'tax_payment_exceeds_sale'; END IF;
  tax:=round((prior+requested)*(snapshot->>'taxAmount')::numeric/(snapshot->>'grossAmount')::numeric)
    -round(prior*(snapshot->>'taxAmount')::numeric/(snapshot->>'grossAmount')::numeric);
  FOR line IN SELECT x FROM jsonb_array_elements(snapshot->'lines') x LOOP
    SELECT COALESCE(sum((x->>'netAmount')::numeric),0),COALESCE(sum((x->>'taxAmount')::numeric),0) INTO used_net,used_tax
      FROM public.merchant_tax_payment_ledger l JOIN public.payments pay ON pay.id=l.payment_id,
        LATERAL jsonb_array_elements(l.allocation->'lines') x
      WHERE l.business_id=p.business_id AND l.entity_kind=source->>'kind' AND l.entity_id=(source->>'id')::uuid
        AND l.released_at IS NULL AND pay.status IN ('success','refunded') AND x->>'id'=line->>'id';
    net_pool:=net_pool||jsonb_build_array(jsonb_build_object('id',line->>'id','amount',(line->>'netAmount')::numeric-used_net));
    tax_pool:=tax_pool||jsonb_build_array(jsonb_build_object('id',line->>'id','amount',(line->>'taxAmount')::numeric-used_tax));
  END LOOP;
  net_parts:=private.tax_980_allocate_pool(requested-tax,net_pool);
  tax_parts:=private.tax_980_allocate_pool(tax,tax_pool);
  FOR line IN SELECT x FROM jsonb_array_elements(net_parts) x LOOP
    net_value:=(line->>'amount')::numeric;
    SELECT (x->>'amount')::numeric INTO tax_value FROM jsonb_array_elements(tax_parts) x WHERE x->>'id'=line->>'id';
    lines:=lines||jsonb_build_array(jsonb_build_object('id',line->>'id','netAmount',net_value,'taxAmount',tax_value,'grossAmount',net_value+tax_value));
  END LOOP;
  allocated:=jsonb_build_object('version',1,'currency',p.currency,'netAmount',requested-tax,'taxAmount',tax,'grossAmount',requested,'lines',lines);
  p.id:=gen_random_uuid();
  INSERT INTO public.merchant_tax_payment_ledger(payment_id,business_id,entity_kind,entity_id,allocation,intent_reference)
    VALUES(p.id,p.business_id,source->>'kind',(source->>'id')::uuid,allocated,p.gateway_reference);
  INSERT INTO public.payments(id,business_id,user_id,booking_id,order_id,invoice_id,amount,currency,gateway,gateway_reference,status,
    payment_method,card_last_four,card_brand,payment_authority_version,fee_policy_version,config_version_id,transaction_category,
    fee_basis,provider_init_state,metadata,tax_allocation)
  VALUES(p.id,p.business_id,p.user_id,p.booking_id,p.order_id,p.invoice_id,p.amount,p.currency,p.gateway,p.gateway_reference,'pending',
    p.payment_method,p.card_last_four,p.card_brand,1,COALESCE(p.fee_policy_version,0),p.config_version_id,p.transaction_category,
    p.fee_basis,'pre_dispatch',COALESCE(p.metadata,'{}'),allocated)
    RETURNING * INTO p;
  RETURN jsonb_build_object('taxable',true,'reused',false,'payment',to_jsonb(p));
END $$;
REVOKE ALL ON FUNCTION public.reserve_merchant_tax_payment_980(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_merchant_tax_payment_980(jsonb) TO service_role;

CREATE FUNCTION public.bind_merchant_tax_fee_980(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.payments%ROWTYPE; b record; config jsonb; tiers jsonb; tier text; pct numeric; flat numeric;
  effective_flat numeric; fee numeric; net numeric; result jsonb;
BEGIN
  SELECT * INTO p FROM public.payments WHERE id=p_payment_id FOR UPDATE;
  IF NOT FOUND OR p.tax_allocation IS NULL THEN RAISE EXCEPTION 'tax_payment_required'; END IF;
  IF p.tax_fee_basis IS NOT NULL THEN RETURN p.tax_fee_basis; END IF;
  IF p.provider_init_state IS DISTINCT FROM 'pre_dispatch' THEN RAISE EXCEPTION 'tax_fee_binding_too_late'; END IF;
  net:=(p.tax_allocation->>'netAmount')::numeric/100;
  IF p.gateway='direct' AND p.payment_method='bank_transfer' AND p.metadata->>'_direct_transfer'='true' THEN
    -- Standing Owner exception: direct merchant bank transfers have zero Waaiio fee.
    pct:=0; flat:=0; tier:='free';
  ELSIF p.fee_policy_version>=1 THEN
    SELECT config_snapshot INTO config FROM public.platform_config_versions WHERE id=p.config_version_id;
    IF config IS NULL OR p.fee_basis IS NULL OR p.transaction_category IS NULL THEN RAISE EXCEPTION 'tax_fee_policy_missing'; END IF;
    tier:=p.fee_basis->>'tier';
    pct:=COALESCE((p.fee_basis->>'custom_fee_percentage')::numeric,
      (config->'category_fee_rates'->p.transaction_category->>'feePercentage')::numeric,
      (config->'pricing_tiers'->tier->>'feePercentage')::numeric);
    flat:=COALESCE((p.fee_basis->>'custom_fee_flat')::numeric,0);
  ELSE
    SELECT subscription_tier,custom_fee_percentage,custom_fee_flat INTO b FROM public.businesses WHERE id=p.business_id FOR SHARE;
    tier:=COALESCE(b.subscription_tier::text,'free');
    SELECT value::jsonb INTO tiers FROM public.platform_settings WHERE key='pricing_tiers';
    pct:=COALESCE(b.custom_fee_percentage,(tiers->tier->>'feePercentage')::numeric);
    flat:=COALESCE(b.custom_fee_flat,(tiers->tier->>'feeFlat')::numeric);
  END IF;
  IF pct IS NULL OR flat IS NULL OR pct<0 OR flat<0 OR pct::text IN ('NaN','Infinity','-Infinity')
    OR flat::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'invalid_tax_fee_policy'; END IF;
  effective_flat:=CASE WHEN flat>0 AND p.amount>0 AND flat/p.amount>0.10 THEN 0 ELSE flat END;
  IF p.fee_policy_version>=1 THEN fee:=round(round(net*pct*100)/10000+effective_flat,2);
  ELSE fee:=round(net*pct/100)+effective_flat; END IF;
  IF fee*100<>trunc(fee*100) OR effective_flat*100<>trunc(effective_flat*100) THEN RAISE EXCEPTION 'tax_fee_fractional_minor_unit'; END IF;
  result:=jsonb_build_object('version',1,'feePolicyVersion',p.fee_policy_version,'configVersionId',p.config_version_id,
    'legacyPricingHash',CASE WHEN p.fee_policy_version=0 THEN md5(tiers::text) ELSE NULL END,
    'tier',tier,'currency',p.currency,'feePercentage',pct,'feeFlat',effective_flat,'feeTotal',fee,
    'netAmount',(p.tax_allocation->>'netAmount')::numeric,'grossAmount',(p.tax_allocation->>'grossAmount')::numeric,
    'flatMinor',effective_flat*100,'percentageMinor',(fee-effective_flat)*100,'totalMinor',fee*100);
  UPDATE public.merchant_tax_payment_ledger SET fee_basis=result WHERE payment_id=p.id;
  UPDATE public.payments SET tax_fee_basis=result WHERE id=p.id;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.bind_merchant_tax_fee_980(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bind_merchant_tax_fee_980(uuid) TO service_role;

CREATE FUNCTION public.release_merchant_tax_payment_980(p_payment_id uuid,p_reason text,p_evidence jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.payments%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.payments WHERE id=p_payment_id;
  IF NOT FOUND OR p.tax_allocation IS NULL THEN RETURN false; END IF;
  PERFORM accounting_private.accounting_business_lock(p.business_id);
  PERFORM private.tax_980_source(to_jsonb(p),true);
  SELECT * INTO p FROM public.payments WHERE id=p_payment_id FOR UPDATE;
  IF p.status IN ('success','refunded') OR p.finalization_completed_at IS NOT NULL THEN RAISE EXCEPTION 'tax_collected_payment_cannot_release'; END IF;
  IF p_reason='not_dispatched' THEN
    IF p.provider_init_state IS DISTINCT FROM 'pre_dispatch' THEN RAISE EXCEPTION 'tax_payment_dispatch_uncertain'; END IF;
  ELSIF p_reason='provider_declined' THEN
    IF p.status IS DISTINCT FROM 'failed' OR p_evidence->>'gateway' IS DISTINCT FROM p.gateway
      OR p_evidence->>'reference' IS DISTINCT FROM p.gateway_reference
      OR p_evidence->>'status' IS NULL OR p_evidence->>'status' NOT IN ('failed','abandoned','expired') THEN RAISE EXCEPTION 'tax_payment_decline_evidence_required'; END IF;
  ELSE RAISE EXCEPTION 'invalid_tax_release_reason'; END IF;
  UPDATE public.payments SET status='failed' WHERE id=p.id;
  UPDATE public.merchant_tax_payment_ledger SET released_at=now(),release_reason=p_reason WHERE payment_id=p.id AND released_at IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.release_merchant_tax_payment_980(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.release_merchant_tax_payment_980(uuid,text,jsonb) TO service_role;

-- A proven decline and allocation release commit together. An interrupted caller
-- cannot leave a failed row with a hold that ordinary recovery no longer selects.
CREATE FUNCTION public.confirm_merchant_tax_payment_failure_980(p_payment_id uuid,p_gateway text,p_reference text,p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.payments%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.payments WHERE id=p_payment_id;
  IF NOT FOUND OR p.tax_allocation IS NULL THEN RETURN false; END IF;
  PERFORM accounting_private.accounting_business_lock(p.business_id);
  PERFORM private.tax_980_source(to_jsonb(p),true);
  SELECT * INTO p FROM public.payments WHERE id=p_payment_id FOR UPDATE;
  IF p.gateway IS DISTINCT FROM p_gateway OR p.gateway_reference IS DISTINCT FROM p_reference
    OR p_status IS NULL OR p_status NOT IN ('failed','abandoned','expired') THEN RAISE EXCEPTION 'tax_failure_evidence_mismatch'; END IF;
  IF p.status NOT IN ('pending','failed') OR p.finalization_completed_at IS NOT NULL THEN RETURN false; END IF;
  UPDATE public.payments SET status='failed',gateway_status='provider_terminal_'||p_status WHERE id=p.id;
  PERFORM public.release_merchant_tax_payment_980(p.id,'provider_declined',jsonb_build_object('gateway',p_gateway,'reference',p_reference,'status',p_status));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.confirm_merchant_tax_payment_failure_980(uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_merchant_tax_payment_failure_980(uuid,text,text,text) TO service_role;

CREATE FUNCTION private.guard_merchant_tax_payment_980()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE source jsonb; l record;
BEGIN
  IF TG_OP='UPDATE' AND OLD.tax_allocation IS NOT NULL THEN
    IF NEW.tax_allocation IS DISTINCT FROM OLD.tax_allocation OR NEW.business_id IS DISTINCT FROM OLD.business_id
      OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
      OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.gateway IS DISTINCT FROM OLD.gateway
      OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.fee_policy_version IS DISTINCT FROM OLD.fee_policy_version
      OR NEW.config_version_id IS DISTINCT FROM OLD.config_version_id
      OR NEW.fee_basis IS DISTINCT FROM OLD.fee_basis
      OR NEW.transaction_category IS DISTINCT FROM OLD.transaction_category
      OR NEW.metadata->'_direct_transfer' IS DISTINCT FROM OLD.metadata->'_direct_transfer'
      OR NEW.metadata->'payment_origin' IS DISTINCT FROM OLD.metadata->'payment_origin'
      OR NEW.metadata->'provider_connection_id' IS DISTINCT FROM OLD.metadata->'provider_connection_id'
      OR NEW.metadata->'connect_account_id' IS DISTINCT FROM OLD.metadata->'connect_account_id'
      OR NEW.metadata->'byo_business_id' IS DISTINCT FROM OLD.metadata->'byo_business_id' THEN RAISE EXCEPTION 'tax_payment_identity_immutable'; END IF;
    IF OLD.tax_fee_basis IS NOT NULL AND NEW.tax_fee_basis IS DISTINCT FROM OLD.tax_fee_basis THEN RAISE EXCEPTION 'tax_fee_basis_immutable'; END IF;
    IF OLD.tax_fee_basis IS NULL AND NEW.tax_fee_basis IS NOT NULL
      AND NEW.tax_fee_basis IS DISTINCT FROM (SELECT fee_basis FROM public.merchant_tax_payment_ledger WHERE payment_id=NEW.id) THEN RAISE EXCEPTION 'tax_fee_bind_rpc_required'; END IF;
    IF OLD.provider_init_state IS DISTINCT FROM 'pre_dispatch' AND
      (NEW.metadata->'pi_params' IS DISTINCT FROM OLD.metadata->'pi_params'
        OR NEW.metadata->'application_fee_amount' IS DISTINCT FROM OLD.metadata->'application_fee_amount') THEN
      RAISE EXCEPTION 'tax_provider_replay_parameters_immutable';
    END IF;
    IF NEW.provider_init_state IS DISTINCT FROM OLD.provider_init_state AND NEW.provider_init_state='dispatched' THEN
      IF NEW.tax_fee_basis IS NULL THEN RAISE EXCEPTION 'tax_fee_binding_required'; END IF;
      IF NEW.gateway='stripe' AND NEW.payment_method='saved_card' THEN
        IF jsonb_typeof(NEW.metadata->'pi_params') IS DISTINCT FROM 'object'
          OR (NEW.metadata->'pi_params'->>'amount')::numeric IS DISTINCT FROM (NEW.tax_allocation->>'grossAmount')::numeric
          OR NEW.metadata->'pi_params'->>'currency' IS DISTINCT FROM lower(NEW.currency)
          OR COALESCE((NEW.metadata->'pi_params'->>'application_fee_amount')::numeric,0) IS DISTINCT FROM
            (CASE WHEN NEW.metadata->'pi_params'->>'transfer_data[destination]' IS NOT NULL
              THEN (NEW.tax_fee_basis->>'totalMinor')::numeric ELSE 0 END) THEN
          RAISE EXCEPTION 'tax_provider_fee_parameters_mismatch';
        END IF;
      END IF;
    END IF;
    IF NEW.status IN ('success','refunded') AND NEW.tax_fee_basis IS NULL THEN RAISE EXCEPTION 'tax_fee_binding_required'; END IF;
    IF NEW.status IN ('success','refunded') AND EXISTS(SELECT 1 FROM public.merchant_tax_payment_ledger WHERE payment_id=NEW.id AND released_at IS NOT NULL) THEN
      RAISE EXCEPTION 'released_tax_payment_requires_reconciliation'; END IF;
    RETURN NEW;
  END IF;
  source:=private.tax_980_source(to_jsonb(NEW),false);
  IF source IS NULL THEN
    IF NEW.tax_allocation IS NOT NULL OR NEW.tax_fee_basis IS NOT NULL THEN RAISE EXCEPTION 'unexpected_tax_allocation'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO l FROM public.merchant_tax_payment_ledger WHERE payment_id=NEW.id;
  IF NOT FOUND OR l.business_id IS DISTINCT FROM NEW.business_id OR l.entity_kind IS DISTINCT FROM source->>'kind'
    OR l.entity_id IS DISTINCT FROM (source->>'id')::uuid OR l.allocation IS DISTINCT FROM NEW.tax_allocation
    OR (NEW.tax_allocation->>'grossAmount')::numeric IS DISTINCT FROM NEW.amount*100
    OR NEW.tax_allocation->>'currency' IS DISTINCT FROM NEW.currency THEN RAISE EXCEPTION 'tax_payment_reservation_required'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.guard_merchant_tax_payment_980() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_merchant_tax_payment_980 BEFORE INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION private.guard_merchant_tax_payment_980();

CREATE FUNCTION public.reserve_merchant_tax_refund_980(
  p_payment_id uuid,p_business_id uuid,p_amount numeric,p_selection jsonb,p_request_id uuid,
  p_reason text,p_initiated_by uuid,p_initiated_by_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions AS $$
DECLARE p public.payments%ROWTYPE; source jsonb; snapshot jsonb; remaining numeric; selection jsonb;
  original jsonb; paid_line jsonb; chosen jsonb; line_id text; quantity numeric; previous_quantity numeric;
  refund_gross numeric; refund_tax numeric; prior_gross numeric; prior_tax numeric;
  lines jsonb:='[]'; quantities jsonb:='{}'; allocation jsonb; total_gross numeric:=0; total_tax numeric:=0;
  existing record; refund_id uuid; ledger_id uuid; mode text; direct_split boolean; original_payment public.payments%ROWTYPE;
BEGIN
  IF p_business_id IS NULL OR p_initiated_by IS NULL OR p_initiated_by_role IS NULL OR p_initiated_by_role NOT IN ('business','admin')
    OR p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount<0 OR p_amount*100>9007199254740991 OR p_amount*100<>trunc(p_amount*100) THEN RAISE EXCEPTION 'invalid_tax_refund'; END IF;
  PERFORM accounting_private.accounting_business_lock(p_business_id);
  SELECT * INTO original_payment FROM public.payments WHERE id=p_payment_id;
  IF NOT FOUND OR original_payment.business_id IS DISTINCT FROM p_business_id THEN RAISE EXCEPTION 'tax_refund_business_mismatch'; END IF;
  source:=private.tax_980_source(to_jsonb(original_payment),true);
  SELECT * INTO p FROM public.payments WHERE id=p_payment_id FOR UPDATE;
  IF source IS NULL OR p.tax_allocation IS NULL THEN RETURN jsonb_build_object('taxable',false); END IF;
  IF p.status NOT IN ('success','refunded') THEN RAISE EXCEPTION 'tax_payment_not_refundable'; END IF;
  snapshot:=source->'snapshot';
  selection:=COALESCE(p_selection,jsonb_build_object('mode','full'));
  mode:=selection->>'mode';
  IF jsonb_typeof(selection)<>'object' OR mode IS NULL OR mode NOT IN ('full','items','lines') THEN RAISE EXCEPTION 'invalid_tax_refund_selection'; END IF;
  IF mode='full' THEN selection:=jsonb_build_object('mode','full');
  ELSE
    IF p_request_id IS NULL THEN RAISE EXCEPTION 'tax_refund_request_id_required'; END IF;
    IF jsonb_typeof(selection->mode)<>'array' OR jsonb_array_length(selection->mode) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_tax_refund_selection'; END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(selection->mode)) <>
      (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(selection->mode) x) THEN RAISE EXCEPTION 'duplicate_tax_refund_line'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(selection->mode) x WHERE NOT EXISTS
      (SELECT 1 FROM jsonb_array_elements(snapshot->'lines') l WHERE l->>'id'=x->>'id')) THEN RAISE EXCEPTION 'unknown_tax_refund_line'; END IF;
    SELECT jsonb_build_object('mode',mode,mode,jsonb_agg(x ORDER BY x->>'id')) INTO selection FROM jsonb_array_elements(selection->mode) x;
  END IF;
  IF p_request_id IS NOT NULL THEN
    SELECT l.*,r.status refund_status INTO existing FROM public.merchant_tax_refund_ledger l LEFT JOIN public.refunds r ON r.id=l.refund_id
      WHERE l.business_id=p_business_id AND l.request_id=p_request_id;
    IF FOUND THEN
      IF existing.payment_id IS DISTINCT FROM p_payment_id OR existing.selection IS DISTINCT FROM selection
        OR (existing.allocation->>'grossAmount')::numeric IS DISTINCT FROM p_amount*100 THEN RAISE EXCEPTION 'tax_refund_request_mismatch'; END IF;
      RETURN jsonb_build_object('taxable',true,'reused',true,'refund_id',existing.refund_id,'return_id',existing.id,'zero_value',existing.zero_value,'status',COALESCE(existing.refund_status,'success'));
    END IF;
  END IF;
  SELECT r.id,r.amount,l.selection INTO existing FROM public.refunds r JOIN public.merchant_tax_refund_ledger l ON l.refund_id=r.id
    WHERE r.payment_id=p_payment_id AND r.status NOT IN ('failed','success') LIMIT 1;
  IF FOUND THEN
    IF existing.amount=p_amount AND existing.selection=selection THEN
      RETURN jsonb_build_object('taxable',true,'reused',true,'refund_id',existing.id,'zero_value',false);
    END IF;
    RAISE EXCEPTION 'tax_refund_unresolved';
  END IF;
  FOR paid_line IN SELECT x FROM jsonb_array_elements(p.tax_allocation->'lines') x LOOP
    line_id:=paid_line->>'id';
    SELECT COALESCE(sum((x->>'grossAmount')::numeric),0),COALESCE(sum((x->>'taxAmount')::numeric),0) INTO prior_gross,prior_tax
      FROM public.merchant_tax_refund_ledger l LEFT JOIN public.refunds r ON r.id=l.refund_id,
        LATERAL jsonb_array_elements(l.allocation->'lines') x
      WHERE l.payment_id=p.id AND (l.zero_value OR r.status<>'failed') AND x->>'id'=line_id;
    remaining:=(paid_line->>'grossAmount')::numeric-prior_gross;
    IF mode='full' THEN refund_gross:=remaining;
    ELSE
      SELECT x INTO chosen FROM jsonb_array_elements(selection->mode) x WHERE x->>'id'=line_id;
      IF chosen IS NULL THEN CONTINUE; END IF;
      IF mode='lines' THEN
        IF jsonb_typeof(chosen->'grossAmount') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'invalid_tax_refund_amount'; END IF;
        refund_gross:=(chosen->>'grossAmount')::numeric;
        IF refund_gross<=0 OR refund_gross<>trunc(refund_gross) THEN RAISE EXCEPTION 'invalid_tax_refund_amount'; END IF;
      ELSE
        IF jsonb_typeof(chosen->'quantity') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'invalid_tax_refund_quantity'; END IF;
        quantity:=(chosen->>'quantity')::numeric;
        IF quantity<=0 OR quantity<>trunc(quantity) THEN RAISE EXCEPTION 'invalid_tax_refund_quantity'; END IF;
        SELECT x INTO original FROM jsonb_array_elements(snapshot->'lines') x WHERE x->>'id'=line_id;
        SELECT COALESCE(sum((l.quantities->>line_id)::numeric),0) INTO previous_quantity
          FROM public.merchant_tax_refund_ledger l LEFT JOIN public.refunds r ON r.id=l.refund_id
          WHERE l.business_id=p_business_id AND l.entity_kind=source->>'kind' AND l.entity_id=(source->>'id')::uuid
            AND (l.zero_value OR r.status<>'failed');
        IF previous_quantity+quantity>(original->>'quantity')::numeric THEN RAISE EXCEPTION 'tax_return_quantity_exceeded'; END IF;
        refund_gross:=round((original->>'grossAmount')::numeric*(previous_quantity+quantity)/(original->>'quantity')::numeric)
          -round((original->>'grossAmount')::numeric*previous_quantity/(original->>'quantity')::numeric);
        quantities:=quantities||jsonb_build_object(line_id,quantity);
      END IF;
    END IF;
    IF refund_gross<0 OR refund_gross>remaining THEN RAISE EXCEPTION 'tax_refund_exceeds_paid_line'; END IF;
    IF (paid_line->>'grossAmount')::numeric=0 THEN refund_tax:=0;
    ELSE refund_tax:=round((prior_gross+refund_gross)*(paid_line->>'taxAmount')::numeric/(paid_line->>'grossAmount')::numeric)-prior_tax; END IF;
    IF refund_tax<0 OR refund_tax>refund_gross OR refund_tax>(paid_line->>'taxAmount')::numeric-prior_tax THEN RAISE EXCEPTION 'tax_refund_allocation_invalid'; END IF;
    lines:=lines||jsonb_build_array(jsonb_build_object('id',line_id,'grossAmount',refund_gross,'taxAmount',refund_tax,'netAmount',refund_gross-refund_tax));
    total_gross:=total_gross+refund_gross; total_tax:=total_tax+refund_tax;
  END LOOP;
  IF total_gross IS DISTINCT FROM p_amount*100 THEN RAISE EXCEPTION 'tax_refund_amount_changed'; END IF;
  IF total_gross=0 AND (mode<>'items' OR quantities='{}') THEN RAISE EXCEPTION 'tax_refund_empty'; END IF;
  allocation:=jsonb_build_object('version',1,'currency',p.currency,'lines',lines,'grossAmount',total_gross,'taxAmount',total_tax,'netAmount',total_gross-total_tax);
  IF total_gross>0 THEN refund_id:=gen_random_uuid(); END IF;
  INSERT INTO public.merchant_tax_refund_ledger(refund_id,payment_id,business_id,entity_kind,entity_id,selection,request_id,quantities,allocation,zero_value)
    VALUES(refund_id,p.id,p_business_id,source->>'kind',(source->>'id')::uuid,selection,p_request_id,quantities,allocation,total_gross=0)
    RETURNING id INTO ledger_id;
  IF total_gross=0 THEN RETURN jsonb_build_object('taxable',true,'zero_value',true,'return_id',ledger_id,'status','success'); END IF;
  SELECT payout_mode='direct_split' INTO direct_split FROM public.businesses WHERE id=p_business_id;
  INSERT INTO public.refunds(id,payment_id,business_id,amount,reason,status,gateway,refund_type,is_direct_split,
    initiated_by,initiated_by_role,connect_account_id,provider_connection_id,tax_allocation)
  VALUES(refund_id,p.id,p_business_id,total_gross/100,p_reason,'pending',p.gateway,CASE WHEN mode='full' THEN 'full' ELSE 'partial' END,
    COALESCE(direct_split,false),p_initiated_by,p_initiated_by_role,p.metadata->>'connect_account_id',p.metadata->>'provider_connection_id',allocation);
  RETURN jsonb_build_object('taxable',true,'zero_value',false,'reused',false,'refund_id',refund_id,'allocation',allocation);
END $$;
REVOKE ALL ON FUNCTION public.reserve_merchant_tax_refund_980(uuid,uuid,numeric,jsonb,uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_merchant_tax_refund_980(uuid,uuid,numeric,jsonb,uuid,text,uuid,text) TO service_role;

CREATE FUNCTION private.guard_merchant_tax_refund_980()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE l record; p record;
BEGIN
  IF TG_OP='UPDATE' AND OLD.tax_allocation IS NOT NULL THEN
    IF NEW.tax_allocation IS DISTINCT FROM OLD.tax_allocation OR NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW.payment_id IS DISTINCT FROM OLD.payment_id OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN RAISE EXCEPTION 'tax_refund_identity_immutable'; END IF;
    RETURN NEW;
  END IF;
  SELECT tax_allocation INTO p FROM public.payments WHERE id=NEW.payment_id;
  IF p.tax_allocation IS NULL THEN
    IF NEW.tax_allocation IS NOT NULL THEN RAISE EXCEPTION 'unexpected_refund_tax_allocation'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO l FROM public.merchant_tax_refund_ledger WHERE refund_id=NEW.id;
  IF NOT FOUND OR l.payment_id IS DISTINCT FROM NEW.payment_id OR l.business_id IS DISTINCT FROM NEW.business_id
    OR l.allocation IS DISTINCT FROM NEW.tax_allocation OR (NEW.tax_allocation->>'grossAmount')::numeric IS DISTINCT FROM NEW.amount*100 THEN
    RAISE EXCEPTION 'tax_refund_reservation_required'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.guard_merchant_tax_refund_980() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_merchant_tax_refund_980 BEFORE INSERT OR UPDATE ON public.refunds
FOR EACH ROW EXECUTE FUNCTION private.guard_merchant_tax_refund_980();

-- Pin the currently deployed M501 modern accounting branch. The public
-- wrapper, legacy hold branch, payout policy, and authorization are unchanged.
DO $$ BEGIN
  IF md5(pg_get_functiondef('accounting_private.finalize_refund_accounting_modern(uuid)'::regprocedure))
    IS DISTINCT FROM 'e9e25739e36e0484ee6d8142118099f9' THEN
    RAISE EXCEPTION 'M532 modern refund authority source drift';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION accounting_private.finalize_refund_accounting_modern(p_refund_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_tax_prior_net numeric; v_tax_prior_gross numeric;
  v_tax_net numeric; v_tax_gross numeric; v_tax_basis jsonb;
  v_tax_percentage numeric; v_tax_flat numeric;
  v_tax_adjustment_target numeric; v_tax_adjustment_prior numeric;
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

  IF v_payment.tax_allocation IS NOT NULL THEN
    IF v_refund.tax_allocation IS NULL OR v_payment.tax_fee_basis IS NULL THEN
      RAISE EXCEPTION 'tax_refund_fee_basis_required';
    END IF;
    v_tax_basis:=v_payment.tax_fee_basis;
    v_tax_net:=(v_tax_basis->>'netAmount')::numeric;
    v_tax_gross:=(v_tax_basis->>'grossAmount')::numeric;
    v_tax_percentage:=(v_tax_basis->>'percentageMinor')::numeric;
    v_tax_flat:=(v_tax_basis->>'flatMinor')::numeric;
    SELECT COALESCE(sum((tax_allocation->>'netAmount')::numeric),0),
      COALESCE(sum((tax_allocation->>'grossAmount')::numeric),0)
      INTO v_tax_prior_net,v_tax_prior_gross FROM public.refunds
      WHERE payment_id=v_payment.id AND status='success';
  END IF;

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
        IF v_payment.tax_allocation IS NOT NULL THEN
          -- Allocate original charged components, not a fresh rate. Percentage
          -- follows refunded net; the existing proportional flat policy follows
          -- gross. Cumulative rounding reconciles exactly on the final refund.
          v_fee_reduction := (
            CASE WHEN v_tax_net=0 THEN 0 ELSE
              round((v_tax_prior_net+(v_refund.tax_allocation->>'netAmount')::numeric)*v_tax_percentage/v_tax_net)
                -round(v_tax_prior_net*v_tax_percentage/v_tax_net) END
            +round((v_tax_prior_gross+(v_refund.tax_allocation->>'grossAmount')::numeric)*v_tax_flat/v_tax_gross)
                -round(v_tax_prior_gross*v_tax_flat/v_tax_gross)
          )/100;
        ELSE
        v_fee_reduction := ROUND(
          (v_fee.fee_percentage / 100.0 * v_refund.amount)
          + (v_fee.fee_flat::NUMERIC * v_refund.amount / v_fee.transaction_amount)
        );
        END IF;
        UPDATE public.platform_fees
        SET fee_total=GREATEST(0,fee_total-v_fee_reduction)
        WHERE id=v_fee.id;
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM public.platform_fees f WHERE
    (f.payment_id=v_payment.id OR f.id=v_legacy_fee_id)
    AND f.business_id=v_refund.business_id AND f.is_direct_transfer=false) THEN
    IF v_payment.tax_allocation IS NOT NULL THEN
      -- Partial refunds retain the fee row, so remove refunded gross once.
      -- Full refunds exclude that row entirely; only the retained gateway cost
      -- remains a liability. Reconcile by append-only delta, including reversals
      -- of earlier partial-refund adjustments when the final refund completes.
      IF v_is_fully_refunded THEN
        SELECT -COALESCE(sum(f.gateway_fee),0) INTO v_tax_adjustment_target
        FROM public.platform_fees f WHERE f.payment_id=v_payment.id
          AND f.business_id=v_refund.business_id AND f.is_direct_transfer=false;
      ELSE v_tax_adjustment_target := -v_new_refund_amount;
      END IF;
      SELECT COALESCE(sum(a.amount),0) INTO v_tax_adjustment_prior
      FROM public.payout_adjustments a WHERE a.payment_id=v_payment.id
        AND a.business_id=v_refund.business_id AND a.currency=v_payment_currency
        AND a.tax_refund_id IS NOT NULL;
      INSERT INTO public.payout_adjustments(business_id,payment_id,amount,reason,currency,tax_refund_id)
      VALUES(v_refund.business_id,v_payment.id,v_tax_adjustment_target-v_tax_adjustment_prior,
        'Tax refund settlement reconciliation',v_payment_currency,v_refund.id);
    ELSE
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
  END IF; -- legacy paid-period adjustment branch
  UPDATE public.refunds SET status = 'success', finalized_at = now() WHERE id = p_refund_id;
  RETURN jsonb_build_object('finalized', true, 'fully_refunded', v_is_fully_refunded);
END;
$function$
;
REVOKE ALL ON FUNCTION accounting_private.finalize_refund_accounting_modern(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.record_direct_tax_payment_980(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE source jsonb; existing record; result jsonb; payment_id uuid;
BEGIN
  IF p->>'gateway' IS DISTINCT FROM 'direct' OR p->>'payment_method' IS DISTINCT FROM 'bank_transfer'
    OR p->'metadata'->>'_direct_transfer' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'direct_tax_payment_required'; END IF;
  PERFORM accounting_private.accounting_business_lock((p->>'business_id')::uuid);
  source:=private.tax_980_source(p,true);
  IF source IS NULL THEN RAISE EXCEPTION 'direct_tax_source_required'; END IF;
  FOR existing IN SELECT pay.id,pay.provider_init_state FROM public.merchant_tax_payment_ledger l
    JOIN public.payments pay ON pay.id=l.payment_id
    WHERE l.business_id=(p->>'business_id')::uuid AND l.entity_kind=source->>'kind' AND l.entity_id=(source->>'id')::uuid
      AND l.released_at IS NULL AND pay.status NOT IN ('success','refunded')
  LOOP
    -- An actually undispatched online intent can be superseded by confirmed bank
    -- evidence. Ambiguous/dispatched intents retain their reservation for review.
    IF existing.provider_init_state IS DISTINCT FROM 'pre_dispatch' THEN RAISE EXCEPTION 'tax_payment_dispatch_uncertain'; END IF;
    PERFORM public.release_merchant_tax_payment_980(existing.id,'not_dispatched');
  END LOOP;
  result:=public.reserve_merchant_tax_payment_980(p);
  payment_id:=(result->'payment'->>'id')::uuid;
  PERFORM public.bind_merchant_tax_fee_980(payment_id);
  UPDATE public.payments SET status='success',gateway_status='merchant_confirmed',gateway_fee=0,
    paid_at=now(),provider_init_state='provider_confirmed',
    finalization_completed_at=CASE WHEN p->>'finalization_completed_at' IS NOT NULL THEN now() ELSE NULL END
    WHERE id=payment_id;
  RETURN payment_id;
END $$;
REVOKE ALL ON FUNCTION private.record_direct_tax_payment_980(jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $$ BEGIN IF md5(pg_get_functiondef('public.confirm_order_transfer_atomic(uuid,uuid,uuid,uuid,boolean)'::regprocedure)) IS DISTINCT FROM '22b77cd966e5e2f6bedec52029ac060d' THEN RAISE EXCEPTION 'M532 bank authority source drift'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.confirm_order_transfer_atomic(p_transfer_id uuid, p_order_id uuid, p_business_id uuid, p_confirmed_by uuid, p_approve_fulfillment boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order RECORD;
  v_transfer RECORD;
  v_marker RECORD;
  v_has_payment BOOLEAN;
  v_new_payment_id UUID;
  v_now TIMESTAMPTZ := NOW();
  v_tax_source jsonb;
BEGIN
  PERFORM accounting_private.accounting_business_lock(p_business_id);
  -- 1. Lock order (consistent: order → transfer → marker)
  SELECT id, status, business_id, total_amount, promo_code_id
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN RETURN '{"confirmed":false,"reason":"order_not_found"}'::jsonb; END IF;
  IF v_order.status = 'confirmed' THEN RETURN '{"confirmed":false,"reason":"already_confirmed"}'::jsonb; END IF;
  IF v_order.status != 'pending' THEN RETURN jsonb_build_object('confirmed', false, 'reason', v_order.status); END IF;
  IF v_order.business_id != p_business_id THEN RETURN '{"confirmed":false,"reason":"business_mismatch"}'::jsonb; END IF;

  -- 2. Lock transfer
  SELECT id, order_id, business_id, expected_amount, currency, reference_code,
         status, expires_at, metadata, customer_phone, customer_name,
         proof_submitted_at, proof_protected
  INTO v_transfer FROM pending_transfers WHERE id = p_transfer_id FOR UPDATE;

  IF NOT FOUND THEN RETURN '{"confirmed":false,"reason":"transfer_not_found"}'::jsonb; END IF;
  IF v_transfer.status = 'confirmed' THEN RETURN '{"confirmed":false,"reason":"transfer_already_confirmed"}'::jsonb; END IF;
  IF v_transfer.status != 'pending' THEN RETURN jsonb_build_object('confirmed', false, 'reason', 'transfer_' || v_transfer.status); END IF;
  IF v_transfer.order_id != p_order_id THEN RETURN '{"confirmed":false,"reason":"transfer_order_mismatch"}'::jsonb; END IF;
  IF v_transfer.business_id != p_business_id THEN RETURN '{"confirmed":false,"reason":"transfer_business_mismatch"}'::jsonb; END IF;

  -- 3. Lock marker
  SELECT id, reservation_class, expires_at, payment_id
  INTO v_marker FROM order_stock_applications WHERE order_id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN RETURN '{"confirmed":false,"reason":"no_stock_marker"}'::jsonb; END IF;
  IF v_marker.reservation_class != 'bank_transfer' THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'marker_class_' || v_marker.reservation_class);
  END IF;

  -- Expiry gate: allow if (a) not expired, OR (b) proof-protected with timely proof
  IF v_transfer.proof_protected
     AND v_transfer.proof_submitted_at IS NOT NULL
     AND v_transfer.proof_submitted_at <= v_transfer.expires_at THEN
    -- Proof was submitted before original deadline (DB timestamps).
    -- Original deadlines are preserved — NOT nullified or extended.
    -- Marker and transfer expires_at remain at their original values.
    -- Merchant can confirm because timely proof was submitted.
    -- Additional validation: marker and transfer deadlines must still match.
    IF v_marker.expires_at IS NULL OR v_transfer.expires_at IS NULL
       OR v_marker.expires_at != v_transfer.expires_at THEN
      RETURN '{"confirmed":false,"reason":"deadline_mismatch"}'::jsonb;
    END IF;
    -- Skip the expires_at <= NOW() check (proof-protected)
  ELSE
    -- Standard M394 expiry checks (unchanged)
    IF v_marker.expires_at IS NULL OR v_transfer.expires_at IS NULL
       OR v_marker.expires_at != v_transfer.expires_at THEN
      RETURN '{"confirmed":false,"reason":"deadline_mismatch"}'::jsonb;
    END IF;
    IF v_marker.expires_at <= v_now THEN
      RETURN '{"confirmed":false,"reason":"reservation_expired"}'::jsonb;
    END IF;
  END IF;

  IF v_marker.payment_id IS NOT NULL THEN
    RETURN '{"confirmed":false,"reason":"marker_has_payment"}'::jsonb;
  END IF;

  -- 4. Payment conflict fence (unchanged from M394)
  PERFORM id FROM payments
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
  FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM payments
    WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
      AND (status = 'success'
        OR (finalization_processing_at IS NOT NULL
            AND finalization_processing_at > v_now - INTERVAL '5 minutes'))
  ) INTO v_has_payment;

  IF v_has_payment THEN
    RETURN '{"confirmed":false,"reason":"online_payment_won"}'::jsonb;
  END IF;

  -- 5. Amount validation (unchanged from M394)
  IF v_transfer.expected_amount != ROUND(v_order.total_amount * 100) THEN
    RETURN '{"confirmed":false,"reason":"amount_mismatch"}'::jsonb;
  END IF;

  -- 6. Fail-closed: reject non-representable fractional amounts
  v_tax_source:=private.tax_980_source(jsonb_build_object('order_id',p_order_id,'business_id',p_business_id),true);
  IF v_tax_source IS NULL AND v_transfer.expected_amount % 100 != 0 THEN
    RETURN '{"confirmed":false,"reason":"fractional_amount_unsupported"}'::jsonb;
  END IF;

  -- ── Winner mutations (atomic, unchanged from M394) ──

  -- 7. Void pending online payments
  UPDATE payments SET status = 'failed', gateway_status = 'bank_transfer_won'
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
    AND status = 'pending';

  -- 8. Insert direct payment (major units, matching M394)
  IF v_tax_source IS NOT NULL THEN
    v_new_payment_id:=private.record_direct_tax_payment_980(jsonb_build_object(
      'business_id',p_business_id,'order_id',p_order_id,'amount',v_order.total_amount,'currency',v_transfer.currency,
      'gateway','direct','payment_method','bank_transfer','gateway_reference','transfer:'||v_transfer.reference_code,
      'metadata',jsonb_build_object('pending_transfer_id',p_transfer_id,'confirmed_by',p_confirmed_by,
        'customer_phone',v_transfer.customer_phone,'customer_name',v_transfer.customer_name,
        'transfer_reference',v_transfer.reference_code,'_direct_transfer',true)));
  ELSE
  INSERT INTO payments (
    business_id, amount, currency, status, payment_method, gateway,
    gateway_reference, gateway_status, order_id, paid_at,
    payment_authority_version, gateway_fee, fee_policy_version,
    metadata
  ) VALUES (
    p_business_id, v_order.total_amount, v_transfer.currency,
    'success', 'bank_transfer', 'direct',
    'transfer:' || v_transfer.reference_code, 'merchant_confirmed',
    p_order_id, v_now, 1, 0, 0,
    jsonb_build_object(
      'pending_transfer_id', p_transfer_id,
      'confirmed_by', p_confirmed_by,
      'customer_phone', v_transfer.customer_phone,
      'customer_name', v_transfer.customer_name,
      'transfer_reference', v_transfer.reference_code,
      '_direct_transfer', true
    )
  ) RETURNING id INTO v_new_payment_id;
  END IF;

  -- 9. Commit marker
  UPDATE order_stock_applications
  SET reservation_class = 'committed', expires_at = NULL, payment_id = v_new_payment_id
  WHERE order_id = p_order_id;

  -- 10. Confirm transfer
  UPDATE pending_transfers SET status = 'confirmed', confirmed_by = p_confirmed_by, confirmed_at = v_now
  WHERE id = p_transfer_id;

  -- 11. Order status: conditional on approval
  IF p_approve_fulfillment THEN
    UPDATE orders SET status = 'confirmed', updated_at = v_now
    WHERE id = p_order_id;
  ELSE
    UPDATE orders SET status = 'paid_pending_approval', updated_at = v_now
    WHERE id = p_order_id;
  END IF;

  -- 12. Finalize promo (payment-time effect regardless of approval)
  IF v_order.promo_code_id IS NOT NULL THEN
    UPDATE promo_reservations SET state = 'finalized'
    WHERE order_id = p_order_id AND state = 'reserved';
    IF FOUND THEN
      UPDATE promo_codes SET current_uses = current_uses + 1
      WHERE id = v_order.promo_code_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'confirmed', true,
    'order_total', v_order.total_amount,
    'payment_id', v_new_payment_id,
    'currency', v_transfer.currency,
    'reference_code', v_transfer.reference_code,
    'approved', p_approve_fulfillment
  );
END; $function$
;

DO $$ BEGIN IF md5(pg_get_functiondef('public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean)'::regprocedure)) IS DISTINCT FROM '50b9bdb5c967c25da3963d6d7cb05b66' THEN RAISE EXCEPTION 'M532 bank authority source drift'; END IF; END $$;
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
  v_tax_source jsonb;
BEGIN
  PERFORM accounting_private.accounting_business_lock(p_business_id);
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
  v_tax_source:=private.tax_980_source(to_jsonb(v_transfer)||jsonb_build_object('business_id',p_business_id),true);
  IF v_tax_source IS NULL AND v_transfer.expected_amount % 100 != 0 THEN
    RETURN '{"confirmed":false,"reason":"fractional_amount_unsupported"}'::jsonb;
  END IF;
  v_payment_amount := v_transfer.expected_amount / 100.0;

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
  IF v_tax_source IS NOT NULL THEN
    v_payment_id:=private.record_direct_tax_payment_980(jsonb_build_object(
      'business_id',p_business_id,'booking_id',v_transfer.booking_id,'invoice_id',v_transfer.invoice_id,
      'amount',v_payment_amount,'currency',COALESCE(v_transfer.currency,'NGN'),
      'gateway','direct','payment_method','bank_transfer','gateway_reference','transfer:'||v_transfer.reference_code,
      'finalization_completed_at',v_now,
      'metadata',jsonb_build_object('pending_transfer_id',p_transfer_id,'confirmed_by',p_confirmed_by,
        'customer_phone',v_transfer.customer_phone,'customer_name',v_transfer.customer_name,'_direct_transfer',true)));
  ELSE
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
  END IF;

  -- 7. Zero-fee platform record (minor units for transaction_amount)
  INSERT INTO platform_fees (
    business_id, payment_id,
    booking_id, invoice_id,
    transaction_amount, fee_percentage, fee_flat, fee_total, gateway_fee,
    tier, is_direct_transfer
  ) VALUES (
    p_business_id, v_payment_id,
    v_transfer.booking_id, v_transfer.invoice_id,
    CASE WHEN v_tax_source IS NOT NULL THEN v_payment_amount ELSE v_transfer.expected_amount END, 0, 0, 0, 0,
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
END; $function$;

REVOKE ALL ON FUNCTION public.confirm_order_transfer_atomic(uuid,uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.confirm_order_transfer_atomic(uuid,uuid,uuid,uuid,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean) TO service_role;

DO $$ DECLARE sig text; BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.reserve_merchant_tax_payment_980(jsonb)',
    'public.bind_merchant_tax_fee_980(uuid)',
    'public.confirm_merchant_tax_payment_failure_980(uuid,text,text,text)',
    'public.release_merchant_tax_payment_980(uuid,text,jsonb)',
    'public.reserve_merchant_tax_refund_980(uuid,uuid,numeric,jsonb,uuid,text,uuid,text)',
    'public.confirm_order_transfer_atomic(uuid,uuid,uuid,uuid,boolean)',
    'public.confirm_nonorder_transfer_atomic(uuid,uuid,uuid,boolean)'
  ] LOOP
    IF NOT has_function_privilege('service_role',sig,'EXECUTE') OR has_function_privilege('anon',sig,'EXECUTE')
      OR has_function_privilege('authenticated',sig,'EXECUTE') THEN RAISE EXCEPTION 'M532 authority ACL mismatch: %',sig; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('merchant_tax_payment_ledger','merchant_tax_refund_ledger') AND c.relrowsecurity)<>2 THEN
    RAISE EXCEPTION 'M532 ledger RLS missing';
  END IF;
  IF has_table_privilege('service_role','public.merchant_tax_payment_ledger','INSERT,UPDATE,DELETE')
    OR has_table_privilege('service_role','public.merchant_tax_refund_ledger','INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'M532 private ledger write privileges';
  END IF;
END $$;
-- Lifetime projection is deliberately limited to merchant/currency pairs with
-- tax-refund reconciliation. Legacy period-based generation is unchanged.
CREATE FUNCTION public.tax_refund_payout_projection_980(p_business_id uuid,p_currency text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected boolean; gross numeric; fees numeric; gateway numeric; adjustments numeric; commitments numeric;
BEGIN
  IF p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'currency_required'; END IF;
  PERFORM accounting_private.accounting_business_lock(p_business_id);
  SELECT EXISTS(SELECT 1 FROM public.payout_adjustments WHERE business_id=p_business_id
    AND currency=p_currency AND tax_refund_id IS NOT NULL) INTO affected;
  IF NOT affected THEN RETURN jsonb_build_object('affected',false); END IF;
  IF EXISTS(SELECT 1 FROM public.business_payouts WHERE business_id=p_business_id AND (currency IS NULL OR currency !~ '^[A-Z]{3}$'))
    OR EXISTS(SELECT 1 FROM public.payout_adjustments WHERE business_id=p_business_id AND (currency IS NULL OR currency !~ '^[A-Z]{3}$'))
    OR EXISTS(SELECT 1 FROM public.platform_fees f LEFT JOIN public.payments p ON p.id=f.payment_id
      WHERE f.business_id=p_business_id AND f.refunded_at IS NULL AND
       (f.is_direct_transfer IS NULL OR (f.is_direct_transfer=false AND
        (p.id IS NULL OR p.currency IS NULL OR p.currency !~ '^[A-Z]{3}$' OR p.business_id IS DISTINCT FROM p_business_id))))
    THEN RAISE EXCEPTION 'tax_payout_history_reconciliation_required'; END IF;
  SELECT COALESCE(sum(f.transaction_amount),0),COALESCE(sum(CASE WHEN NOT f.waived THEN f.fee_total ELSE 0 END),0),COALESCE(sum(f.gateway_fee),0)
  INTO gross,fees,gateway FROM public.platform_fees f JOIN public.payments p ON p.id=f.payment_id
  WHERE f.business_id=p_business_id AND p.business_id=p_business_id AND p.currency=p_currency
    AND f.is_direct_transfer=false AND f.refunded_at IS NULL;
  SELECT COALESCE(sum(amount),0) INTO adjustments FROM public.payout_adjustments
    WHERE business_id=p_business_id AND currency=p_currency;
  SELECT COALESCE(sum(net_amount),0) INTO commitments FROM public.business_payouts
    WHERE business_id=p_business_id AND currency=p_currency
      AND status IN ('paid','pending','held','approved','processing','review_required');
  RETURN jsonb_build_object('affected',true,'gross',gross,'platformFee',fees,'gatewayFee',gateway,
    'adjustments',adjustments,'commitments',commitments,
    'netAvailable',greatest(0,gross-fees-gateway+adjustments-commitments));
END $$;
REVOKE ALL ON FUNCTION public.tax_refund_payout_projection_980(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tax_refund_payout_projection_980(uuid,text) TO service_role;

CREATE FUNCTION public.create_tax_refund_payout_980(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE projection jsonb; result public.business_payouts; biz uuid:=(p->>'business_id')::uuid; v_currency text:=p->>'currency';
BEGIN
  PERFORM accounting_private.accounting_business_lock(biz);
  PERFORM pg_advisory_xact_lock(hashtext('payout_settle:'||biz::text));
  IF NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=biz AND payout_mode='platform_managed' AND status='active')
    THEN RAISE EXCEPTION 'tax_payout_business_ineligible'; END IF;
  IF EXISTS(SELECT 1 FROM public.merchant_accounting_holds WHERE business_id=biz AND active)
    THEN RAISE EXCEPTION 'tax_payout_accounting_hold'; END IF;
  IF p->>'period_start' IS NULL OR p->>'period_end' IS NULL
    OR (p->>'period_start')::date>(p->>'period_end')::date
    OR p->>'covered_from' IS NULL OR p->>'covered_to' IS NULL
    OR (p->>'covered_from')::timestamptz >= (p->>'covered_to')::timestamptz
    THEN RAISE EXCEPTION 'tax_payout_period_required'; END IF;
  projection:=public.tax_refund_payout_projection_980(biz,v_currency);
  IF projection->>'affected' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'tax_payout_pair_required'; END IF;
  IF (projection->>'netAvailable')::numeric<=0 THEN RAISE EXCEPTION 'tax_payout_no_available_balance'; END IF;
  IF p->>'status' NOT IN ('pending','held','approved') OR p->>'status' IS NULL
    OR jsonb_typeof(p->'flags') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'tax_payout_invalid_state'; END IF;
  IF (p->>'net_amount')::numeric IS DISTINCT FROM (projection->>'netAvailable')::numeric
    OR (p->>'gross_amount')::numeric IS DISTINCT FROM (projection->>'gross')::numeric
    OR (p->>'platform_fee')::numeric IS DISTINCT FROM (projection->>'platformFee')::numeric
    OR (p->>'gateway_fee')::numeric IS DISTINCT FROM (projection->>'gatewayFee')::numeric
    THEN RAISE EXCEPTION 'tax_payout_projection_changed'; END IF;
  IF EXISTS(SELECT 1 FROM public.business_payouts WHERE business_id=biz AND business_payouts.currency=v_currency
    AND period_start=(p->>'period_start')::date AND period_end=(p->>'period_end')::date)
    THEN RAISE EXCEPTION 'tax_payout_period_exists'; END IF;
  IF p->>'payout_account_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payout_accounts
    WHERE id=(p->>'payout_account_id')::uuid AND business_id=biz AND is_active)
    THEN RAISE EXCEPTION 'tax_payout_account_mismatch'; END IF;
  INSERT INTO public.business_payouts(business_id,payout_account_id,period_start,period_end,covered_from,covered_to,
    gross_amount,platform_fee,gateway_fee,net_amount,currency,status,flags,auto_generated)
  VALUES(biz,(p->>'payout_account_id')::uuid,(p->>'period_start')::date,(p->>'period_end')::date,
    (p->>'covered_from')::timestamptz,(p->>'covered_to')::timestamptz,
    (projection->>'gross')::numeric,(projection->>'platformFee')::numeric,(projection->>'gatewayFee')::numeric,
    (projection->>'netAvailable')::numeric,v_currency,p->>'status',
    (p->'flags')||jsonb_build_array(jsonb_build_object('type','tax_lifetime_calculation','message','Settlement uses the lifetime balance after tax refunds.','severity','info','calculation_basis',projection)),
    COALESCE((p->>'auto_generated')::boolean,false)) RETURNING * INTO result;
  RETURN to_jsonb(result);
END $$;
REVOKE ALL ON FUNCTION public.create_tax_refund_payout_980(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_tax_refund_payout_980(jsonb) TO service_role;

CREATE FUNCTION public.tax_refund_payout_currencies_980(p_business_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(currency),'[]'::jsonb) FROM (
 SELECT DISTINCT currency FROM public.payout_adjustments WHERE business_id=p_business_id AND tax_refund_id IS NOT NULL
 ) currencies
$$;
REVOKE ALL ON FUNCTION public.tax_refund_payout_currencies_980(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tax_refund_payout_currencies_980(uuid) TO service_role;
DO $$ DECLARE sig text; fn_oid regprocedure; BEGIN
 FOREACH sig IN ARRAY ARRAY['public.tax_refund_payout_projection_980(uuid,text)',
 'public.create_tax_refund_payout_980(jsonb)','public.tax_refund_payout_currencies_980(uuid)'] LOOP
   fn_oid:=sig::regprocedure;
   IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE pg_proc.oid=fn_oid AND prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'])
     OR has_function_privilege('anon',fn_oid,'EXECUTE') OR has_function_privilege('authenticated',fn_oid,'EXECUTE')
     OR NOT has_function_privilege('service_role',fn_oid,'EXECUTE') THEN RAISE EXCEPTION 'M532 tax payout authority ACL drift'; END IF;
 END LOOP;
END $$;
COMMIT;
