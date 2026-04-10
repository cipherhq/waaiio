-- 037_ordering_building_blocks.sql
-- Add-ons, Volume Discounts, Delivery Zones, Quote Requests

-- ══════════════════════════════════════════════════
-- 1. ENUMS
-- ══════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE addon_price_type AS ENUM ('fixed', 'per_unit', 'quote');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE discount_type AS ENUM ('percentage', 'fixed_per_unit', 'fixed_total');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE quote_status AS ENUM ('pending', 'quoted', 'accepted', 'rejected', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ══════════════════════════════════════════════════
-- 2. PRODUCT ADD-ONS
-- ══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS product_addons (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id    UUID REFERENCES products(id) ON DELETE CASCADE,  -- NULL = business-wide
  name          VARCHAR(200) NOT NULL,
  description   TEXT,
  price         INTEGER NOT NULL DEFAULT 0,
  price_type    addon_price_type NOT NULL DEFAULT 'fixed',
  unit_label    VARCHAR(50),  -- e.g. "per person", "per kg"
  min_quantity  INTEGER DEFAULT 1,
  max_quantity  INTEGER,
  is_required   BOOLEAN DEFAULT false,
  is_negotiable BOOLEAN DEFAULT false,
  is_active     BOOLEAN DEFAULT true,
  sort_order    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_addons_business ON product_addons(business_id);
CREATE INDEX IF NOT EXISTS idx_product_addons_product ON product_addons(product_id);

-- ══════════════════════════════════════════════════
-- 3. VOLUME DISCOUNT RULES
-- ══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS volume_discount_rules (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id) ON DELETE CASCADE,  -- NULL = all products
  name            VARCHAR(200) NOT NULL,
  min_quantity    INTEGER NOT NULL,
  max_quantity    INTEGER,  -- NULL = no cap
  discount_type   discount_type NOT NULL DEFAULT 'percentage',
  discount_value  NUMERIC(12,2) NOT NULL,
  is_active       BOOLEAN DEFAULT true,
  sort_order      INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_volume_discount_rules_business ON volume_discount_rules(business_id);
CREATE INDEX IF NOT EXISTS idx_volume_discount_rules_product ON volume_discount_rules(product_id);

-- ══════════════════════════════════════════════════
-- 4. DELIVERY ZONES
-- ══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS delivery_zones (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL,
  price           INTEGER NOT NULL DEFAULT 0,  -- 0 = free
  estimated_time  VARCHAR(100),  -- e.g. "30-45 mins", "Same day"
  is_negotiable   BOOLEAN DEFAULT false,
  is_pickup       BOOLEAN DEFAULT false,
  is_active       BOOLEAN DEFAULT true,
  sort_order      INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_zones_business ON delivery_zones(business_id);

-- ══════════════════════════════════════════════════
-- 5. QUOTE REQUESTS
-- ══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS quote_requests (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id             UUID REFERENCES profiles(id),
  customer_phone      VARCHAR(20),
  customer_name       VARCHAR(200),
  status              quote_status NOT NULL DEFAULT 'pending',
  cart_snapshot       JSONB DEFAULT '[]',
  addons_snapshot     JSONB DEFAULT '[]',
  delivery_zone_id    UUID REFERENCES delivery_zones(id),
  delivery_zone_name  VARCHAR(200),
  delivery_address    TEXT,
  estimated_subtotal  INTEGER DEFAULT 0,
  quoted_amount       INTEGER,
  quote_notes         TEXT,
  quoted_at           TIMESTAMPTZ,
  customer_response   TEXT,
  responded_at        TIMESTAMPTZ,
  order_id            UUID REFERENCES orders(id),
  expires_at          TIMESTAMPTZ,
  notes               TEXT,
  channel             VARCHAR(20) DEFAULT 'whatsapp',
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_requests_business ON quote_requests(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quote_requests_status ON quote_requests(business_id, status);

-- ══════════════════════════════════════════════════
-- 6. EXTEND EXISTING TABLES
-- ══════════════════════════════════════════════════

-- order_items: store addons per item
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS addons JSONB DEFAULT '[]';

-- orders: delivery zone + totals
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zone_id UUID REFERENCES delivery_zones(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zone_name VARCHAR(200);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS addons_total INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS volume_discount_amount INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_request_id UUID REFERENCES quote_requests(id);

-- ══════════════════════════════════════════════════
-- 7. ROW-LEVEL SECURITY
-- ══════════════════════════════════════════════════

ALTER TABLE product_addons ENABLE ROW LEVEL SECURITY;
ALTER TABLE volume_discount_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_requests ENABLE ROW LEVEL SECURITY;

-- Product Addons: owner CRUD
CREATE POLICY product_addons_owner_select ON product_addons FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY product_addons_owner_insert ON product_addons FOR INSERT
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY product_addons_owner_update ON product_addons FOR UPDATE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY product_addons_owner_delete ON product_addons FOR DELETE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Service-role SELECT on addons (bot reads)
CREATE POLICY product_addons_service_select ON product_addons FOR SELECT
  TO service_role USING (true);

-- Volume Discount Rules: owner CRUD
CREATE POLICY volume_discount_rules_owner_select ON volume_discount_rules FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY volume_discount_rules_owner_insert ON volume_discount_rules FOR INSERT
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY volume_discount_rules_owner_update ON volume_discount_rules FOR UPDATE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY volume_discount_rules_owner_delete ON volume_discount_rules FOR DELETE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Service-role SELECT on discounts (bot reads)
CREATE POLICY volume_discount_rules_service_select ON volume_discount_rules FOR SELECT
  TO service_role USING (true);

-- Delivery Zones: owner CRUD
CREATE POLICY delivery_zones_owner_select ON delivery_zones FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY delivery_zones_owner_insert ON delivery_zones FOR INSERT
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY delivery_zones_owner_update ON delivery_zones FOR UPDATE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY delivery_zones_owner_delete ON delivery_zones FOR DELETE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Service-role SELECT on zones (bot reads)
CREATE POLICY delivery_zones_service_select ON delivery_zones FOR SELECT
  TO service_role USING (true);

-- Quote Requests: owner CRUD
CREATE POLICY quote_requests_owner_select ON quote_requests FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY quote_requests_owner_update ON quote_requests FOR UPDATE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Service-role ALL on quote_requests (bot creates)
CREATE POLICY quote_requests_service_all ON quote_requests FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════
-- 8. TRIGGERS — updated_at
-- ══════════════════════════════════════════════════

CREATE TRIGGER set_updated_at_product_addons
  BEFORE UPDATE ON product_addons
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at_volume_discount_rules
  BEFORE UPDATE ON volume_discount_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at_delivery_zones
  BEFORE UPDATE ON delivery_zones
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at_quote_requests
  BEFORE UPDATE ON quote_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ══════════════════════════════════════════════════
-- 9. CALCULATE VOLUME DISCOUNT — RPC function
-- ══════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION calculate_volume_discount(
  p_business_id UUID,
  p_product_id UUID,
  p_quantity INTEGER,
  p_unit_price INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_rule RECORD;
  v_discount INTEGER := 0;
BEGIN
  -- Find the best matching rule (most specific: product-level first, then business-wide)
  SELECT * INTO v_rule
  FROM volume_discount_rules
  WHERE business_id = p_business_id
    AND is_active = true
    AND (product_id = p_product_id OR product_id IS NULL)
    AND p_quantity >= min_quantity
    AND (max_quantity IS NULL OR p_quantity <= max_quantity)
  ORDER BY
    product_id IS NULL ASC,  -- product-specific first
    min_quantity DESC         -- highest matching tier
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Calculate discount based on type
  CASE v_rule.discount_type
    WHEN 'percentage' THEN
      v_discount := ROUND((p_unit_price * p_quantity * v_rule.discount_value) / 100);
    WHEN 'fixed_per_unit' THEN
      v_discount := ROUND(v_rule.discount_value * p_quantity);
    WHEN 'fixed_total' THEN
      v_discount := ROUND(v_rule.discount_value);
  END CASE;

  -- Cap discount at item total
  IF v_discount > (p_unit_price * p_quantity) THEN
    v_discount := p_unit_price * p_quantity;
  END IF;

  RETURN v_discount;
END;
$$;
