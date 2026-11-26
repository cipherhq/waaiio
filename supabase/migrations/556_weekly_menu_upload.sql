-- M556: "Upload this week's menu" (weekly menus part 2). Owner decisions 2026-11-23.
--
-- A vendor photographs this week's menu, Ace reads it, she reviews the dishes
-- and taps "Save menu". The dishes are saved as products on sale this week
-- (Mon–Sun, using M555's available_from / available_until / available_days).
--
-- §1. products.weekly_menu_week (date, the Monday of the week a weekly-menu
--     save put the dish on). NULL = an ordinary item, which a weekly-menu save
--     never touches. CHECK: a Monday.
-- §2. public.menu_photo_reads: menu photo reads per business per local day
--     (its own daily limit, separate from the Ace setup allowance). RLS on, no
--     policy, no anon/authenticated grant; written only by §3 as service_role.
-- §3. public.consume_menu_photo_read(business, local date, daily limit):
--     counts one read atomically, or returns NULL when the day's limit is used.
-- §4. public.save_weekly_menu(business, week Monday, items): in one transaction,
--     one save at a time per business: reuses a previous weekly dish with the
--     same name or adds a new one, skips names that are ordinary items, then
--     hides (is_active = false, never deletes) every other weekly-menu dish.
--
-- §3 and §4 are SECURITY INVOKER with an empty search_path, EXECUTE for
-- service_role only. No existing function, policy, trigger or grant changes.
BEGIN;

-- §1
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS weekly_menu_week date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_weekly_menu_week_monday'
      AND conrelid = 'public.products'::regclass
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_weekly_menu_week_monday
      CHECK (weekly_menu_week IS NULL OR extract(isodow FROM weekly_menu_week) = 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_weekly_menu
  ON public.products (business_id)
  WHERE weekly_menu_week IS NOT NULL;

-- §2
CREATE TABLE IF NOT EXISTS public.menu_photo_reads (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  read_date date NOT NULL,
  read_count integer NOT NULL CHECK (read_count > 0),
  PRIMARY KEY (business_id, read_date)
);

ALTER TABLE public.menu_photo_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.menu_photo_reads FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.menu_photo_reads TO service_role;

-- §3
CREATE OR REPLACE FUNCTION public.consume_menu_photo_read(
  p_business_id uuid,
  p_read_date date,
  p_daily_limit integer
)
RETURNS integer
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  INSERT INTO public.menu_photo_reads AS r (business_id, read_date, read_count)
  SELECT p_business_id, p_read_date, 1
  WHERE p_daily_limit > 0
  ON CONFLICT (business_id, read_date)
  DO UPDATE SET read_count = r.read_count + 1
  WHERE r.read_count < p_daily_limit
  RETURNING read_count;
$$;

REVOKE ALL ON FUNCTION public.consume_menu_photo_read(uuid, date, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_menu_photo_read(uuid, date, integer) TO service_role;

-- §4
CREATE OR REPLACE FUNCTION public.save_weekly_menu(
  p_business_id uuid,
  p_week_start date,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_item jsonb;
  v_name text;
  v_price numeric;
  v_days smallint[];
  v_category text;
  v_description text;
  v_reuse_id uuid;
  v_id uuid;
  v_kept uuid[] := '{}';
  v_skipped text[] := '{}';
  v_created integer := 0;
  v_updated integer := 0;
  v_hidden integer := 0;
  v_sort integer;
BEGIN
  IF p_week_start IS NULL OR extract(isodow FROM p_week_start) <> 1 THEN
    RAISE EXCEPTION 'week must start on a Monday' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'items must be a non-empty list' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(DISTINCT lower(btrim(x->>'name'))) FROM jsonb_array_elements(p_items) x)
     <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'each dish name must appear once' USING ERRCODE = '22023';
  END IF;

  -- One save at a time per business.
  PERFORM 1 FROM public.businesses WHERE id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'business not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(max(sort_order), -1) INTO v_sort
  FROM public.products WHERE business_id = p_business_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_name := btrim(coalesce(v_item->>'name', ''));
    v_price := (v_item->>'price')::numeric;
    IF v_name = '' OR v_price IS NULL OR v_price < 0 THEN
      RAISE EXCEPTION 'each dish needs a name and a price' USING ERRCODE = '22023';
    END IF;
    v_days := CASE
      WHEN jsonb_typeof(v_item->'days') = 'array' AND jsonb_array_length(v_item->'days') > 0
        THEN ARRAY(SELECT DISTINCT d::smallint FROM jsonb_array_elements_text(v_item->'days') d ORDER BY 1)
      ELSE NULL
    END;
    IF cardinality(v_days) = 7 THEN v_days := NULL; END IF; -- all seven = every day this week
    v_category := nullif(btrim(coalesce(v_item->>'category', '')), '');
    v_description := nullif(btrim(coalesce(v_item->>'description', '')), '');

    -- An ordinary item with this name stays exactly as it is.
    IF EXISTS (
      SELECT 1 FROM public.products
      WHERE business_id = p_business_id AND deleted_at IS NULL
        AND weekly_menu_week IS NULL AND lower(btrim(name)) = lower(v_name)
    ) THEN
      v_skipped := v_skipped || v_name;
      CONTINUE;
    END IF;

    SELECT id INTO v_reuse_id
    FROM public.products
    WHERE business_id = p_business_id AND deleted_at IS NULL
      AND weekly_menu_week IS NOT NULL AND lower(btrim(name)) = lower(v_name)
    ORDER BY weekly_menu_week DESC, updated_at DESC, id
    LIMIT 1;

    IF v_reuse_id IS NOT NULL THEN
      UPDATE public.products SET
        price = v_price,
        available_days = v_days,
        available_from = p_week_start,
        available_until = p_week_start + 6,
        weekly_menu_week = p_week_start,
        is_active = true,
        category = coalesce(v_category, category),
        description = coalesce(v_description, description)
      WHERE id = v_reuse_id
      RETURNING id INTO v_id;
      v_updated := v_updated + 1;
    ELSE
      v_sort := v_sort + 1;
      INSERT INTO public.products (
        business_id, name, price, description, category, is_active, sort_order,
        available_days, available_from, available_until, weekly_menu_week
      ) VALUES (
        p_business_id, v_name, v_price, v_description, v_category, true, v_sort,
        v_days, p_week_start, p_week_start + 6, p_week_start
      )
      RETURNING id INTO v_id;
      v_created := v_created + 1;
    END IF;
    v_kept := v_kept || v_id;
  END LOOP;

  -- Last week's (and an earlier save this week's) dishes are hidden, never deleted.
  UPDATE public.products SET is_active = false
  WHERE business_id = p_business_id
    AND weekly_menu_week IS NOT NULL
    AND deleted_at IS NULL
    AND is_active
    AND NOT (id = ANY (v_kept));
  GET DIAGNOSTICS v_hidden = ROW_COUNT;

  RETURN jsonb_build_object(
    'created', v_created,
    'updated', v_updated,
    'hidden', v_hidden,
    'skipped', to_jsonb(v_skipped)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_weekly_menu(uuid, date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_weekly_menu(uuid, date, jsonb) TO service_role;

COMMIT;
