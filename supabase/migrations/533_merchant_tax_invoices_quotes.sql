-- #980: atomic invoice and negotiated quote terms. DRAFT, not applied.
BEGIN;
ALTER TABLE public.invoices ALTER COLUMN tax_rate TYPE numeric(9,4);
ALTER TABLE public.invoices ADD COLUMN tax_terms_locked_at timestamptz;
ALTER TABLE public.invoice_items ADD COLUMN tax_treatment text NOT NULL DEFAULT 'inherit'
 CHECK (tax_treatment IN ('inherit','override','exempt')),
 ADD COLUMN tax_label text, ADD COLUMN tax_rate_bps numeric(7,2), ADD COLUMN tax_price_mode text;
ALTER TABLE public.invoice_items ADD CONSTRAINT invoice_item_tax_rule CHECK (
 (tax_treatment<>'override' AND tax_label IS NULL AND tax_rate_bps IS NULL AND tax_price_mode IS NULL) OR
 (tax_treatment='override' AND tax_label IS NOT NULL AND tax_rate_bps IS NOT NULL AND tax_price_mode IS NOT NULL AND length(trim(tax_label)) BETWEEN 1 AND 60 AND tax_rate_bps BETWEEN 0 AND 10000 AND tax_price_mode IN ('inclusive','exclusive')));
ALTER TABLE public.quote_requests ADD COLUMN quoted_items jsonb;

CREATE FUNCTION public.respond_order_quote_tax_980(p_business_id uuid,p_quote_id uuid,p_items jsonb,
 p_legacy_amount numeric,p_notes text DEFAULT NULL,p_preview boolean DEFAULT false,p_expected_snapshot jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q public.quote_requests%ROWTYPE; ctx jsonb; cfg jsonb; item jsonb; rule jsonb; product jsonb;
 lines jsonb:='[]'; saved_items jsonb:='[]'; snap jsonb; amount numeric; currency text; ids text[]:='{}'; parent jsonb; source_item jsonb; source_addon jsonb; source_index integer; addon_index integer; expected_ids text[]:='{}';
BEGIN
 SELECT * INTO q FROM public.quote_requests WHERE id=p_quote_id AND business_id=p_business_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'quote_not_found'; END IF;
 IF q.status::text<>'pending' THEN RAISE EXCEPTION 'quote_not_pending'; END IF;
 ctx:=private.merchant_tax_context_980(p_business_id);
 SELECT c.currency_code INTO currency FROM public.businesses b JOIN public.countries c ON c.code=b.country_code WHERE b.id=p_business_id;
 IF p_items IS NULL OR p_items='[]'::jsonb THEN
   IF (ctx->>'enabled')::boolean THEN RAISE EXCEPTION 'itemized_tax_quote_required'; END IF;
   PERFORM private.tax_minor_980(p_legacy_amount); amount:=p_legacy_amount;
 ELSE
   IF jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_quote_items'; END IF;
   cfg:=COALESCE(ctx->'config','{"enabled":false,"label":"Tax","rateBps":0,"priceMode":"exclusive"}'::jsonb);
   -- Existing catalog identities and quantities remain the agreed order. Only
   -- negotiated prices and display descriptions are editable in this flow.
   FOR source_item,source_index IN SELECT value,(ordinality-1)::integer FROM jsonb_array_elements(COALESCE(q.cart_snapshot,'[]')) WITH ORDINALITY LOOP
     SELECT value INTO item FROM jsonb_array_elements(p_items) WHERE value->>'id'='item-'||source_index;
     IF item IS NULL OR item->>'product_id' IS DISTINCT FROM source_item->>'product_id'
       OR (item->>'quantity')::numeric IS DISTINCT FROM (source_item->>'quantity')::numeric
       OR item ? 'parent_id' OR item ? 'kind' THEN RAISE EXCEPTION 'quote_catalog_item_mismatch'; END IF;
     expected_ids:=array_append(expected_ids,'item-'||source_index);
     FOR source_addon,addon_index IN SELECT value,(ordinality-1)::integer FROM jsonb_array_elements(COALESCE(source_item->'addons','[]')) WITH ORDINALITY LOOP
       SELECT value INTO item FROM jsonb_array_elements(p_items) WHERE value->>'id'='item-'||source_index||'-addon-'||addon_index;
       IF item IS NULL OR item->>'parent_id' IS DISTINCT FROM 'item-'||source_index
         OR (item->>'quantity')::numeric IS DISTINCT FROM COALESCE((source_addon->>'quantity')::numeric,1)
         OR item ? 'product_id' OR item ? 'service_id' OR item ? 'kind' THEN RAISE EXCEPTION 'quote_addon_mismatch'; END IF;
       expected_ids:=array_append(expected_ids,'item-'||source_index||'-addon-'||addon_index);
     END LOOP;
   END LOOP;

   FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
     IF COALESCE(item->>'id','')='' OR item->>'id'=ANY(ids) THEN RAISE EXCEPTION 'invalid_quote_item_id'; END IF;
     ids:=array_append(ids,item->>'id');
     IF cardinality(expected_ids)>0 AND NOT item->>'id'=ANY(expected_ids) AND item->>'kind' IS DISTINCT FROM 'delivery' THEN RAISE EXCEPTION 'unexpected_quote_item'; END IF;
     IF cardinality(expected_ids)=0 AND item ? 'product_id' THEN RAISE EXCEPTION 'quote_catalog_identity_required'; END IF;
     rule:='{"treatment":"inherit"}'::jsonb;
     IF item->>'kind'='delivery' THEN
       rule:=COALESCE(ctx->'delivery','{"treatment":"exempt"}'::jsonb);
     ELSIF item->>'parent_id' IS NOT NULL THEN
       SELECT value INTO parent FROM jsonb_array_elements(lines) WHERE value->>'id'=item->>'parent_id';
       IF parent IS NULL THEN RAISE EXCEPTION 'quote_addon_parent_required'; END IF;
       rule:=parent->'tax';
     ELSIF item->>'product_id' IS NOT NULL THEN
       SELECT to_jsonb(p) INTO product FROM public.products p WHERE p.id=(item->>'product_id')::uuid AND p.business_id=p_business_id FOR SHARE;
       IF product IS NULL THEN RAISE EXCEPTION 'quote_product_unavailable'; END IF;
       rule:=private.tax_override_980(product);
     ELSIF item->>'service_id' IS NOT NULL THEN
       SELECT to_jsonb(s) INTO product FROM public.services s WHERE s.id=(item->>'service_id')::uuid AND s.business_id=p_business_id FOR SHARE;
       IF product IS NULL THEN RAISE EXCEPTION 'quote_service_unavailable'; END IF;
       rule:=private.tax_override_980(product);
     END IF;
     -- These are explicitly negotiated prices, never inferred from an overall total.
     lines:=lines||jsonb_build_array(jsonb_build_object('id',item->'id','description',item->'description',
       'quantity',item->'quantity','unitAmount',private.tax_minor_980((item->>'unit_price')::numeric),'tax',rule));
     saved_items:=saved_items||jsonb_build_array(item-'tax_snapshot'-'tax');
   END LOOP;
   snap:=public.calculate_merchant_tax_quote_980(cfg,currency,lines,0);
   amount:=(snap->>'grossAmount')::numeric/100;
   -- Disabled-tax legacy currencies still use validated negotiated arithmetic,
   -- but must not persist a snapshot unsupported by tax receipts/payment authority.
   IF currency NOT IN ('NGN','USD','GBP','CAD') THEN snap:=NULL; END IF;
 END IF;
 IF amount<=0 THEN RAISE EXCEPTION 'positive_quote_amount_required'; END IF;
 IF p_preview THEN RETURN jsonb_build_object('quoted_amount',amount,'tax_snapshot',snap,'quoted_items',saved_items); END IF;
 IF snap IS DISTINCT FROM p_expected_snapshot THEN RAISE EXCEPTION 'quote_tax_terms_changed'; END IF;
 UPDATE public.quote_requests SET status='quoted',quoted_amount=amount,quoted_items=CASE WHEN saved_items='[]'::jsonb THEN NULL ELSE saved_items END,
 tax_snapshot=snap,quote_notes=NULLIF(trim(p_notes),''),quoted_at=now(),expires_at=now()+interval '24 hours'
 WHERE id=q.id RETURNING * INTO q;
 RETURN to_jsonb(q);
END $$;
REVOKE ALL ON FUNCTION public.respond_order_quote_tax_980(uuid,uuid,jsonb,numeric,text,boolean,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.respond_order_quote_tax_980(uuid,uuid,jsonb,numeric,text,boolean,jsonb) TO service_role;

CREATE FUNCTION public.guard_quoted_items_980() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF (TG_OP='INSERT' AND NEW.quoted_items IS NOT NULL) OR (TG_OP='UPDATE' AND NEW.quoted_items IS DISTINCT FROM OLD.quoted_items) THEN
   IF current_user NOT IN ('postgres','service_role') THEN RAISE EXCEPTION 'quote_terms_authority_required'; END IF;
   IF TG_OP='UPDATE' AND OLD.status::text NOT IN ('pending','quoted') THEN RAISE EXCEPTION 'quote_terms_immutable'; END IF;
 END IF;
 IF NEW.tax_snapshot IS NOT NULL AND (NEW.quoted_items IS NULL OR jsonb_typeof(NEW.quoted_items)<>'array' OR jsonb_array_length(NEW.quoted_items)=0) THEN
   RAISE EXCEPTION 'itemized_tax_quote_required';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_quoted_items_980() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_quoted_items_980() TO service_role;
CREATE TRIGGER quoted_items_guard BEFORE INSERT OR UPDATE ON public.quote_requests FOR EACH ROW EXECUTE FUNCTION public.guard_quoted_items_980();
CREATE FUNCTION public.save_invoice_tax_980(p_business_id uuid,p_invoice_id uuid,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions AS $$
DECLARE inv public.invoices%ROWTYPE; ctx jsonb; cfg jsonb; fields jsonb:='{}'; k text;
 item jsonb; rows jsonb:='[]'; lines jsonb:='[]'; snap jsonb; rule jsonb;
 qty numeric; unit numeric; extended numeric; subtotal numeric:=0; discount bigint:=0; idx integer:=0; rate numeric; legacy_currency boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=p_business_id AND owner_id=auth.uid()) THEN RAISE EXCEPTION 'invoice_forbidden' USING ERRCODE='42501'; END IF;
 ctx:=private.merchant_tax_context_980(p_business_id);
 IF p_invoice_id IS NOT NULL THEN
   SELECT * INTO inv FROM public.invoices WHERE id=p_invoice_id AND business_id=p_business_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
   IF inv.status<>'draft' OR inv.amount_paid<>0 OR inv.tax_terms_locked_at IS NOT NULL THEN RAISE EXCEPTION 'only_unpaid_draft_editable'; END IF;
 ELSE
   SELECT c.currency_code INTO inv.currency FROM public.businesses b JOIN public.countries c ON c.code=b.country_code WHERE b.id=p_business_id;
   inv.id:=gen_random_uuid(); inv.business_id:=p_business_id; inv.status:='draft'; inv.amount_paid:=0;
   inv.issue_date:=current_date; inv.is_recurring:=false; inv.metadata:='{}';
 END IF;
 FOREACH k IN ARRAY ARRAY['customer_name','customer_phone','customer_email','customer_address','customer_profile_id','currency','issue_date','due_date','notes','terms','discount_type','discount_value','is_recurring','recurring_frequency','recurring_next_date','recurring_end_date'] LOOP
   IF p_body ? k THEN fields:=fields||jsonb_build_object(k,p_body->k); END IF;
 END LOOP;
 inv:=jsonb_populate_record(inv,fields);
 IF COALESCE(trim(inv.customer_name),'')='' THEN RAISE EXCEPTION 'customer_name_required'; END IF;
 IF inv.customer_profile_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customer_profiles WHERE id=inv.customer_profile_id AND business_id=p_business_id) THEN RAISE EXCEPTION 'customer_profile_forbidden'; END IF;

 IF jsonb_typeof(p_body->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_body->'items') NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invoice_items_required'; END IF;
 cfg:=COALESCE(ctx->'config','{"enabled":false,"label":"Tax","rateBps":0,"priceMode":"exclusive"}'::jsonb);
 legacy_currency:=inv.currency NOT IN ('NGN','USD','GBP','CAD');
 IF legacy_currency AND (inv.tax_snapshot IS NOT NULL OR p_body ? 'tax_config'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_body->'items') x WHERE COALESCE(x->>'tax_treatment','inherit')<>'inherit')) THEN
   RAISE EXCEPTION 'unsupported_tax_currency';
 END IF;

 IF p_body ? 'tax_rate' AND ((p_body->>'tax_rate')::numeric<0 OR (p_body->>'tax_rate')::numeric>100) THEN RAISE EXCEPTION 'invalid_invoice_tax_rate'; END IF;
 IF p_body ? 'tax_config' AND p_body ? 'tax_rate' THEN RAISE EXCEPTION 'ambiguous_invoice_tax_rule'; END IF;
 IF p_body ? 'tax_config' THEN
   cfg:=p_body->'tax_config';
   IF jsonb_typeof(cfg->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'invalid_invoice_tax_config'; END IF;
   PERFORM public.validate_merchant_tax_rule_980(cfg);
 ELSIF COALESCE((p_body->>'tax_rate')::numeric,0)>0 THEN
   rate:=(p_body->>'tax_rate')::numeric*100;
   cfg:=jsonb_build_object('enabled',true,'label','Tax','rateBps',rate,'priceMode','exclusive');
 ELSIF NOT legacy_currency AND (ctx->>'enabled')::boolean AND p_body->>'tax_version' IS DISTINCT FROM '1' THEN
   RAISE EXCEPTION 'invoice_tax_client_refresh_required';
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_body->'items') LOOP
   qty:=(item->>'quantity')::numeric; unit:=(item->>'unit_price')::numeric;
   IF qty IS NULL OR qty<=0 OR qty>1000000 THEN RAISE EXCEPTION 'invalid_invoice_quantity'; END IF;
   PERFORM private.tax_minor_980(unit);
   extended:=round(qty*unit,2); subtotal:=subtotal+CASE WHEN legacy_currency THEN qty*unit ELSE extended END;
   rule:=private.tax_override_980(item);
   -- Fractional services are a single charged line, not a pretend count of hours.
   -- Original quantity/unit price remain in invoice_items; explicit monetary refunds
   -- are required for part of such a charged line.
   lines:=lines||jsonb_build_array(jsonb_build_object('id','invoice-'||idx,
     'description',CASE WHEN qty<>trunc(qty) THEN (item->>'description')||' ('||qty||' × '||unit||' '||inv.currency||')' ELSE item->>'description' END,
     'quantity',CASE WHEN qty<>trunc(qty) THEN 1 ELSE qty END,
     'unitAmount',private.tax_minor_980(CASE WHEN qty<>trunc(qty) THEN extended ELSE unit END),'tax',rule));
   rows:=rows||jsonb_build_array(item||jsonb_build_object('amount',extended,'sort_order',idx)); idx:=idx+1;
 END LOOP;
 inv.discount_value:=COALESCE(inv.discount_value,0);
 IF inv.discount_value<0 OR (inv.discount_type='percent' AND inv.discount_value>100) THEN RAISE EXCEPTION 'invalid_invoice_discount'; END IF;
 IF inv.discount_type='percent' THEN discount:=private.tax_minor_980(round(subtotal*inv.discount_value/100,2));
 ELSIF inv.discount_type='flat' THEN discount:=private.tax_minor_980(inv.discount_value);
 ELSIF inv.discount_type IS NOT NULL OR inv.discount_value<>0 THEN RAISE EXCEPTION 'invalid_invoice_discount'; END IF;
 IF legacy_currency THEN
   -- Retain the pre-rollout single-rate invoice contract outside the new feature:
   -- exclusive tax on the original subtotal, then the existing invoice discount.
   inv.tax_rate:=COALESCE((p_body->>'tax_rate')::numeric,inv.tax_rate,0);
   inv.subtotal:=round(subtotal,2); inv.discount_amount:=discount::numeric/100;
   inv.tax_amount:=round(subtotal*inv.tax_rate/100,2);
   inv.total_amount:=round(subtotal+inv.tax_amount-inv.discount_amount,2);
   IF inv.total_amount<0 THEN RAISE EXCEPTION 'invalid_invoice_discount'; END IF;
   inv.tax_snapshot:=NULL; inv.metadata:=COALESCE(inv.metadata,'{}')-ARRAY['tax_version','tax_config'];
 ELSE
 snap:=public.calculate_merchant_tax_quote_980(cfg,inv.currency,lines,discount);
 inv.subtotal:=subtotal; inv.discount_amount:=discount::numeric/100; inv.tax_amount:=(snap->>'taxAmount')::numeric/100;
 inv.tax_rate:=CASE WHEN (cfg->>'enabled')::boolean THEN (cfg->>'rateBps')::numeric/100 ELSE 0 END;
 inv.total_amount:=(snap->>'grossAmount')::numeric/100; inv.tax_snapshot:=CASE WHEN inv.currency IN ('NGN','USD','GBP','CAD') THEN snap ELSE NULL END;
 inv.metadata:=COALESCE(inv.metadata,'{}')||jsonb_build_object('tax_version',1,'tax_config',cfg);
 END IF;
 IF p_invoice_id IS NULL THEN
   INSERT INTO public.invoices(id,business_id,customer_profile_id,customer_name,customer_phone,customer_email,customer_address,status,
   subtotal,tax_rate,tax_amount,discount_type,discount_value,discount_amount,total_amount,currency,issue_date,due_date,notes,terms,
   is_recurring,recurring_frequency,recurring_next_date,recurring_end_date,tax_snapshot,metadata)
   VALUES(inv.id,inv.business_id,inv.customer_profile_id,inv.customer_name,inv.customer_phone,inv.customer_email,inv.customer_address,'draft',
   inv.subtotal,inv.tax_rate,inv.tax_amount,inv.discount_type,inv.discount_value,inv.discount_amount,inv.total_amount,inv.currency,inv.issue_date,inv.due_date,inv.notes,inv.terms,
   inv.is_recurring,inv.recurring_frequency,inv.recurring_next_date,inv.recurring_end_date,inv.tax_snapshot,inv.metadata) RETURNING * INTO inv;
 ELSE
   UPDATE public.invoices SET customer_profile_id=inv.customer_profile_id,customer_name=inv.customer_name,customer_phone=inv.customer_phone,
   customer_email=inv.customer_email,customer_address=inv.customer_address,subtotal=inv.subtotal,tax_rate=inv.tax_rate,tax_amount=inv.tax_amount,
   discount_type=inv.discount_type,discount_value=inv.discount_value,discount_amount=inv.discount_amount,total_amount=inv.total_amount,currency=inv.currency,
   issue_date=inv.issue_date,due_date=inv.due_date,notes=inv.notes,terms=inv.terms,is_recurring=inv.is_recurring,
   recurring_frequency=inv.recurring_frequency,recurring_next_date=inv.recurring_next_date,recurring_end_date=inv.recurring_end_date,
   tax_snapshot=inv.tax_snapshot,metadata=inv.metadata WHERE id=inv.id;
   DELETE FROM public.invoice_items WHERE invoice_id=inv.id;
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(rows) LOOP
   INSERT INTO public.invoice_items(invoice_id,description,quantity,unit_price,amount,sort_order,tax_treatment,tax_label,tax_rate_bps,tax_price_mode)
   VALUES(inv.id,item->>'description',(item->>'quantity')::numeric,(item->>'unit_price')::numeric,(item->>'amount')::numeric,(item->>'sort_order')::integer,
   COALESCE(item->>'tax_treatment','inherit'),CASE WHEN item->>'tax_treatment'='override' THEN item->>'tax_label' END,
   CASE WHEN item->>'tax_treatment'='override' THEN (item->>'tax_rate_bps')::numeric END,CASE WHEN item->>'tax_treatment'='override' THEN item->>'tax_price_mode' END);
 END LOOP;
 RETURN to_jsonb(inv)||jsonb_build_object('invoice_items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY sort_order) FROM public.invoice_items i WHERE invoice_id=inv.id));
END $$;
REVOKE ALL ON FUNCTION public.save_invoice_tax_980(uuid,uuid,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.save_invoice_tax_980(uuid,uuid,jsonb) TO authenticated;

CREATE UNIQUE INDEX invoices_recurring_period_980 ON public.invoices(recurring_parent_id,(metadata->>'recurring_period')) WHERE recurring_parent_id IS NOT NULL AND metadata ? 'recurring_period';
CREATE FUNCTION public.clone_recurring_invoice_tax_980(p_template_id uuid,p_period date,p_issue_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE source public.invoices%ROWTYPE; child public.invoices%ROWTYPE; next_date date;
BEGIN
 SELECT * INTO source FROM public.invoices WHERE id=p_template_id FOR UPDATE;
 IF NOT FOUND OR source.is_recurring IS NOT TRUE OR source.recurring_parent_id IS NOT NULL OR source.status='cancelled' THEN RAISE EXCEPTION 'recurring_template_unavailable'; END IF;
 SELECT * INTO child FROM public.invoices WHERE recurring_parent_id=source.id AND metadata->>'recurring_period'=p_period::text;
 IF FOUND THEN RETURN jsonb_build_object('id',child.id,'reference_code',child.reference_code,'tax_snapshot',child.tax_snapshot,'replayed',true); END IF;
 IF source.recurring_next_date IS DISTINCT FROM p_period OR p_period>p_issue_date OR (source.recurring_end_date IS NOT NULL AND source.recurring_end_date<p_issue_date) THEN RAISE EXCEPTION 'recurring_period_changed'; END IF;
 -- Preserve the cron's existing JavaScript month-overflow scheduling semantics.
 next_date:=CASE source.recurring_frequency WHEN 'weekly' THEN p_period+7 WHEN 'biweekly' THEN p_period+14
 ELSE (date_trunc('month',p_period)+CASE source.recurring_frequency WHEN 'quarterly' THEN interval '3 months'
 WHEN 'yearly' THEN interval '1 year' ELSE interval '1 month' END+(extract(day FROM p_period)::integer-1)*interval '1 day')::date END;
 INSERT INTO public.invoices(business_id,customer_profile_id,customer_name,customer_phone,customer_email,customer_address,status,
 subtotal,tax_rate,tax_amount,discount_type,discount_value,discount_amount,total_amount,currency,issue_date,due_date,notes,terms,
 recurring_parent_id,tax_snapshot,metadata)
 VALUES(source.business_id,source.customer_profile_id,source.customer_name,source.customer_phone,source.customer_email,source.customer_address,'draft',
 source.subtotal,source.tax_rate,source.tax_amount,source.discount_type,source.discount_value,source.discount_amount,source.total_amount,source.currency,
 p_issue_date,p_issue_date+30,source.notes,source.terms,source.id,source.tax_snapshot,
 COALESCE(source.metadata,'{}')||jsonb_build_object('auto_generated',true,'source_invoice',source.id,'recurring_period',p_period)) RETURNING * INTO child;
 INSERT INTO public.invoice_items(invoice_id,description,quantity,unit_price,amount,sort_order,tax_treatment,tax_label,tax_rate_bps,tax_price_mode)
 SELECT child.id,description,quantity,unit_price,amount,sort_order,tax_treatment,tax_label,tax_rate_bps,tax_price_mode FROM public.invoice_items WHERE invoice_id=source.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'recurring_invoice_items_missing'; END IF;
 UPDATE public.invoices SET recurring_next_date=next_date,recurring_count=COALESCE(recurring_count,0)+1 WHERE id=source.id;
 RETURN jsonb_build_object('id',child.id,'reference_code',child.reference_code,'tax_snapshot',child.tax_snapshot,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.clone_recurring_invoice_tax_980(uuid,date,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.clone_recurring_invoice_tax_980(uuid,date,date) TO service_role;


CREATE FUNCTION public.guard_invoice_tax_items_980() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent public.invoices%ROWTYPE; parent_id uuid;
BEGIN
 parent_id:=CASE WHEN TG_OP='DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
 SELECT * INTO parent FROM public.invoices WHERE id=parent_id FOR SHARE;
 IF parent.tax_snapshot IS NOT NULL THEN
   IF current_user NOT IN ('postgres','service_role') THEN RAISE EXCEPTION 'invoice_items_authority_required'; END IF;
   IF parent.status<>'draft' OR parent.tax_terms_locked_at IS NOT NULL THEN RAISE EXCEPTION 'issued_invoice_items_immutable'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
   SELECT * INTO parent FROM public.invoices WHERE id=OLD.invoice_id FOR SHARE;
   IF parent.tax_snapshot IS NOT NULL THEN RAISE EXCEPTION 'invoice_items_parent_immutable'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_invoice_tax_items_980() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_invoice_tax_items_980() TO service_role;
CREATE TRIGGER invoice_tax_items_guard BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_tax_items_980();

CREATE FUNCTION public.guard_issued_tax_invoice_delete_980() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.tax_snapshot IS NOT NULL AND (OLD.status<>'draft' OR OLD.tax_terms_locked_at IS NOT NULL) THEN RAISE EXCEPTION 'issued_tax_invoice_immutable'; END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.guard_issued_tax_invoice_delete_980() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_issued_tax_invoice_delete_980() TO service_role;
CREATE TRIGGER issued_tax_invoice_delete_guard BEFORE DELETE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.guard_issued_tax_invoice_delete_980();

CREATE FUNCTION public.freeze_invoice_tax_terms_980(p_business_id uuid,p_invoice_id uuid,p_expected_snapshot jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE inv public.invoices%ROWTYPE;
BEGIN
 SELECT * INTO inv FROM public.invoices WHERE id=p_invoice_id AND business_id=p_business_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
 IF inv.tax_snapshot IS DISTINCT FROM NULLIF(p_expected_snapshot,'null'::jsonb) THEN RAISE EXCEPTION 'invoice_tax_terms_changed'; END IF;
 IF inv.tax_snapshot IS NOT NULL AND inv.tax_terms_locked_at IS NULL THEN
   UPDATE public.invoices SET tax_terms_locked_at=clock_timestamp() WHERE id=inv.id RETURNING * INTO inv;
 END IF;
 RETURN to_jsonb(inv)||jsonb_build_object('invoice_items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY sort_order) FROM public.invoice_items i WHERE invoice_id=inv.id));
END $$;
REVOKE ALL ON FUNCTION public.freeze_invoice_tax_terms_980(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_invoice_tax_terms_980(uuid,uuid,jsonb) TO service_role;

CREATE FUNCTION public.guard_frozen_invoice_tax_terms_980() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.tax_terms_locked_at IS DISTINCT FROM OLD.tax_terms_locked_at THEN
   IF OLD.tax_terms_locked_at IS NOT NULL OR current_user NOT IN ('postgres','service_role') THEN RAISE EXCEPTION 'invoice_tax_lock_immutable'; END IF;
 END IF;
 IF OLD.tax_terms_locked_at IS NOT NULL AND
  (to_jsonb(NEW)-ARRAY['updated_at','status','amount_paid','paid_at','payment_id','token','token_expires_at','sent_via','sent_at','viewed_at','wa_message_id','wa_delivery_status','manual_payment_method','manual_payment_note','marked_paid_by','legacy_amount_paid_baseline','recurring_next_date','recurring_count'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','status','amount_paid','paid_at','payment_id','token','token_expires_at','sent_via','sent_at','viewed_at','wa_message_id','wa_delivery_status','manual_payment_method','manual_payment_note','marked_paid_by','legacy_amount_paid_baseline','recurring_next_date','recurring_count']) THEN
   RAISE EXCEPTION 'invoice_tax_terms_locked';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_frozen_invoice_tax_terms_980() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_frozen_invoice_tax_terms_980() TO service_role;
CREATE TRIGGER frozen_invoice_tax_terms_guard BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.guard_frozen_invoice_tax_terms_980();

DO $$
BEGIN
 IF has_function_privilege('authenticated','public.freeze_invoice_tax_terms_980(uuid,uuid,jsonb)','EXECUTE')
   OR has_function_privilege('anon','public.freeze_invoice_tax_terms_980(uuid,uuid,jsonb)','EXECUTE')
   OR NOT has_function_privilege('service_role','public.freeze_invoice_tax_terms_980(uuid,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'invoice_freeze_grants'; END IF;
 IF NOT has_function_privilege('authenticated','public.save_invoice_tax_980(uuid,uuid,jsonb)','EXECUTE')
   OR has_function_privilege('anon','public.save_invoice_tax_980(uuid,uuid,jsonb)','EXECUTE')
   OR has_function_privilege('service_role','public.save_invoice_tax_980(uuid,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'invoice_authority_grants'; END IF;
 IF has_function_privilege('authenticated','public.respond_order_quote_tax_980(uuid,uuid,jsonb,numeric,text,boolean,jsonb)','EXECUTE')
   OR has_function_privilege('anon','public.respond_order_quote_tax_980(uuid,uuid,jsonb,numeric,text,boolean,jsonb)','EXECUTE')
   OR NOT has_function_privilege('service_role','public.respond_order_quote_tax_980(uuid,uuid,jsonb,numeric,text,boolean,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'quote_authority_grants'; END IF;
 IF has_function_privilege('authenticated','public.clone_recurring_invoice_tax_980(uuid,date,date)','EXECUTE')
   OR has_function_privilege('anon','public.clone_recurring_invoice_tax_980(uuid,date,date)','EXECUTE')
   OR NOT has_function_privilege('service_role','public.clone_recurring_invoice_tax_980(uuid,date,date)','EXECUTE') THEN RAISE EXCEPTION 'recurring_authority_grants'; END IF;
END $$;

COMMIT;
