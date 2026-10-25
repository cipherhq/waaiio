-- M467: October 25 owner-approved subscription price refresh (Stripe markets)
-- DEPENDS ON M458: countries.pricing is the pricing source of truth.
-- This migration deliberately does NOT reprice NG/GH: their Paystack plan codes
-- must be created and preflighted before an atomic Admin save_refs cutover.
-- Existing subscriptions are not mutated. New Stripe checkouts use inline price_data.
BEGIN;
DO $$
DECLARE v_code text; v_growth numeric; v_business numeric; v_count integer;
BEGIN
  -- Assert exact supported country records before changing any pricing.
  FOR v_code, v_growth, v_business IN
    SELECT * FROM (VALUES
      ('US'::text, 49::numeric, 89.99::numeric),
      ('CA'::text, 49::numeric, 89.99::numeric),
      ('GB'::text, 30::numeric, 80::numeric)
    ) AS proposed(code, growth_price, business_price)
  LOOP
    SELECT count(*) INTO v_count FROM public.countries
     WHERE code=v_code AND is_active=true
       AND jsonb_typeof(pricing)='object'
       AND jsonb_typeof(pricing->'growth')='object'
       AND jsonb_typeof(pricing->'business')='object'
       AND payment_gateway='stripe';
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'M467 price refresh blocked: % requires active Stripe country and existing tier structure', v_code;
    END IF;
  END LOOP;
END $$;
-- M458 temporarily disables this readiness trigger during already-active price changes.
ALTER TABLE public.countries DISABLE TRIGGER trg_guard_country_activation;
UPDATE public.countries AS c SET pricing =
  jsonb_set(jsonb_set(c.pricing, '{growth,price}', to_jsonb(v.growth_price), false),
            '{business,price}', to_jsonb(v.business_price), false)
FROM (VALUES ('US',49::numeric,89.99::numeric),
             ('CA',49::numeric,89.99::numeric),
             ('GB',30::numeric,80::numeric)) v(code,growth_price,business_price)
WHERE c.code=v.code AND c.is_active=true AND c.payment_gateway='stripe';
ALTER TABLE public.countries ENABLE TRIGGER trg_guard_country_activation;
DO $$
DECLARE v_count int;
BEGIN
 SELECT count(*) INTO v_count FROM public.countries c
 JOIN (VALUES ('US',49::numeric,89.99::numeric),
              ('CA',49::numeric,89.99::numeric),
              ('GB',30::numeric,80::numeric)) v(code,growth_price,business_price)
 ON c.code=v.code
 WHERE (c.pricing->'growth'->>'price')::numeric=v.growth_price
   AND (c.pricing->'business'->>'price')::numeric=v.business_price;
 IF v_count <> 3 THEN RAISE EXCEPTION 'M467 post-update pricing verification failed'; END IF;
END $$;
COMMIT;
-- NG: growth 49000, business 99000 NGN.
-- GH: growth 450, business 900 GHS.
-- Both require verified new provider plans and CAS+MFA Admin atomic save_refs.
-- Trial messaging-credit changes belong to the commercial-config/version authority,
-- NOT this country subscription price migration.
