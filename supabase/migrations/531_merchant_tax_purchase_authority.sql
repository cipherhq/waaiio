-- #980: atomic purchase tax authority. DRAFT; no deployment/application authorization.
BEGIN;
ALTER TABLE public.orders ADD COLUMN tax_snapshot jsonb;
ALTER TABLE public.bookings ADD COLUMN tax_snapshot jsonb;
ALTER TABLE public.invoices ADD COLUMN tax_snapshot jsonb;
ALTER TABLE public.quote_requests ADD COLUMN tax_snapshot jsonb;

CREATE FUNCTION private.tax_minor_980(p_amount numeric) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF p_amount IS NULL OR p_amount<0 OR p_amount*100<>trunc(p_amount*100) OR p_amount*100>9007199254740991 THEN
    RAISE EXCEPTION 'invalid_tax_money' USING ERRCODE='22023';
  END IF;
  RETURN (p_amount*100)::bigint;
END $$;
REVOKE ALL ON FUNCTION private.tax_minor_980(numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.tax_minor_980(numeric) TO service_role;

CREATE FUNCTION private.tax_override_980(p_item jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p_item->>'tax_treatment'='override' THEN jsonb_build_object('treatment','override','rule',
   jsonb_build_object('label',p_item->>'tax_label','rateBps',(p_item->>'tax_rate_bps')::numeric,'priceMode',p_item->>'tax_price_mode'))
 ELSE jsonb_build_object('treatment',COALESCE(p_item->>'tax_treatment','inherit')) END;
$$;
REVOKE ALL ON FUNCTION private.tax_override_980(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.tax_override_980(jsonb) TO service_role;

CREATE FUNCTION private.merchant_tax_context_980(p_business uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE b record; s record; currency text;
BEGIN
  -- All settings writers take this same stable row exclusively, including first insert.
  SELECT id,country_code INTO b FROM public.businesses WHERE id=p_business FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'business_unavailable'; END IF;
  -- The stable business lock protects this MVCC read. Do not also lock the
  -- settings row: UPDATE acquires that tuple before its BEFORE trigger obtains
  -- the business lock, which would invert the lock order against this reader.
  SELECT * INTO s FROM public.merchant_tax_settings WHERE business_id=p_business;
  IF NOT FOUND OR s.enabled IS NOT TRUE THEN RETURN jsonb_build_object('enabled',false); END IF;
  SELECT currency_code INTO currency FROM public.countries WHERE code=b.country_code;
  IF currency IS NULL OR currency NOT IN ('NGN','USD','GBP','CAD') THEN RAISE EXCEPTION 'unsupported_tax_currency'; END IF;
  RETURN jsonb_build_object('enabled',true,'currency',currency,
    'config',jsonb_build_object('enabled',true,'label',s.label,'rateBps',s.rate_bps,'priceMode',s.price_mode),
    'delivery',CASE WHEN s.delivery_treatment='override' THEN jsonb_build_object('treatment','override',
      'rule',jsonb_build_object('label',s.delivery_label,'rateBps',s.delivery_rate_bps,'priceMode',s.delivery_price_mode))
      ELSE jsonb_build_object('treatment','exempt') END);
END $$;
REVOKE ALL ON FUNCTION private.merchant_tax_context_980(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.lock_merchant_tax_settings_980() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,extensions AS $$
DECLARE country text; currency text;
BEGIN
  IF TG_OP='UPDATE' AND NEW.business_id IS DISTINCT FROM OLD.business_id THEN RAISE EXCEPTION 'tax_business_immutable'; END IF;
  SELECT country_code INTO country FROM public.businesses WHERE id=NEW.business_id FOR UPDATE;
  IF NEW.enabled THEN
    SELECT currency_code INTO currency FROM public.countries WHERE code=country;
    IF currency IS NULL OR currency NOT IN ('NGN','USD','GBP','CAD') THEN RAISE EXCEPTION 'unsupported_tax_currency'; END IF;
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.lock_merchant_tax_settings_980() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lock_merchant_tax_settings_980() TO service_role;
CREATE TRIGGER merchant_tax_settings_serialization BEFORE INSERT OR UPDATE ON public.merchant_tax_settings
FOR EACH ROW EXECUTE FUNCTION public.lock_merchant_tax_settings_980();

CREATE FUNCTION public.validate_merchant_tax_snapshot_980(p_snapshot jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE l jsonb; calculated jsonb; ids text[]:=ARRAY[]::text[];
  total_net numeric:=0; total_tax numeric:=0; total_discount numeric:=0; direct numeric;
BEGIN
  IF p_snapshot->'version' IS DISTINCT FROM '1'::jsonb OR p_snapshot->>'currency' IS NULL
    OR p_snapshot->>'currency' !~ '^[A-Z]{3}$' OR jsonb_typeof(p_snapshot->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_tax_snapshot';
  END IF;
  IF jsonb_array_length(p_snapshot->'lines') NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_tax_snapshot'; END IF;
  FOR l IN SELECT value FROM jsonb_array_elements(p_snapshot->'lines') LOOP
    IF l->>'id'=ANY(ids) THEN RAISE EXCEPTION 'duplicate_tax_snapshot_line'; END IF;
    ids:=array_append(ids,l->>'id');
    IF l->>'treatment' IS NULL OR l->>'treatment' NOT IN ('taxable','zero_rated','exempt','disabled') THEN RAISE EXCEPTION 'invalid_tax_snapshot'; END IF;
    calculated:=public.calculate_merchant_tax_quote_980(
      jsonb_build_object('enabled',l->>'treatment'<>'disabled','label',l->'label','rateBps',l->'rateBps','priceMode',l->'priceMode'),
      p_snapshot->>'currency',jsonb_build_array(jsonb_build_object('id',l->'id','description',l->'description',
        'quantity',l->'quantity','unitAmount',l->'unitAmount','lineDiscountAmount',l->'discountAmount',
        'tax',jsonb_build_object('treatment',CASE WHEN l->>'treatment'='exempt' THEN 'exempt' ELSE 'inherit' END))),0);
    IF (calculated->'lines'->0)-'lineDiscountAmount' IS DISTINCT FROM l-'lineDiscountAmount' THEN RAISE EXCEPTION 'invalid_tax_snapshot_line'; END IF;
    IF l->'lineDiscountAmount' IS NOT NULL AND jsonb_typeof(l->'lineDiscountAmount')<>'number' THEN RAISE EXCEPTION 'invalid_tax_snapshot_discount'; END IF;
    direct:=COALESCE((l->>'lineDiscountAmount')::numeric,0);
    IF direct<0 OR trunc(direct)<>direct OR direct>(l->>'discountAmount')::numeric THEN RAISE EXCEPTION 'invalid_tax_snapshot_discount'; END IF;
    total_net:=total_net+(l->>'netAmount')::numeric;
    total_tax:=total_tax+(l->>'taxAmount')::numeric;
    total_discount:=total_discount+(l->>'discountAmount')::numeric;
  END LOOP;
  IF greatest(total_net+total_tax,total_discount)>9007199254740991
    OR p_snapshot->'netAmount' IS DISTINCT FROM to_jsonb(total_net)
    OR p_snapshot->'taxAmount' IS DISTINCT FROM to_jsonb(total_tax)
    OR p_snapshot->'grossAmount' IS DISTINCT FROM to_jsonb(total_net+total_tax)
    OR p_snapshot->'discountAmount' IS DISTINCT FROM to_jsonb(total_discount)
    OR p_snapshot->'percentageFeeBase' IS DISTINCT FROM to_jsonb(total_net) THEN RAISE EXCEPTION 'invalid_tax_snapshot_totals'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.validate_merchant_tax_snapshot_980(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.validate_merchant_tax_snapshot_980(jsonb) TO service_role;

CREATE FUNCTION public.guard_purchase_tax_snapshot_980() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,extensions AS $$
DECLARE old_row jsonb; new_row jsonb:=to_jsonb(NEW); amount numeric; tax_enabled boolean;
  template jsonb; field text; invoice_terms_changed boolean:=false; invoice_subtotal numeric;
BEGIN
  IF TG_OP='UPDATE' THEN
    old_row:=to_jsonb(OLD);
    IF OLD.tax_snapshot IS NOT NULL AND NEW.business_id IS DISTINCT FROM OLD.business_id THEN RAISE EXCEPTION 'tax_business_immutable'; END IF;
    IF TG_TABLE_NAME='invoices' AND OLD.tax_snapshot IS NOT NULL THEN
      FOREACH field IN ARRAY ARRAY['subtotal','tax_rate','tax_amount','discount_type','discount_value','discount_amount','total_amount','currency'] LOOP
        invoice_terms_changed:=invoice_terms_changed OR new_row->field IS DISTINCT FROM old_row->field;
        IF new_row->field IS DISTINCT FROM old_row->field AND
          (current_user NOT IN ('postgres','service_role') OR OLD.status::text IS DISTINCT FROM 'draft' OR NEW.status::text IS DISTINCT FROM 'draft') THEN
          RAISE EXCEPTION 'invoice_tax_terms_immutable';
        END IF;
      END LOOP;
    END IF;
    IF NOT invoice_terms_changed AND NEW.tax_snapshot IS NOT DISTINCT FROM OLD.tax_snapshot
      AND new_row->'total_amount' IS NOT DISTINCT FROM old_row->'total_amount'
      AND new_row->'quoted_amount' IS NOT DISTINCT FROM old_row->'quoted_amount'
      AND new_row->'currency' IS NOT DISTINCT FROM old_row->'currency' THEN RETURN NEW; END IF;
    IF NEW.tax_snapshot IS DISTINCT FROM OLD.tax_snapshot AND
      (TG_TABLE_NAME IN ('orders','bookings') OR
       (TG_TABLE_NAME='invoices' AND (OLD.status::text IS DISTINCT FROM 'draft' OR NEW.status::text IS DISTINCT FROM 'draft')) OR
       (TG_TABLE_NAME='quote_requests' AND COALESCE(OLD.status::text,'') NOT IN ('pending','quoted'))) THEN
      RAISE EXCEPTION 'tax_snapshot_immutable';
    END IF;
    IF NEW.tax_snapshot IS DISTINCT FROM OLD.tax_snapshot AND current_user NOT IN ('postgres','service_role') THEN
      RAISE EXCEPTION 'tax_snapshot_authority_required';
    END IF;
  END IF;
  IF TG_OP='INSERT' AND NEW.tax_snapshot IS NULL AND TG_TABLE_NAME IN ('orders','invoices','bookings') THEN
    PERFORM id FROM public.businesses WHERE id=NEW.business_id FOR SHARE;
    SELECT enabled INTO tax_enabled FROM public.merchant_tax_settings WHERE business_id=NEW.business_id;
    IF tax_enabled IS TRUE AND TG_TABLE_NAME='bookings' AND new_row->>'flow_type' IS DISTINCT FROM 'scheduling'
      AND new_row->>'flow_type' IS DISTINCT FROM 'giving' AND COALESCE((new_row->>'total_amount')::numeric,0)>0 THEN
      RAISE EXCEPTION 'unsupported_tax_purchase:Use an itemized invoice or supported order for this purchase';
    END IF;
    IF tax_enabled IS TRUE AND (TG_TABLE_NAME IN ('orders','invoices') OR current_user NOT IN ('postgres','service_role')) THEN
      IF TG_TABLE_NAME='invoices' AND new_row->>'recurring_parent_id' IS NOT NULL AND current_user IN ('postgres','service_role') THEN
        SELECT to_jsonb(i) INTO template FROM public.invoices i
          WHERE id=(new_row->>'recurring_parent_id')::uuid AND business_id=NEW.business_id FOR SHARE;
        IF template IS NOT NULL AND (template->'tax_snapshot' IS NULL OR template->'tax_snapshot'='null'::jsonb) THEN
          FOREACH field IN ARRAY ARRAY['subtotal','tax_rate','tax_amount','discount_type','discount_value','discount_amount','total_amount','currency'] LOOP
            IF new_row->field IS DISTINCT FROM template->field THEN RAISE EXCEPTION 'recurring_invoice_terms_changed'; END IF;
          END LOOP;
          RETURN NEW;
        END IF;
      END IF;
      RAISE EXCEPTION 'tax_snapshot_required';
    END IF;
  END IF;
  IF NEW.tax_snapshot IS NULL THEN RETURN NEW; END IF;
  IF current_user NOT IN ('postgres','service_role') THEN RAISE EXCEPTION 'tax_snapshot_authority_required'; END IF;
  PERFORM public.validate_merchant_tax_snapshot_980(NEW.tax_snapshot);
  IF TG_TABLE_NAME='invoices' AND new_row->>'currency' IS DISTINCT FROM NEW.tax_snapshot->>'currency' THEN RAISE EXCEPTION 'tax_snapshot_currency_mismatch'; END IF;
  IF TG_TABLE_NAME='invoices' THEN
    SELECT sum((value->>'quantity')::numeric*(value->>'unitAmount')::numeric) INTO invoice_subtotal FROM jsonb_array_elements(NEW.tax_snapshot->'lines');
    IF (new_row->>'subtotal')::numeric*100 IS DISTINCT FROM invoice_subtotal
      OR (new_row->>'tax_amount')::numeric*100 IS DISTINCT FROM (NEW.tax_snapshot->>'taxAmount')::numeric
      OR COALESCE((new_row->>'discount_amount')::numeric,0)*100 IS DISTINCT FROM (NEW.tax_snapshot->>'discountAmount')::numeric THEN
      RAISE EXCEPTION 'invoice_tax_breakdown_mismatch';
    END IF;
  END IF;
  amount:=CASE WHEN TG_TABLE_NAME='quote_requests' THEN (new_row->>'quoted_amount')::numeric ELSE (new_row->>'total_amount')::numeric END;
  IF amount IS NULL OR amount*100 IS DISTINCT FROM (NEW.tax_snapshot->>'grossAmount')::numeric THEN RAISE EXCEPTION 'tax_snapshot_amount_mismatch'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_purchase_tax_snapshot_980() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_purchase_tax_snapshot_980() TO service_role;
CREATE TRIGGER orders_tax_snapshot_guard BEFORE INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.guard_purchase_tax_snapshot_980();
CREATE TRIGGER bookings_tax_snapshot_guard BEFORE INSERT OR UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.guard_purchase_tax_snapshot_980();
CREATE TRIGGER invoices_tax_snapshot_guard BEFORE INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.guard_purchase_tax_snapshot_980();
CREATE TRIGGER quotes_tax_snapshot_guard BEFORE INSERT OR UPDATE ON public.quote_requests FOR EACH ROW EXECUTE FUNCTION public.guard_purchase_tax_snapshot_980();

-- Authoritative function replacements follow. Tax is computed before persistence.
DROP FUNCTION public.create_order_atomic(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,uuid,text,text,uuid,text,numeric,numeric,text,text,text,text,jsonb,uuid,boolean,numeric);
CREATE OR REPLACE FUNCTION public.create_order_atomic(p_bot_session_id uuid, p_business_id uuid, p_user_id uuid, p_status text DEFAULT 'pending'::text, p_delivery_address text DEFAULT NULL::text, p_delivery_phone text DEFAULT NULL::text, p_total_amount numeric DEFAULT 0, p_discount_amount numeric DEFAULT 0, p_shipping_cost numeric DEFAULT 0, p_promo_code_id uuid DEFAULT NULL::uuid, p_channel text DEFAULT 'whatsapp'::text, p_notes text DEFAULT NULL::text, p_delivery_zone_id uuid DEFAULT NULL::uuid, p_delivery_zone_name text DEFAULT NULL::text, p_addons_total numeric DEFAULT 0, p_volume_discount_amount numeric DEFAULT 0, p_pickup_address text DEFAULT NULL::text, p_dropoff_address text DEFAULT NULL::text, p_package_description text DEFAULT NULL::text, p_package_photo_url text DEFAULT NULL::text, p_items jsonb DEFAULT '[]'::jsonb, p_referral_id uuid DEFAULT NULL::uuid, p_validate_products boolean DEFAULT false, p_expected_total numeric DEFAULT NULL::integer, p_expected_tax_snapshot jsonb DEFAULT NULL, p_preview boolean DEFAULT false)
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
  v_tax_context jsonb; v_tax_snapshot jsonb; v_existing_tax jsonb;
  v_tax_lines jsonb := '[]'; v_tax_addons jsonb; v_tax_line_id text; v_tax_description text; v_tax_delivery numeric:=0;
BEGIN
  p_expected_tax_snapshot:=NULLIF(p_expected_tax_snapshot,'null'::jsonb);
  IF p_preview IS NULL OR (p_preview AND p_validate_products IS NOT TRUE) THEN RAISE EXCEPTION 'validated_preview_required'; END IF;
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
      FOR v_addon_entry IN SELECT * FROM jsonb_array_elements(v_item->'addons') a ORDER BY a->>'id'
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
         delivery_zone_id, shipping_cost, tax_snapshot
  INTO v_existing_id, v_existing_ref, v_existing_fingerprint, v_existing_total,
       v_existing_discount, v_existing_promo_id, v_existing_biz_id, v_existing_user_id,
       v_existing_vol_discount, v_existing_zone_id, v_existing_shipping, v_existing_tax
  FROM orders
  WHERE bot_session_id = p_bot_session_id
    AND status IN ('pending', 'confirmed')
  LIMIT 1;

  IF FOUND THEN
    IF v_existing_biz_id IS DISTINCT FROM p_business_id OR v_existing_user_id IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'replay_identity_mismatch'; END IF;
    IF p_preview THEN RETURN jsonb_build_object('is_preview',true,'created',false,'order_id',v_existing_id,
      'reference_code',v_existing_ref,'server_total',v_existing_total,'server_discount',v_existing_discount,
      'server_volume_discount',v_existing_vol_discount,'tax_snapshot',v_existing_tax); END IF;
    IF v_existing_tax IS DISTINCT FROM p_expected_tax_snapshot THEN RAISE EXCEPTION 'tax_terms_changed'; END IF;
    IF v_existing_tax IS NOT NULL AND p_validate_products IS NOT TRUE THEN RAISE EXCEPTION 'validated_tax_order_required'; END IF;
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
          'server_total', v_existing_total, 'tax_snapshot',v_existing_tax
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

  v_tax_context:=private.merchant_tax_context_980(p_business_id);
  IF (v_tax_context->>'enabled')::boolean AND p_validate_products IS NOT TRUE THEN RAISE EXCEPTION 'validated_tax_order_required'; END IF;
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
      v_tax_addons := '[]';
      v_tax_line_id := 'product:'||(v_item->>'product_id')||':'||COALESCE(NULLIF(v_item->>'variant_id',''),'base');

      SELECT id, name, price, is_active, deleted_at, business_id, track_inventory, stock_quantity, tax_treatment,tax_label,tax_rate_bps,tax_price_mode
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
        SELECT id, label, price, product_id, is_active, stock_quantity
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

      v_tax_description:=v_product.name;
      IF NULLIF(v_item->>'variant_id','') IS NOT NULL THEN v_tax_description:=v_tax_description||' ('||v_variant.label||')'; END IF;
      v_vol_item_quantity := COALESCE((v_item->>'quantity')::int, 1);
      v_vol_item_product_id := (v_item->>'product_id')::uuid;

      -- Addon validation (UNCHANGED from M393)
      IF v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb THEN
        FOR v_addon_entry IN SELECT * FROM jsonb_array_elements(v_item->'addons') a ORDER BY a->>'id'
        LOOP
          IF v_addon_entry->>'id' IS NULL OR v_addon_entry->>'id' = '' THEN
            RAISE EXCEPTION 'addon_missing_id:Addon entry missing id in product %', v_item->>'product_id';
          END IF;

          v_addon_id := (v_addon_entry->>'id')::uuid;

          SELECT id, name, price, price_type, is_active, business_id, product_id
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
          IF (v_tax_context->>'enabled')::boolean THEN
            v_tax_addons:=v_tax_addons||jsonb_build_array(jsonb_build_object('id','addon:'||v_tax_line_id||':'||v_addon.id,
              'description',v_addon.name,'quantity',(v_addon_entry->>'quantity')::integer,
              'unitAmount',private.tax_minor_980(v_addon.price),'tax',private.tax_override_980(to_jsonb(v_product))));
          END IF;
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
      IF (v_tax_context->>'enabled')::boolean THEN
        v_tax_lines:=v_tax_lines||jsonb_build_array(jsonb_build_object('id',v_tax_line_id,'description',v_tax_description,
          'quantity',v_vol_item_quantity,'unitAmount',private.tax_minor_980(v_vol_item_unit_price),
          'lineDiscountAmount',private.tax_minor_980(v_vol_item_discount),'tax',private.tax_override_980(to_jsonb(v_product))))||v_tax_addons;
      END IF;
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
      IF NOT p_preview AND v_server_discount != COALESCE(p_discount_amount, 0) THEN
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
    IF NOT p_preview AND COALESCE(p_addons_total, 0) IS DISTINCT FROM v_server_addons_total THEN
      RAISE EXCEPTION 'addons_total_mismatch:Quoted addons % differ from authoritative addons %', p_addons_total, v_server_addons_total;
    END IF;

    -- M435: Compare server-computed volume discount against caller's quote
    IF NOT p_preview AND v_server_volume_discount != COALESCE(p_volume_discount_amount, 0) THEN
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
      v_tax_delivery:=v_zone.price;
    ELSE
      v_server_total := v_server_total + COALESCE(p_shipping_cost, 0);
      v_tax_delivery:=COALESCE(p_shipping_cost,0);
    END IF;

    -- Zero-floor (UNCHANGED from M393)
    v_server_total := GREATEST(0, v_server_total);

    IF (v_tax_context->>'enabled')::boolean THEN
      IF v_tax_delivery > 0 THEN
        v_tax_lines:=v_tax_lines||jsonb_build_array(jsonb_build_object('id','delivery','description',COALESCE(v_zone_name,'Delivery'),
          'quantity',1,'unitAmount',private.tax_minor_980(v_tax_delivery),
          'discountEligible',false,'tax',v_tax_context->'delivery'));
      END IF;
      v_tax_snapshot:=public.calculate_merchant_tax_quote_980(v_tax_context->'config',v_tax_context->>'currency',v_tax_lines,private.tax_minor_980(v_server_discount));
      v_server_total:=(v_tax_snapshot->>'grossAmount')::numeric/100;
    END IF;
    IF p_preview THEN RETURN jsonb_build_object('is_preview',true,'created',false,'server_total',v_server_total,
      'server_discount',v_server_discount,'server_volume_discount',v_server_volume_discount,
      'server_addons_total',v_server_addons_total,'tax_snapshot',v_tax_snapshot); END IF;
    IF v_tax_snapshot IS DISTINCT FROM p_expected_tax_snapshot THEN RAISE EXCEPTION 'tax_terms_changed'; END IF;
    -- Compare the customer-confirmed gross and the entire immutable tax snapshot.
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
    referral_id, items_fingerprint, tax_snapshot
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
    p_referral_id, v_fingerprint, v_tax_snapshot
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
    'server_volume_discount', CASE WHEN p_validate_products THEN v_server_volume_discount ELSE NULL END,
    'tax_snapshot',v_tax_snapshot
  );
END;
$function$
;
ALTER FUNCTION public.create_order_atomic(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,uuid,text,text,uuid,text,numeric,numeric,text,text,text,text,jsonb,uuid,boolean,numeric,jsonb,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_order_atomic(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,uuid,text,text,uuid,text,numeric,numeric,text,text,text,text,jsonb,uuid,boolean,numeric,jsonb,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_order_atomic(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,uuid,text,text,uuid,text,numeric,numeric,text,text,text,text,jsonb,uuid,boolean,numeric,jsonb,boolean) TO service_role;

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
  v_tax_context jsonb; v_tax_snapshot jsonb; v_tax_lines jsonb:='[]';
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

  v_tax_context:=private.merchant_tax_context_980(p_business_id);
  -- 2. Process each item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) x ORDER BY x->>'product_id'
  LOOP
    -- Validate quantity is a positive integer within bounds
    IF (v_item->>'quantity')::INT IS NULL OR (v_item->>'quantity')::INT < 1 THEN
      RAISE EXCEPTION 'Invalid quantity for product %: must be a positive integer', v_item->>'product_id';
    END IF;
    IF (v_item->>'quantity')::INT > 100 THEN
      RAISE EXCEPTION 'Quantity exceeds maximum (100) for product %', v_item->>'product_id';
    END IF;

    -- Lock the product row for update
    SELECT id, name, price, stock_quantity, track_inventory, is_active, business_id, tax_treatment,tax_label,tax_rate_bps,tax_price_mode
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
    IF (v_tax_context->>'enabled')::boolean THEN
      v_tax_lines:=v_tax_lines||jsonb_build_array(jsonb_build_object('id','product:'||v_product.id||':base',
        'description',v_product.name,'quantity',(v_item->>'quantity')::integer,
        'unitAmount',private.tax_minor_980(v_product.price),'tax',private.tax_override_980(to_jsonb(v_product))));
    END IF;

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

  IF (v_tax_context->>'enabled')::boolean THEN
    v_tax_snapshot:=public.calculate_merchant_tax_quote_980(v_tax_context->'config',v_tax_context->>'currency',v_tax_lines,0);
    v_total_amount:=(v_tax_snapshot->>'grossAmount')::numeric/100;
  END IF;
  -- 3. Create order (reference_code auto-generated by trigger)
  INSERT INTO orders (
    business_id, user_id, status, delivery_phone, total_amount, channel, notes, tax_snapshot
  ) VALUES (
    p_business_id,
    p_user_id,
    CASE WHEN v_total_amount > 0 THEN 'pending'::order_status ELSE 'confirmed'::order_status END,
    p_delivery_phone,
    v_total_amount,
    'whatsapp',
    NULLIF(p_customer_note, ''), v_tax_snapshot
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
    'total_amount', v_total_amount, 'tax_snapshot',v_tax_snapshot,
    'items', v_order_items,
    'out_of_stock', to_jsonb(v_out_of_stock)
  );
END;
$function$
;
ALTER FUNCTION public.create_catalog_order_atomic(uuid,uuid,text,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_catalog_order_atomic(uuid,uuid,text,text,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_catalog_order_atomic(uuid,uuid,text,text,text,jsonb) TO service_role;

DROP FUNCTION private.scheduling_604_quote(uuid,uuid,uuid,integer,jsonb,uuid,jsonb);
CREATE OR REPLACE FUNCTION private.scheduling_604_quote(p_business uuid, p_service uuid, p_appointment uuid, p_party integer, p_addons jsonb, p_promo uuid, p_expected jsonb, p_require_tax_confirmation boolean DEFAULT true)
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
  tax_context jsonb; tax_snapshot jsonb; tax_lines jsonb:='[]'; tax_addons jsonb:='[]';
  base_total numeric; effective_due numeric; tax_skipped boolean;
BEGIN
  IF p_party IS NULL OR p_party < 1 OR p_party > 50 THEN RAISE EXCEPTION 'invalid_party_size'; END IF;
  IF p_service IS NOT NULL AND p_appointment IS NOT NULL THEN RAISE EXCEPTION 'invalid_booking_item'; END IF;
  SELECT * INTO b FROM public.businesses WHERE id=p_business FOR SHARE;
  IF NOT FOUND OR b.status::text <> 'active' THEN RAISE EXCEPTION 'business_unavailable'; END IF;
  tax_context:=private.merchant_tax_context_980(p_business);
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
    IF (tax_context->>'enabled')::boolean THEN
      tax_addons:=tax_addons||jsonb_build_array(jsonb_build_object('id','addon:'||addon.id,'description',addon.name,
        'quantity',1,'unitAmount',private.tax_minor_980(addon.price),'tax',private.tax_override_980(item),'discountEligible',false));
    END IF;
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
  tax_skipped:=COALESCE((p_expected->>'_tax_package_redemption')::boolean,false) OR COALESCE(item->>'service_type','')='giving';
  IF (tax_context->>'enabled')::boolean AND NOT tax_skipped THEN
    effective_due:=CASE WHEN p_expected->>'_tax_mode'='manual' THEN 0 ELSE due END;
    base_total:=total;
    IF variable AND effective_due>base_total THEN base_total:=effective_due; END IF;
    IF NOT variable AND unit_price=0 AND unit_deposit=0 THEN base_total:=effective_due; END IF;
    IF effective_due>base_total THEN RAISE EXCEPTION 'invalid_booking_amount'; END IF;
    tax_lines:=jsonb_build_array(jsonb_build_object('id','service:'||COALESCE(item_id::text,'business'),
      'description',COALESCE(item->>'name','Service'),'quantity',p_party,'unitAmount',private.tax_minor_980(unit_price),
      'lineDiscountAmount',private.tax_minor_980(discount*p_party),'tax',private.tax_override_980(item)))||tax_addons;
    IF base_total>total THEN
      tax_lines:=tax_lines||jsonb_build_array(jsonb_build_object('id','service:consideration-adjustment',
        'description',COALESCE(item->>'name','Service')||' — additional confirmed amount','quantity',1,
        'unitAmount',private.tax_minor_980(base_total-total),'tax',private.tax_override_980(item)));
    ELSIF base_total<total THEN
      -- A zero-priced manual booking has no purchase consideration; no tax on a void amount.
      IF base_total<>0 THEN RAISE EXCEPTION 'invalid_booking_tax_basis'; END IF;
      tax_lines:=jsonb_build_array(jsonb_build_object('id','service:'||COALESCE(item_id::text,'business'),
        'description',COALESCE(item->>'name','Service'),'quantity',p_party,'unitAmount',0,'tax',private.tax_override_980(item)));
    END IF;
    tax_snapshot:=public.calculate_merchant_tax_quote_980(tax_context->'config',tax_context->>'currency',tax_lines,0);
    total:=(tax_snapshot->>'grossAmount')::numeric/100;
    due:=CASE WHEN base_total=0 THEN 0 ELSE div(private.tax_minor_980(effective_due)::numeric*(tax_snapshot->>'grossAmount')::numeric*2
      +private.tax_minor_980(base_total),private.tax_minor_980(base_total)::numeric*2)/100 END;
  END IF;
  IF p_require_tax_confirmation AND tax_snapshot IS DISTINCT FROM NULLIF(p_expected->'tax_snapshot','null'::jsonb) THEN RAISE EXCEPTION 'tax_terms_changed'; END IF;
  -- The final total/due relation is settled in create_booking, after manual and
  -- package bookings set the amount due to zero.
  IF p_expected->>'_tax_mode'='manual' OR COALESCE((p_expected->>'_tax_package_redemption')::boolean,false) THEN due:=0; END IF;
  IF tax_snapshot IS NULL THEN
    IF variable AND due>total THEN total:=due; END IF;
    IF NOT variable AND unit_price=0 AND unit_deposit=0 THEN total:=due; END IF;
  END IF;
  IF due>total OR total>2147483647 OR due>2147483647 THEN RAISE EXCEPTION 'invalid_booking_amount'; END IF;
  RETURN jsonb_build_object('total',total,'deposit',due,'price',unit_price,'variable',variable,
    'zero_item',tax_snapshot IS NULL AND NOT variable AND unit_price=0 AND unit_deposit=0, 'tax_snapshot',tax_snapshot,
    'tax_exempt_reason',CASE WHEN COALESCE((p_expected->>'_tax_package_redemption')::boolean,false) THEN 'package_redemption' WHEN item->>'service_type'='giving' THEN 'giving' ELSE NULL END,
    'item_deposit',unit_deposit,'discount',discount,'country',b.country_code,
    'capacity',CASE WHEN item->'metadata'->>'is_dropoff'='true' THEN 9999 ELSE COALESCE((item->>'max_capacity')::integer,1) END,
    'buffer',COALESCE((item->>'buffer_minutes')::integer,(item->'metadata'->>'buffer_minutes')::integer,0),
    'duration',COALESCE((item->>'duration_minutes')::integer,30),
    'auto_approve',COALESCE((item->>'auto_approve')::boolean,true));
END;
$function$
;
ALTER FUNCTION private.scheduling_604_quote(uuid,uuid,uuid,integer,jsonb,uuid,jsonb,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.scheduling_604_quote(uuid,uuid,uuid,integer,jsonb,uuid,jsonb,boolean) FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric);
CREATE OR REPLACE FUNCTION public.book_slot_atomic(p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid, p_date date, p_time text, p_party_size integer, p_max_capacity integer, p_flow_type text, p_deposit_amount numeric, p_deposit_status text, p_status text, p_guest_name text, p_guest_phone text, p_guest_email text, p_special_requests text, p_venue_address text, p_end_date date, p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount numeric, p_staff_name text, p_location_id uuid DEFAULT NULL::uuid, p_appointment_id uuid DEFAULT NULL::uuid, p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30, p_bot_session_id uuid DEFAULT NULL::uuid, p_class_session_id uuid DEFAULT NULL::uuid, p_expected_price numeric DEFAULT NULL::integer, p_expected_deposit numeric DEFAULT NULL::integer, p_tax_snapshot jsonb DEFAULT NULL, p_tax_exempt_reason text DEFAULT NULL)
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
  v_tax_context jsonb;
BEGIN
  -- ── Bot session idempotency ──
  IF p_bot_session_id IS NOT NULL THEN
    SELECT id, bookings.reference_code INTO v_booking_id, v_ref
    FROM bookings WHERE bot_session_id = p_bot_session_id AND status IN ('pending', 'confirmed') LIMIT 1;
    IF FOUND THEN RETURN QUERY SELECT v_booking_id, v_ref, true; RETURN; END IF;
  END IF;

  IF p_flow_type='scheduling' THEN
    v_tax_context:=private.merchant_tax_context_980(p_business_id);
    IF p_tax_exempt_reason IS NOT NULL AND p_tax_exempt_reason NOT IN ('package_redemption','giving') THEN RAISE EXCEPTION 'invalid_tax_exemption'; END IF;
    IF (v_tax_context->>'enabled')::boolean AND p_tax_snapshot IS NULL AND p_tax_exempt_reason IS NULL THEN RAISE EXCEPTION 'tax_confirmation_required'; END IF;
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
    INSERT INTO bookings (business_id, user_id, service_id, appointment_id, staff_id, staff_name, date, time, party_size, flow_type, channel, deposit_amount, deposit_status, status, guest_name, guest_phone, guest_email, special_requests, venue_address, end_date, addons_snapshot, promo_code_id, total_amount, quantity, location_id, bot_session_id, class_session_id, tax_snapshot)
    VALUES (p_business_id, p_user_id, v_cs.service_id, NULL, v_cs.staff_id, v_canonical_staff_name, v_cs.date, v_cs.start_time, p_party_size, p_flow_type::flow_type, 'whatsapp'::booking_channel, v_committed_deposit, p_deposit_status::deposit_status, p_status::reservation_status, p_guest_name, p_guest_phone, p_guest_email, p_special_requests, p_venue_address, p_end_date, p_addons_snapshot, p_promo_code_id, v_committed_total, p_party_size, v_cs.location_id, p_bot_session_id, p_class_session_id, p_tax_snapshot)
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

  INSERT INTO bookings (business_id, user_id, service_id, appointment_id, staff_id, staff_name, date, time, party_size, flow_type, channel, deposit_amount, deposit_status, status, guest_name, guest_phone, guest_email, special_requests, venue_address, end_date, addons_snapshot, promo_code_id, total_amount, quantity, location_id, bot_session_id, tax_snapshot)
  VALUES (p_business_id, p_user_id, CASE WHEN p_appointment_id IS NOT NULL THEN NULL ELSE p_service_id END, p_appointment_id, p_staff_id, p_staff_name, p_date, p_time::time, p_party_size, p_flow_type::flow_type, 'whatsapp'::booking_channel, v_committed_deposit, p_deposit_status::deposit_status, p_status::reservation_status, p_guest_name, p_guest_phone, p_guest_email, p_special_requests, p_venue_address, p_end_date, p_addons_snapshot, p_promo_code_id, v_committed_total, p_party_size, p_location_id, p_bot_session_id, p_tax_snapshot)
  RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;
  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$function$
;
ALTER FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb,text) TO service_role;

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
        'package_covered',p_enrollment IS NOT NULL,'success',true,'tax_snapshot',existing.tax_snapshot);
    END IF;
    claim := session_row.session_data->'_604_confirmation';
    IF claim IS NULL OR claim->>'service_id' IS DISTINCT FROM COALESCE(b.service_id,b.appointment_id)::text
      OR claim->>'date' IS DISTINCT FROM b.date::text
      OR (claim->>'party_size')::integer IS DISTINCT FROM b.party_size
      OR claim->>'time' IS DISTINCT FROM b.time::text
      OR claim->'terms' IS DISTINCT FROM expected THEN RAISE EXCEPTION 'booking_confirmation_required'; END IF;
  END IF;
  q := private.scheduling_604_quote(b.business_id,b.service_id,b.appointment_id,b.party_size,b.addons_snapshot,b.promo_code_id,expected||jsonb_build_object('bot_claim',claim IS NOT NULL,'_tax_package_redemption',p_enrollment IS NOT NULL,'_tax_mode',p_mode));
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
    (q->>'buffer')::integer,(q->>'duration')::integer,b.bot_session_id,b.class_session_id,NULL,NULL,NULLIF(q->'tax_snapshot','null'::jsonb),q->>'tax_exempt_reason');
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
    'committed_total',total,'committed_deposit',due,'package_covered',p_enrollment IS NOT NULL,'success',true,'tax_snapshot',q->'tax_snapshot');
END;
$function$
;
ALTER FUNCTION private.scheduling_604_create_booking(jsonb,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.scheduling_604_create_booking(jsonb,text,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.scheduling_604_create_booking(jsonb,text,uuid) TO service_role;

DROP FUNCTION public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb);
CREATE OR REPLACE FUNCTION public.book_slot_authoritative_604(p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid, p_date date, p_time text, p_party_size integer, p_max_capacity integer, p_flow_type text, p_deposit_amount numeric, p_deposit_status text, p_status text, p_guest_name text, p_guest_phone text, p_guest_email text, p_special_requests text, p_venue_address text, p_end_date date, p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount numeric, p_staff_name text, p_location_id uuid DEFAULT NULL::uuid, p_appointment_id uuid DEFAULT NULL::uuid, p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30, p_bot_session_id uuid DEFAULT NULL::uuid, p_class_session_id uuid DEFAULT NULL::uuid, p_expected_price numeric DEFAULT NULL::integer, p_expected_deposit numeric DEFAULT NULL::integer, p_expected_terms jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean, committed_total numeric, committed_deposit numeric, tax_snapshot jsonb)
 LANGUAGE sql
 SET search_path TO 'public', 'extensions'
AS $function$
 SELECT (r->>'booking_id')::uuid,r->>'reference_code',(r->>'slot_available')::boolean,
 (r->>'committed_total')::numeric,(r->>'committed_deposit')::numeric,r->'tax_snapshot'
 FROM (SELECT private.scheduling_604_create_booking(jsonb_build_object('business_id',p_business_id,'user_id',p_user_id,'service_id',p_service_id,'staff_id',p_staff_id,'date',p_date,'time',p_time,'party_size',p_party_size,'flow_type',p_flow_type,'deposit_amount',p_deposit_amount,'deposit_status',p_deposit_status,'status',p_status,'guest_name',p_guest_name,'guest_phone',p_guest_phone,'guest_email',p_guest_email,'special_requests',p_special_requests,'venue_address',p_venue_address,'end_date',p_end_date,'addons_snapshot',p_addons_snapshot,'promo_code_id',p_promo_code_id,'total_amount',p_total_amount,'staff_name',p_staff_name,'location_id',p_location_id,'appointment_id',p_appointment_id,'bot_session_id',p_bot_session_id,'class_session_id',p_class_session_id,'expected_terms',p_expected_terms)) AS r) result;
$function$
;
ALTER FUNCTION public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.book_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,numeric,text,text,text,text,text,text,text,date,jsonb,uuid,numeric,text,uuid,uuid,integer,integer,uuid,uuid,numeric,numeric,jsonb) TO service_role;

DROP FUNCTION public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,numeric,text,integer,integer,uuid,uuid,jsonb);
CREATE OR REPLACE FUNCTION public.book_manual_slot_authoritative_604(p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid, p_date date, p_time text, p_party_size integer, p_max_capacity integer, p_guest_name text, p_guest_phone text, p_guest_email text, p_notes text, p_total_amount numeric, p_staff_name text, p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30, p_appointment_id uuid DEFAULT NULL::uuid, p_class_session_id uuid DEFAULT NULL::uuid, p_expected_terms jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean, committed_total numeric, committed_deposit numeric, tax_snapshot jsonb)
 LANGUAGE sql
 SET search_path TO 'public', 'extensions'
AS $function$
 SELECT (r->>'booking_id')::uuid,r->>'reference_code',(r->>'slot_available')::boolean,
 (r->>'committed_total')::numeric,(r->>'committed_deposit')::numeric,r->'tax_snapshot'
 FROM (SELECT private.scheduling_604_create_booking(jsonb_build_object('business_id',p_business_id,'user_id',p_user_id,'service_id',p_service_id,'staff_id',p_staff_id,'date',p_date,'time',p_time,'party_size',p_party_size,'guest_name',p_guest_name,'guest_phone',p_guest_phone,'guest_email',p_guest_email,'notes',p_notes,'total_amount',p_total_amount,'staff_name',p_staff_name,'appointment_id',p_appointment_id,'class_session_id',p_class_session_id,'expected_terms',p_expected_terms,
 'flow_type','scheduling','deposit_amount',0),'manual') AS r) result;
$function$
;
ALTER FUNCTION public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,numeric,text,integer,integer,uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,numeric,text,integer,integer,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.book_manual_slot_authoritative_604(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,numeric,text,integer,integer,uuid,uuid,jsonb) TO service_role;

DROP FUNCTION public.accept_order_quote_atomic(uuid,text);
CREATE OR REPLACE FUNCTION public.accept_order_quote_atomic(p_quote_id uuid, p_customer_phone text, p_expected_tax_snapshot jsonb DEFAULT NULL)
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
  v_tax_context jsonb; v_tax_snapshot jsonb;
  v_cart jsonb; v_negotiated jsonb; v_priced_item jsonb; v_priced_addons jsonb; v_index integer; v_addon_index integer;
BEGIN
  p_expected_tax_snapshot:=NULLIF(p_expected_tax_snapshot,'null'::jsonb);
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
    SELECT id, reference_code, total_amount, deposit_amount, balance_amount, tax_snapshot
    INTO v_existing_order
    FROM orders WHERE quote_request_id = p_quote_id LIMIT 1;
    IF v_existing_order.tax_snapshot IS DISTINCT FROM p_expected_tax_snapshot THEN RAISE EXCEPTION 'tax_terms_changed'; END IF;
    RETURN jsonb_build_object(
      'accepted', true, 'already_accepted', true,
      'order_id', v_existing_order.id,
      'reference_code', v_existing_order.reference_code,
      'total', COALESCE(v_existing_order.total_amount, 0),
      'deposit_amount', COALESCE(v_existing_order.deposit_amount, 0),
      'balance_amount', COALESCE(v_existing_order.balance_amount, 0),
      'customer_phone', v_quote.customer_phone,
      'business_id', v_quote.business_id, 'tax_snapshot',v_existing_order.tax_snapshot
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
  v_tax_context:=private.merchant_tax_context_980(v_quote.business_id);
  v_tax_snapshot:=v_quote.tax_snapshot;
  IF v_tax_snapshot IS NULL AND (v_tax_context->>'enabled')::boolean THEN RAISE EXCEPTION 'itemized_tax_quote_required'; END IF;
  IF v_tax_snapshot IS NOT NULL THEN
    IF jsonb_typeof(to_jsonb(v_quote)->'quoted_items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'itemized_tax_quote_required'; END IF;
    IF jsonb_array_length(to_jsonb(v_quote)->'quoted_items')<1 THEN RAISE EXCEPTION 'itemized_tax_quote_required'; END IF;
    PERFORM public.validate_merchant_tax_snapshot_980(v_tax_snapshot);
    IF private.tax_minor_980(v_total) IS DISTINCT FROM (v_tax_snapshot->>'grossAmount')::bigint THEN RAISE EXCEPTION 'quoted_tax_total_mismatch'; END IF;
  END IF;
  IF v_tax_snapshot IS DISTINCT FROM p_expected_tax_snapshot THEN RAISE EXCEPTION 'tax_terms_changed'; END IF;

  SELECT id, name, country_code, subscription_tier, trial_ends_at, metadata
  INTO v_biz FROM businesses WHERE id = v_quote.business_id;

  v_has_custom_data := v_quote.custom_order_data IS NOT NULL;
  v_custom_config := COALESCE(v_biz.metadata->'custom_order_config', '{}'::jsonb);
  v_deposit_pct := CASE
    WHEN v_has_custom_data THEN COALESCE((v_custom_config->>'deposit_percentage')::int, 0)
    ELSE 0
  END;
  v_deposit_amount := CASE WHEN v_deposit_pct > 0 THEN
    CASE WHEN v_tax_snapshot IS NULL THEN trunc(v_total*v_deposit_pct/100) ELSE round(v_total*v_deposit_pct/100,2) END ELSE 0 END;
  v_balance_amount := CASE WHEN v_deposit_pct > 0 THEN v_total - v_deposit_amount ELSE 0 END;

  -- Rehydrate catalog identities with the explicitly negotiated unit prices.
  -- Empty-cart custom work stays in the immutable snapshot, not fake inventory.
  v_cart:=COALESCE(v_quote.cart_snapshot,'[]'::jsonb);
  IF v_tax_snapshot IS NOT NULL THEN
    v_cart:='[]'::jsonb;
    FOR v_item,v_index IN SELECT value,(ordinality-1)::integer FROM jsonb_array_elements(COALESCE(v_quote.cart_snapshot,'[]')) WITH ORDINALITY LOOP
      SELECT value INTO v_negotiated FROM jsonb_array_elements(to_jsonb(v_quote)->'quoted_items') WHERE value->>'id'='item-'||v_index;
      IF v_negotiated IS NULL OR v_negotiated->>'product_id' IS DISTINCT FROM v_item->>'product_id'
        OR (v_negotiated->>'quantity')::numeric IS DISTINCT FROM (v_item->>'quantity')::numeric THEN RAISE EXCEPTION 'quote_catalog_item_mismatch'; END IF;
      v_priced_item:=v_item||jsonb_build_object('price',v_negotiated->'unit_price','name',v_negotiated->'description');
      v_priced_addons:='[]'::jsonb;
      FOR v_addon_entry,v_addon_index IN SELECT value,(ordinality-1)::integer FROM jsonb_array_elements(COALESCE(v_item->'addons','[]')) WITH ORDINALITY LOOP
        SELECT value INTO v_negotiated FROM jsonb_array_elements(to_jsonb(v_quote)->'quoted_items') WHERE value->>'id'='item-'||v_index||'-addon-'||v_addon_index;
        IF v_negotiated IS NULL OR v_negotiated->>'parent_id' IS DISTINCT FROM 'item-'||v_index THEN RAISE EXCEPTION 'quote_addon_mismatch'; END IF;
        v_priced_addons:=v_priced_addons||jsonb_build_array(v_addon_entry||jsonb_build_object('price',v_negotiated->'unit_price','name',v_negotiated->'description'));
      END LOOP;
      v_cart:=v_cart||jsonb_build_array(v_priced_item||jsonb_build_object('addons',v_priced_addons));
    END LOOP;
  END IF;

  -- 7. Phase 2: Product/variant/addon validation from cart_snapshot
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_cart)
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
    deposit_percentage, deposit_amount, balance_amount, tax_snapshot
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
    v_balance_amount, v_tax_snapshot
  ) RETURNING id, reference_code INTO v_order_id, v_ref;

  -- 9. Persist the negotiated catalog prices; legacy quotes retain their original cart
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_cart)
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
    'business_id', v_quote.business_id, 'tax_snapshot',v_tax_snapshot
  );
END;
$function$
;
ALTER FUNCTION public.accept_order_quote_atomic(uuid,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accept_order_quote_atomic(uuid,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_order_quote_atomic(uuid,text,jsonb) TO service_role;

CREATE FUNCTION public.quote_booking_tax_980(p_business uuid,p_service uuid,p_appointment uuid,p_party integer,p_addons jsonb,p_promo uuid,p_expected jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,extensions AS $$
 SELECT private.scheduling_604_quote(p_business,p_service,p_appointment,p_party,p_addons,p_promo,p_expected,false);
$$;
REVOKE ALL ON FUNCTION public.quote_booking_tax_980(uuid,uuid,uuid,integer,jsonb,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.quote_booking_tax_980(uuid,uuid,uuid,integer,jsonb,uuid,jsonb) TO service_role;

DO $$
DECLARE f record;
BEGIN
 FOR f IN SELECT oid::regprocedure AS signature,prosecdef,proconfig FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname IN ('create_order_atomic','create_catalog_order_atomic',
     'accept_order_quote_atomic','book_slot_atomic','book_slot_authoritative_604','book_manual_slot_authoritative_604','quote_booking_tax_980') LOOP
   IF has_function_privilege('anon',f.signature,'EXECUTE') OR has_function_privilege('authenticated',f.signature,'EXECUTE')
     OR NOT has_function_privilege('service_role',f.signature,'EXECUTE') THEN RAISE EXCEPTION 'tax_authority_grant_mismatch: %',f.signature; END IF;
   IF f.proconfig IS NULL THEN RAISE EXCEPTION 'tax_authority_search_path_missing: %',f.signature; END IF;
 END LOOP;
 IF to_regprocedure('public.create_order_atomic(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,uuid,text,text,uuid,text,numeric,numeric,text,text,text,text,jsonb,uuid,boolean,numeric)') IS NOT NULL
   OR to_regprocedure('public.accept_order_quote_atomic(uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'obsolete_tax_authority_overload'; END IF;
END $$;
COMMIT;
