-- ═══════════════════════════════════════════════════════
-- Blowded Multi-Industry Migration
-- Transforms restaurant-only platform into multi-industry
-- ═══════════════════════════════════════════════════════

-- ── New Enum Types ──────────────────────────────────────

CREATE TYPE business_category AS ENUM (
  'restaurant', 'barber', 'spa', 'salon', 'gym', 'clinic',
  'consultant', 'church', 'mosque', 'school', 'ngo',
  'shop', 'food_delivery', 'events', 'transport', 'cinema', 'other'
);

CREATE TYPE flow_type AS ENUM ('scheduling', 'payment', 'ordering', 'ticketing');

CREATE TYPE subscription_tier AS ENUM ('free', 'growth', 'business');

CREATE TYPE booking_status AS ENUM (
  'pending', 'confirmed', 'in_progress', 'completed', 'no_show', 'cancelled'
);

CREATE TYPE order_status AS ENUM (
  'draft', 'confirmed', 'processing', 'ready', 'delivered', 'cancelled'
);

CREATE TYPE event_status AS ENUM (
  'draft', 'published', 'sold_out', 'cancelled', 'completed'
);

-- ── Rename restaurants → businesses ─────────────────────

ALTER TABLE public.restaurants RENAME TO businesses;

-- Add new columns to businesses
ALTER TABLE public.businesses
  ADD COLUMN category business_category NOT NULL DEFAULT 'restaurant',
  ADD COLUMN flow_type flow_type NOT NULL DEFAULT 'scheduling',
  ADD COLUMN subscription_tier subscription_tier NOT NULL DEFAULT 'free',
  ADD COLUMN timezone VARCHAR(50) NOT NULL DEFAULT 'Africa/Lagos',
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days');

-- Update existing indexes to use new table name (Postgres renames automatically with ALTER TABLE RENAME)
-- But we need to update the trigger
DROP TRIGGER IF EXISTS update_restaurants_updated_at ON public.businesses;
CREATE TRIGGER update_businesses_updated_at
  BEFORE UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── Rename reservations → bookings ──────────────────────

ALTER TABLE public.reservations RENAME TO bookings;

-- Rename column
ALTER TABLE public.bookings RENAME COLUMN restaurant_id TO business_id;

-- Add new columns to bookings
ALTER TABLE public.bookings
  ADD COLUMN service_id UUID,
  ADD COLUMN flow_type flow_type,
  ADD COLUMN quantity INTEGER DEFAULT 1,
  ADD COLUMN total_amount INTEGER DEFAULT 0,
  ADD COLUMN platform_fee INTEGER DEFAULT 0,
  ADD COLUMN notes TEXT;

-- Update trigger
DROP TRIGGER IF EXISTS update_reservations_updated_at ON public.bookings;
CREATE TRIGGER update_bookings_updated_at
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Update the reference code function to use bookings table
CREATE OR REPLACE FUNCTION public.generate_reference_code()
RETURNS TRIGGER AS $$
DECLARE
  new_code VARCHAR(10);
  code_exists BOOLEAN;
BEGIN
  LOOP
    new_code := 'BW-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
    SELECT EXISTS(SELECT 1 FROM public.bookings WHERE reference_code = new_code) INTO code_exists;
    EXIT WHEN NOT code_exists;
  END LOOP;
  NEW.reference_code := new_code;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Update FK references in other tables ────────────────

-- whatsapp_config: rename restaurant_id → business_id
ALTER TABLE public.whatsapp_config RENAME COLUMN restaurant_id TO business_id;

-- bot_sessions: rename restaurant_id → business_id
ALTER TABLE public.bot_sessions RENAME COLUMN restaurant_id TO business_id;

-- Recreate the unique index on bot_sessions with new column name
DROP INDEX IF EXISTS idx_bot_sessions_phone_restaurant;
CREATE UNIQUE INDEX idx_bot_sessions_phone_business
  ON public.bot_sessions(phone, business_id) WHERE business_id IS NOT NULL;

-- subscriptions: rename restaurant_id → business_id
ALTER TABLE public.subscriptions RENAME COLUMN restaurant_id TO business_id;

-- notifications: rename restaurant_id → business_id
ALTER TABLE public.notifications RENAME COLUMN restaurant_id TO business_id;

-- notifications: rename reservation_id → booking_id
ALTER TABLE public.notifications RENAME COLUMN reservation_id TO booking_id;

-- payments: rename reservation_id → booking_id
ALTER TABLE public.payments RENAME COLUMN reservation_id TO booking_id;

-- bookings: rename payment_id FK reference (payments table stays same)
-- The FK constraint name stays, just the referenced columns are renamed

-- ── New Tables ──────────────────────────────────────────

-- Services: what a business offers
CREATE TABLE public.services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  price INTEGER NOT NULL DEFAULT 0,
  price_is_variable BOOLEAN NOT NULL DEFAULT false,
  duration_minutes INTEGER,
  max_capacity INTEGER,
  deposit_amount INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_services_business ON public.services(business_id);
CREATE TRIGGER update_services_updated_at
  BEFORE UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Products: shop/retail catalog
CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  image_url TEXT,
  category VARCHAR(100),
  stock_quantity INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_business ON public.products(business_id);
CREATE TRIGGER update_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Orders: shopping orders
CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code VARCHAR(10) UNIQUE NOT NULL,
  business_id UUID NOT NULL REFERENCES public.businesses(id),
  user_id UUID NOT NULL REFERENCES public.profiles(id),
  status order_status NOT NULL DEFAULT 'draft',
  delivery_address TEXT,
  delivery_phone VARCHAR(20),
  total_amount INTEGER NOT NULL DEFAULT 0,
  platform_fee INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  payment_id UUID REFERENCES public.payments(id),
  channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Generate order reference codes (BW-OXXXX)
CREATE OR REPLACE FUNCTION public.generate_order_reference()
RETURNS TRIGGER AS $$
DECLARE
  new_code VARCHAR(10);
  code_exists BOOLEAN;
BEGIN
  LOOP
    new_code := 'BW-O' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
    SELECT EXISTS(SELECT 1 FROM public.orders WHERE reference_code = new_code) INTO code_exists;
    EXIT WHEN NOT code_exists;
  END LOOP;
  NEW.reference_code := new_code;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_order_reference_code
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  WHEN (NEW.reference_code IS NULL OR NEW.reference_code = '')
  EXECUTE FUNCTION public.generate_order_reference();

CREATE INDEX idx_orders_business ON public.orders(business_id, created_at DESC);
CREATE INDEX idx_orders_user ON public.orders(user_id, created_at DESC);

CREATE TRIGGER update_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Order items: line items per order
CREATE TABLE public.order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_items_order ON public.order_items(order_id);

-- Events: event listings
CREATE TABLE public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name VARCHAR(300) NOT NULL,
  description TEXT,
  date DATE NOT NULL,
  time TIME,
  end_date DATE,
  end_time TIME,
  venue VARCHAR(300),
  total_tickets INTEGER NOT NULL DEFAULT 100,
  tickets_sold INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 0,
  status event_status NOT NULL DEFAULT 'draft',
  image_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_business ON public.events(business_id, date);
CREATE INDEX idx_events_status ON public.events(status, date);

CREATE TRIGGER update_events_updated_at
  BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Platform fees: fee tracking per transaction
CREATE TABLE public.platform_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id),
  booking_id UUID REFERENCES public.bookings(id),
  order_id UUID REFERENCES public.orders(id),
  transaction_amount INTEGER NOT NULL,
  fee_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  fee_flat INTEGER NOT NULL DEFAULT 0,
  fee_total INTEGER NOT NULL DEFAULT 0,
  tier subscription_tier NOT NULL DEFAULT 'free',
  waived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_platform_fees_business ON public.platform_fees(business_id, created_at DESC);

-- Add service_id FK to bookings
ALTER TABLE public.bookings
  ADD CONSTRAINT fk_bookings_service
  FOREIGN KEY (service_id) REFERENCES public.services(id);

-- ── RLS for new tables ──────────────────────────────────

ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_fees ENABLE ROW LEVEL SECURITY;

-- Services: owners manage own
CREATE POLICY "Owners manage own services"
  ON public.services FOR ALL
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

-- Products: owners manage own
CREATE POLICY "Owners manage own products"
  ON public.products FOR ALL
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

-- Orders: owners view their business's orders
CREATE POLICY "Owners view business orders"
  ON public.orders FOR SELECT
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Owners update business orders"
  ON public.orders FOR UPDATE
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

-- Order items: owners view via order
CREATE POLICY "Owners view order items"
  ON public.order_items FOR SELECT
  USING (order_id IN (
    SELECT o.id FROM public.orders o
    JOIN public.businesses b ON o.business_id = b.id
    WHERE b.owner_id = auth.uid()
  ));

-- Events: owners manage own
CREATE POLICY "Owners manage own events"
  ON public.events FOR ALL
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

-- Platform fees: owners view own
CREATE POLICY "Owners view own fees"
  ON public.platform_fees FOR SELECT
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

-- ── Update existing RLS policies for renamed tables ─────
-- Note: Postgres automatically updates policy references when tables are renamed,
-- but the policy text referencing 'restaurants' in subqueries needs updating.

-- Drop old policies that reference 'restaurants' in subqueries
DROP POLICY IF EXISTS "Owners manage own whatsapp config" ON public.whatsapp_config;
DROP POLICY IF EXISTS "Owners view restaurant reservations" ON public.bookings;
DROP POLICY IF EXISTS "Owners update restaurant reservations" ON public.bookings;
DROP POLICY IF EXISTS "Owners view restaurant payments" ON public.payments;
DROP POLICY IF EXISTS "Owners read own subscription" ON public.subscriptions;
DROP POLICY IF EXISTS "Owners view restaurant notifications" ON public.notifications;
DROP POLICY IF EXISTS "Owners manage own restaurants" ON public.businesses;

-- Recreate with correct table references
CREATE POLICY "Owners manage own businesses"
  ON public.businesses FOR ALL
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Owners manage own whatsapp config"
  ON public.whatsapp_config FOR ALL
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Owners view business bookings"
  ON public.bookings FOR SELECT
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Owners update business bookings"
  ON public.bookings FOR UPDATE
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Owners view business payments"
  ON public.payments FOR SELECT
  USING (
    booking_id IN (
      SELECT b.id FROM public.bookings b
      JOIN public.businesses biz ON b.business_id = biz.id
      WHERE biz.owner_id = auth.uid()
    )
  );

CREATE POLICY "Owners read own subscription"
  ON public.subscriptions FOR SELECT
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Owners view business notifications"
  ON public.notifications FOR SELECT
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
