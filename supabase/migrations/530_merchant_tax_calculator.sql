-- #980: shared pure tax arithmetic. DRAFT; no checkout enablement in this migration.
-- Every monetary input/output is an integer minor-unit amount, not a major-unit DB amount.
BEGIN;

CREATE FUNCTION public.validate_merchant_tax_rule_980(p_rule jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_label text;
  v_rate numeric;
BEGIN
  IF jsonb_typeof(p_rule) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_rule->'label') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_rule->'rateBps') IS DISTINCT FROM 'number'
    OR p_rule->>'priceMode' IS NULL OR p_rule->>'priceMode' NOT IN ('inclusive','exclusive') THEN
    RAISE EXCEPTION 'Invalid tax rule' USING ERRCODE='22023';
  END IF;
  v_label := p_rule->>'label';
  -- JS String.trim whitespace, including non-breaking and Unicode space separators.
  IF length(btrim(v_label, E' \t\n\r\f\v' || chr(160) || chr(5760) || chr(8192) || chr(8193)
    || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199)
    || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
    || chr(8287) || chr(12288) || chr(65279))) = 0
    OR length(v_label) + length(regexp_replace(v_label, '[^𐀀-􏿿]', '', 'g')) > 60 THEN
    RAISE EXCEPTION 'Invalid tax label' USING ERRCODE='22023';
  END IF;
  v_rate := (p_rule->>'rateBps')::numeric;
  IF v_rate < 0 OR v_rate > 10000 OR trunc(v_rate*100) <> v_rate*100 THEN
    RAISE EXCEPTION 'Invalid tax rate' USING ERRCODE='22023';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.validate_merchant_tax_rule_980(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.validate_merchant_tax_rule_980(jsonb) TO service_role;

CREATE FUNCTION public.calculate_merchant_tax_quote_980(
  p_config jsonb, p_currency text, p_lines jsonb, p_discount_amount bigint DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_max constant numeric := 9007199254740991;
  v_whitespace constant text := E' \t\n\r\f\v' || chr(160) || chr(5760) || chr(8192) || chr(8193)
    || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199)
    || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
    || chr(8287) || chr(12288) || chr(65279);
  v_line jsonb;
  v_rule jsonb;
  v_override jsonb;
  v_id text;
  v_description text;
  v_ids text[] := ARRAY[]::text[];
  v_amounts numeric[] := ARRAY[]::numeric[];
  v_weights numeric[] := ARRAY[]::numeric[];
  v_direct_discounts numeric[] := ARRAY[]::numeric[];
  v_discounts numeric[] := ARRAY[]::numeric[];
  v_remainders numeric[] := ARRAY[]::numeric[];
  v_quantity numeric;
  v_unit numeric;
  v_amount numeric;
  v_weight numeric;
  v_direct_discount numeric;
  v_denominator numeric := 0;
  v_allocated numeric := 0;
  v_remaining integer;
  v_index integer := 0;
  v_candidate integer;
  v_discounted numeric;
  v_net numeric;
  v_tax numeric;
  v_gross numeric;
  v_total_net numeric := 0;
  v_total_tax numeric := 0;
  v_total_discount numeric := 0;
  v_rate numeric;
  v_mode text;
  v_treatment text;
  v_result jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_config->'enabled') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Invalid merchant tax configuration' USING ERRCODE='22023';
  END IF;
  PERFORM public.validate_merchant_tax_rule_980(p_config);
  IF p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Invalid tax currency' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid tax lines' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_lines) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Tax quote requires 1-200 lines' USING ERRCODE='22023';
  END IF;
  IF p_discount_amount IS NULL OR p_discount_amount < 0 OR p_discount_amount > v_max THEN
    RAISE EXCEPTION 'Invalid discount' USING ERRCODE='22023';
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_line->'id') IS DISTINCT FROM 'string'
      OR coalesce(v_line->>'id','') = '' THEN
      RAISE EXCEPTION 'Invalid tax line identifier' USING ERRCODE='22023';
    END IF;
    v_id := v_line->>'id';
    IF v_id = ANY(v_ids) THEN RAISE EXCEPTION 'Duplicate tax line identifier' USING ERRCODE='22023'; END IF;
    v_ids := array_append(v_ids, v_id);
    v_description := v_line->>'description';
    IF jsonb_typeof(v_line->'description') IS DISTINCT FROM 'string'
      OR length(btrim(v_description,v_whitespace)) = 0
      OR length(v_description) + length(regexp_replace(v_description, '[^𐀀-􏿿]', '', 'g')) > 500 THEN
      RAISE EXCEPTION 'Invalid tax line description' USING ERRCODE='22023';
    END IF;
    IF jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_line->'unitAmount') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Invalid tax line amount' USING ERRCODE='22023';
    END IF;
    v_quantity := (v_line->>'quantity')::numeric;
    v_unit := (v_line->>'unitAmount')::numeric;
    IF v_quantity < 1 OR v_quantity > v_max OR trunc(v_quantity) <> v_quantity
      OR v_unit < 0 OR v_unit > v_max OR trunc(v_unit) <> v_unit THEN
      RAISE EXCEPTION 'Invalid tax line amount' USING ERRCODE='22023';
    END IF;
    v_amount := v_quantity * v_unit;
    IF v_amount > v_max THEN RAISE EXCEPTION 'Tax amount exceeds safe integer range' USING ERRCODE='22023'; END IF;
    IF v_line->'lineDiscountAmount' IS NOT NULL AND v_line->'lineDiscountAmount'<>'null'::jsonb
      AND jsonb_typeof(v_line->'lineDiscountAmount') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Invalid line discount' USING ERRCODE='22023';
    END IF;
    v_direct_discount:=COALESCE((v_line->>'lineDiscountAmount')::numeric,0);
    IF v_direct_discount<0 OR v_direct_discount>v_amount OR trunc(v_direct_discount)<>v_direct_discount THEN
      RAISE EXCEPTION 'Invalid line discount' USING ERRCODE='22023';
    END IF;
    v_weight := CASE WHEN v_line->'discountEligible' = 'false'::jsonb THEN 0 ELSE v_amount-v_direct_discount END;
    v_amounts := array_append(v_amounts,v_amount);
    v_weights := array_append(v_weights,v_weight);
    v_direct_discounts := array_append(v_direct_discounts,v_direct_discount);
    v_denominator := v_denominator + v_weight;
    IF v_denominator > v_max THEN RAISE EXCEPTION 'Tax amount exceeds safe integer range' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF p_discount_amount > v_denominator THEN
    RAISE EXCEPTION 'Discount exceeds eligible line value' USING ERRCODE='22023';
  END IF;

  FOR v_index IN 1..array_length(v_amounts,1) LOOP
    IF v_denominator = 0 THEN
      v_discounts := array_append(v_discounts,v_direct_discounts[v_index]);
      v_remainders := array_append(v_remainders,0::numeric);
    ELSE
      v_amount := div(p_discount_amount::numeric * v_weights[v_index], v_denominator);
      v_discounts := array_append(v_discounts,v_amount+v_direct_discounts[v_index]);
      v_remainders := array_append(v_remainders,mod(p_discount_amount::numeric * v_weights[v_index],v_denominator));
      v_allocated := v_allocated + v_amount;
    END IF;
  END LOOP;
  v_remaining := p_discount_amount - v_allocated;
  -- Largest remainders win, with original input order breaking ties.
  FOR v_candidate IN SELECT i FROM generate_subscripts(v_remainders,1) s(i)
    ORDER BY v_remainders[i] DESC, i ASC LIMIT v_remaining LOOP
    v_discounts[v_candidate] := v_discounts[v_candidate] + 1;
  END LOOP;

  v_index := 0;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_index := v_index + 1;
    v_override := coalesce(nullif(v_line->'tax','null'::jsonb),'{}'::jsonb);
    IF v_override = '{}'::jsonb AND (NOT v_line ? 'tax' OR v_line->'tax' = 'null'::jsonb) THEN
      v_override := '{"treatment":"inherit"}'::jsonb;
    END IF;
    IF v_override->>'treatment' IS NULL OR v_override->>'treatment' NOT IN ('inherit','override','exempt') THEN
      RAISE EXCEPTION 'Invalid tax treatment' USING ERRCODE='22023';
    END IF;
    IF v_override->>'treatment' = 'override' THEN
      v_rule := v_override->'rule';
    ELSE
      IF v_override->'rule' IS NOT NULL AND v_override->'rule' <> 'null'::jsonb THEN
        RAISE EXCEPTION 'Unexpected tax override rule' USING ERRCODE='22023';
      END IF;
      v_rule := p_config;
    END IF;
    PERFORM public.validate_merchant_tax_rule_980(v_rule);
    v_treatment := CASE WHEN NOT (p_config->>'enabled')::boolean THEN 'disabled'
      WHEN v_override->>'treatment' = 'exempt' THEN 'exempt'
      WHEN (v_rule->>'rateBps')::numeric = 0 THEN 'zero_rated' ELSE 'taxable' END;
    v_rate := CASE WHEN v_treatment='taxable' THEN (v_rule->>'rateBps')::numeric ELSE 0 END;
    v_mode := v_rule->>'priceMode';
    v_discounted := v_amounts[v_index] - v_discounts[v_index];
    v_net := CASE WHEN v_mode='inclusive' AND v_rate<>0
      THEN div(v_discounted*2000000+1000000+v_rate*100,2*(1000000+v_rate*100)) ELSE v_discounted END;
    v_tax := CASE WHEN v_mode='inclusive' THEN v_discounted-v_net ELSE div(v_net*(v_rate*100)*2+1000000,2000000) END;
    v_gross := v_net+v_tax;
    v_total_net := v_total_net+v_net;
    v_total_tax := v_total_tax+v_tax;
    v_total_discount := v_total_discount+v_discounts[v_index];
    IF greatest(v_gross,v_total_net,v_total_tax,v_total_net+v_total_tax,v_total_discount)>v_max THEN
      RAISE EXCEPTION 'Tax amount exceeds safe integer range' USING ERRCODE='22023';
    END IF;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'id',v_line->>'id','description',v_line->>'description',
      'quantity',(v_line->>'quantity')::numeric,'unitAmount',(v_line->>'unitAmount')::numeric,
      'treatment',v_treatment,'label',btrim(v_rule->>'label',v_whitespace),'rateBps',v_rate,'priceMode',v_mode,
      'lineDiscountAmount',v_direct_discounts[v_index],
      'discountAmount',v_discounts[v_index],'netAmount',v_net,'taxAmount',v_tax,'grossAmount',v_gross));
  END LOOP;
  RETURN jsonb_build_object('version',1,'currency',p_currency,'lines',v_result,
    'discountAmount',v_total_discount,'netAmount',v_total_net,'taxAmount',v_total_tax,
    'grossAmount',v_total_net+v_total_tax,'percentageFeeBase',v_total_net);
END $$;
REVOKE ALL ON FUNCTION public.calculate_merchant_tax_quote_980(jsonb,text,jsonb,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_merchant_tax_quote_980(jsonb,text,jsonb,bigint) TO service_role;

DO $$
DECLARE v_signature text; v_proc record;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY['public.validate_merchant_tax_rule_980(jsonb)',
    'public.calculate_merchant_tax_quote_980(jsonb,text,jsonb,bigint)'] LOOP
    SELECT prosecdef,provolatile,proconfig INTO STRICT v_proc FROM pg_proc WHERE oid=v_signature::regprocedure;
    IF v_proc.prosecdef OR v_proc.provolatile<>'i' OR NOT ('search_path=pg_catalog'=ANY(v_proc.proconfig)) THEN
      RAISE EXCEPTION 'Tax calculator security/volatility contract failed: %',v_signature;
    END IF;
    IF has_function_privilege('anon',v_signature,'EXECUTE') OR has_function_privilege('authenticated',v_signature,'EXECUTE')
      OR NOT has_function_privilege('service_role',v_signature,'EXECUTE') THEN
      RAISE EXCEPTION 'Tax calculator execution grant contract failed: %',v_signature;
    END IF;
  END LOOP;
END $$;
COMMIT;
