-- #980: additive merchant tax configuration storage (snapshot integration pending).
-- DRAFT: not applied. Tax checkout wiring and catalog certification required before release.
BEGIN;

CREATE TABLE public.merchant_tax_settings (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  label text NOT NULL DEFAULT 'Tax' CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  rate_bps integer NOT NULL DEFAULT 0 CHECK (rate_bps BETWEEN 0 AND 10000),
  price_mode text NOT NULL DEFAULT 'exclusive' CHECK (price_mode IN ('inclusive','exclusive')),
  delivery_treatment text NOT NULL DEFAULT 'exempt' CHECK (delivery_treatment IN ('override','exempt')),
  delivery_label text NOT NULL DEFAULT 'Delivery tax' CHECK (length(btrim(delivery_label)) BETWEEN 1 AND 60),
  delivery_rate_bps integer NOT NULL DEFAULT 0 CHECK (delivery_rate_bps BETWEEN 0 AND 10000),
  delivery_price_mode text NOT NULL DEFAULT 'exclusive' CHECK (delivery_price_mode IN ('inclusive','exclusive')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.merchant_tax_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.merchant_tax_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.merchant_tax_settings TO authenticated;
GRANT ALL ON public.merchant_tax_settings TO service_role;
CREATE POLICY merchant_tax_owner_select ON public.merchant_tax_settings FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id=merchant_tax_settings.business_id AND b.owner_id=(SELECT auth.uid())));
CREATE POLICY merchant_tax_owner_insert ON public.merchant_tax_settings FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id=merchant_tax_settings.business_id AND b.owner_id=(SELECT auth.uid())));
CREATE POLICY merchant_tax_owner_update ON public.merchant_tax_settings FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id=merchant_tax_settings.business_id AND b.owner_id=(SELECT auth.uid())))
WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id=merchant_tax_settings.business_id AND b.owner_id=(SELECT auth.uid())));

-- Explicit catalog columns avoid losing settings when other metadata writers update a row.
ALTER TABLE public.products
  ADD COLUMN tax_treatment text NOT NULL DEFAULT 'inherit',
  ADD COLUMN tax_label text,
  ADD COLUMN tax_rate_bps integer,
  ADD COLUMN tax_price_mode text,
  ADD CONSTRAINT products_tax_treatment_valid CHECK (
    (tax_treatment IN ('inherit','exempt') AND tax_label IS NULL AND tax_rate_bps IS NULL AND tax_price_mode IS NULL)
    OR (tax_treatment='override' AND tax_label IS NOT NULL AND length(btrim(tax_label)) BETWEEN 1 AND 60
      AND tax_rate_bps IS NOT NULL AND tax_rate_bps BETWEEN 0 AND 10000
      AND tax_price_mode IS NOT NULL AND tax_price_mode IN ('inclusive','exclusive')));
ALTER TABLE public.services
  ADD COLUMN tax_treatment text NOT NULL DEFAULT 'inherit',
  ADD COLUMN tax_label text,
  ADD COLUMN tax_rate_bps integer,
  ADD COLUMN tax_price_mode text,
  ADD CONSTRAINT services_tax_treatment_valid CHECK (
    (tax_treatment IN ('inherit','exempt') AND tax_label IS NULL AND tax_rate_bps IS NULL AND tax_price_mode IS NULL)
    OR (tax_treatment='override' AND tax_label IS NOT NULL AND length(btrim(tax_label)) BETWEEN 1 AND 60
      AND tax_rate_bps IS NOT NULL AND tax_rate_bps BETWEEN 0 AND 10000
      AND tax_price_mode IS NOT NULL AND tax_price_mode IN ('inclusive','exclusive')));

-- Deliberately do not add snapshot columns yet: their authoritative write/immutability
-- functions must ship atomically with price-authority and refund integration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='merchant_tax_settings' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'Merchant tax settings must have RLS';
  END IF;
  IF has_table_privilege('anon','public.merchant_tax_settings','SELECT')
    OR has_table_privilege('authenticated','public.merchant_tax_settings','DELETE') THEN
    RAISE EXCEPTION 'Unexpected merchant tax settings grants';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)
    WHERE NOT has_table_privilege('service_role','public.merchant_tax_settings',p.privilege)) THEN
    RAISE EXCEPTION 'Merchant tax settings service grants missing';
  END IF;
END $$;
COMMIT;
