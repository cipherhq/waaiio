-- ═══════════════════════════════════════════════════════
-- Migration 021: Product Enhancements
-- Idempotency, Promo Codes, Customer Profiles, Booking Slots,
-- Notification Prefs, Webhook Endpoints, Business Locations,
-- Audit Log, Soft Deletes, Deposits, FAQ Config
-- ═══════════════════════════════════════════════════════

-- 1. Processed Webhook Events (idempotency)
CREATE TABLE IF NOT EXISTS processed_webhook_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  gateway text NOT NULL,
  event_type text NOT NULL,
  processed_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_webhook_event_id ON processed_webhook_events(event_id);

-- 2. Promo Codes
CREATE TABLE IF NOT EXISTS promo_codes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code text NOT NULL,
  description text,
  discount_type text NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value numeric(12,2) NOT NULL,
  min_order_amount numeric(12,2) DEFAULT 0,
  max_uses integer,
  current_uses integer DEFAULT 0 NOT NULL,
  valid_from timestamptz DEFAULT now() NOT NULL,
  valid_until timestamptz,
  is_active boolean DEFAULT true NOT NULL,
  applicable_services uuid[] DEFAULT '{}',
  applicable_flow_types text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(business_id, code)
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_business ON promo_codes(business_id);
CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(business_id, code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(business_id) WHERE is_active = true;

-- 3. Customer Profiles (aggregated view)
CREATE TABLE IF NOT EXISTS customer_profiles (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone text NOT NULL,
  name text,
  email text,
  first_seen_at timestamptz DEFAULT now() NOT NULL,
  last_seen_at timestamptz DEFAULT now() NOT NULL,
  total_bookings integer DEFAULT 0 NOT NULL,
  total_orders integer DEFAULT 0 NOT NULL,
  total_spent numeric(12,2) DEFAULT 0 NOT NULL,
  total_visits integer DEFAULT 0 NOT NULL,
  avg_rating numeric(3,2),
  tags text[] DEFAULT '{}',
  notes text,
  notification_opt_in boolean DEFAULT true NOT NULL,
  preferred_channel text DEFAULT 'whatsapp' CHECK (preferred_channel IN ('whatsapp', 'sms', 'email')),
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(business_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_business ON customer_profiles(business_id);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_phone ON customer_profiles(business_id, phone);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_last_seen ON customer_profiles(business_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_spent ON customer_profiles(business_id, total_spent DESC);

-- 4. Booking Slots (overbooking prevention)
CREATE TABLE IF NOT EXISTS booking_slots (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id uuid,
  staff_id uuid,
  date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  max_bookings integer DEFAULT 1 NOT NULL,
  current_bookings integer DEFAULT 0 NOT NULL,
  is_blocked boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_slots_unique
  ON booking_slots (business_id, date, start_time, COALESCE(staff_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS idx_booking_slots_lookup ON booking_slots(business_id, date, start_time);
CREATE INDEX IF NOT EXISTS idx_booking_slots_available ON booking_slots(business_id, date) WHERE current_bookings < max_bookings AND is_blocked = false;

-- Atomic slot reservation function
CREATE OR REPLACE FUNCTION reserve_booking_slot(
  p_business_id uuid,
  p_date date,
  p_start_time time,
  p_end_time time,
  p_staff_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_max_bookings integer DEFAULT 1
) RETURNS boolean AS $$
DECLARE
  v_slot_id uuid;
  v_current integer;
BEGIN
  -- Try to get existing slot with row lock
  SELECT id, current_bookings INTO v_slot_id, v_current
  FROM booking_slots
  WHERE business_id = p_business_id
    AND date = p_date
    AND start_time = p_start_time
    AND COALESCE(staff_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(p_staff_id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(p_location_id, '00000000-0000-0000-0000-000000000000'::uuid)
  FOR UPDATE;

  IF v_slot_id IS NOT NULL THEN
    IF v_current >= p_max_bookings THEN
      RETURN false; -- Slot full
    END IF;
    UPDATE booking_slots SET current_bookings = current_bookings + 1 WHERE id = v_slot_id;
    RETURN true;
  END IF;

  -- Create new slot
  INSERT INTO booking_slots (business_id, date, start_time, end_time, max_bookings, current_bookings, staff_id, location_id)
  VALUES (p_business_id, p_date, p_start_time, p_end_time, p_max_bookings, 1, p_staff_id, p_location_id);
  RETURN true;

EXCEPTION WHEN unique_violation THEN
  -- Race condition: another request created the slot, retry
  SELECT id, current_bookings INTO v_slot_id, v_current
  FROM booking_slots
  WHERE business_id = p_business_id
    AND date = p_date
    AND start_time = p_start_time
  FOR UPDATE;

  IF v_current >= p_max_bookings THEN
    RETURN false;
  END IF;
  UPDATE booking_slots SET current_bookings = current_bookings + 1 WHERE id = v_slot_id;
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Release slot function (for cancellations)
CREATE OR REPLACE FUNCTION release_booking_slot(
  p_business_id uuid,
  p_date date,
  p_start_time time,
  p_staff_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL
) RETURNS void AS $$
BEGIN
  UPDATE booking_slots
  SET current_bookings = GREATEST(0, current_bookings - 1)
  WHERE business_id = p_business_id
    AND date = p_date
    AND start_time = p_start_time
    AND COALESCE(staff_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(p_staff_id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(p_location_id, '00000000-0000-0000-0000-000000000000'::uuid);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Webhook Endpoints (integrations)
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret text,
  events text[] NOT NULL DEFAULT '{}',
  is_active boolean DEFAULT true NOT NULL,
  last_triggered_at timestamptz,
  failure_count integer DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_business ON webhook_endpoints(business_id);

-- Webhook delivery log
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  response_status integer,
  response_body text,
  success boolean DEFAULT false NOT NULL,
  attempted_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, attempted_at DESC);

-- 6. Business Locations (multi-location)
CREATE TABLE IF NOT EXISTS business_locations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text NOT NULL,
  city text,
  phone text,
  operating_hours jsonb DEFAULT '{}'::jsonb NOT NULL,
  is_primary boolean DEFAULT false NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  latitude numeric(10,7),
  longitude numeric(10,7),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_business_locations_business ON business_locations(business_id);

-- 7. Audit Log
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  changes jsonb,
  ip_address text,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_business ON audit_log(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(business_id, entity_type, entity_id);

-- 8. FAQ Entries (AI auto-responder)
CREATE TABLE IF NOT EXISTS business_faq (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  keywords text[] DEFAULT '{}',
  is_active boolean DEFAULT true NOT NULL,
  hit_count integer DEFAULT 0 NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_business_faq_business ON business_faq(business_id);

-- 9. Daily Summary Log (prevent duplicate sends)
CREATE TABLE IF NOT EXISTS daily_summary_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  summary_date date NOT NULL,
  sent_at timestamptz DEFAULT now() NOT NULL,
  metrics jsonb,
  UNIQUE(business_id, summary_date)
);

-- 10. Soft Deletes — add deleted_at to key tables
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE services ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_bookings_not_deleted ON bookings(business_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_not_deleted ON orders(business_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_services_not_deleted ON services(business_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_not_deleted ON products(business_id) WHERE deleted_at IS NULL;

-- 11. Deposit enhancements on services
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_percentage integer DEFAULT 0;
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_required boolean DEFAULT false;

-- 12. Booking enhancements
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES business_locations(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS staff_id uuid REFERENCES business_staff(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS staff_name text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS promo_code_id uuid REFERENCES promo_codes(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_amount integer DEFAULT 0;

-- 13. Order enhancements
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code_id uuid REFERENCES promo_codes(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount integer DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES business_locations(id) ON DELETE SET NULL;

-- 14. Promo code usage increment function
CREATE OR REPLACE FUNCTION increment_promo_usage(p_code_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE promo_codes
  SET current_uses = current_uses + 1
  WHERE id = p_code_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 15. Upsert customer profile function (called after every interaction)
CREATE OR REPLACE FUNCTION upsert_customer_profile(
  p_business_id uuid,
  p_phone text,
  p_name text DEFAULT NULL,
  p_booking_amount numeric DEFAULT 0,
  p_is_booking boolean DEFAULT false,
  p_is_order boolean DEFAULT false
) RETURNS uuid AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO customer_profiles (business_id, phone, name, total_bookings, total_orders, total_spent, total_visits, last_seen_at)
  VALUES (
    p_business_id,
    p_phone,
    p_name,
    CASE WHEN p_is_booking THEN 1 ELSE 0 END,
    CASE WHEN p_is_order THEN 1 ELSE 0 END,
    p_booking_amount,
    1,
    now()
  )
  ON CONFLICT (business_id, phone) DO UPDATE SET
    name = COALESCE(EXCLUDED.name, customer_profiles.name),
    total_bookings = customer_profiles.total_bookings + CASE WHEN p_is_booking THEN 1 ELSE 0 END,
    total_orders = customer_profiles.total_orders + CASE WHEN p_is_order THEN 1 ELSE 0 END,
    total_spent = customer_profiles.total_spent + p_booking_amount,
    total_visits = customer_profiles.total_visits + 1,
    last_seen_at = now(),
    updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 16. RLS Policies

-- promo_codes
ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "promo_codes_owner_select" ON promo_codes FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "promo_codes_owner_insert" ON promo_codes FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "promo_codes_owner_update" ON promo_codes FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "promo_codes_owner_delete" ON promo_codes FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "promo_codes_service_select" ON promo_codes FOR SELECT USING (true);

-- customer_profiles
ALTER TABLE customer_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_profiles_owner_select" ON customer_profiles FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "customer_profiles_owner_insert" ON customer_profiles FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "customer_profiles_owner_update" ON customer_profiles FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "customer_profiles_owner_delete" ON customer_profiles FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "customer_profiles_service_insert" ON customer_profiles FOR INSERT WITH CHECK (true);
CREATE POLICY "customer_profiles_service_update" ON customer_profiles FOR UPDATE USING (true);

-- booking_slots
ALTER TABLE booking_slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "booking_slots_owner_select" ON booking_slots FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "booking_slots_owner_insert" ON booking_slots FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "booking_slots_owner_update" ON booking_slots FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "booking_slots_owner_delete" ON booking_slots FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "booking_slots_service_all" ON booking_slots FOR ALL USING (true);

-- webhook_endpoints
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "webhook_endpoints_owner_select" ON webhook_endpoints FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "webhook_endpoints_owner_insert" ON webhook_endpoints FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "webhook_endpoints_owner_update" ON webhook_endpoints FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "webhook_endpoints_owner_delete" ON webhook_endpoints FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- webhook_deliveries
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "webhook_deliveries_owner_select" ON webhook_deliveries FOR SELECT USING (endpoint_id IN (SELECT id FROM webhook_endpoints WHERE business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())));

-- business_locations
ALTER TABLE business_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "business_locations_owner_select" ON business_locations FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "business_locations_owner_insert" ON business_locations FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "business_locations_owner_update" ON business_locations FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "business_locations_owner_delete" ON business_locations FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- audit_log
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_log_owner_select" ON audit_log FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "audit_log_service_insert" ON audit_log FOR INSERT WITH CHECK (true);

-- business_faq
ALTER TABLE business_faq ENABLE ROW LEVEL SECURITY;
CREATE POLICY "business_faq_owner_select" ON business_faq FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "business_faq_owner_insert" ON business_faq FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "business_faq_owner_update" ON business_faq FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "business_faq_owner_delete" ON business_faq FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "business_faq_service_select" ON business_faq FOR SELECT USING (true);

-- daily_summary_log
ALTER TABLE daily_summary_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "daily_summary_log_owner_select" ON daily_summary_log FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "daily_summary_log_service_insert" ON daily_summary_log FOR INSERT WITH CHECK (true);

-- processed_webhook_events — no RLS needed, service role only
ALTER TABLE processed_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "processed_webhook_events_service_all" ON processed_webhook_events FOR ALL USING (true);

-- 17. Updated_at triggers
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_promo_codes_updated_at') THEN
    CREATE TRIGGER trg_promo_codes_updated_at
      BEFORE UPDATE ON promo_codes FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_customer_profiles_updated_at') THEN
    CREATE TRIGGER trg_customer_profiles_updated_at
      BEFORE UPDATE ON customer_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_webhook_endpoints_updated_at') THEN
    CREATE TRIGGER trg_webhook_endpoints_updated_at
      BEFORE UPDATE ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_business_locations_updated_at') THEN
    CREATE TRIGGER trg_business_locations_updated_at
      BEFORE UPDATE ON business_locations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_business_faq_updated_at') THEN
    CREATE TRIGGER trg_business_faq_updated_at
      BEFORE UPDATE ON business_faq FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END$$;
