-- ═══════════════════════════════════════════════════════
-- Migration 020: New Capabilities (Feedback, Loyalty, Chat, Waitlist, Referral, Staff, Inventory)
-- ═══════════════════════════════════════════════════════

-- 1. Extend capability_type enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'feedback' AND enumtypid = 'capability_type'::regtype) THEN
    ALTER TYPE capability_type ADD VALUE 'feedback';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'loyalty' AND enumtypid = 'capability_type'::regtype) THEN
    ALTER TYPE capability_type ADD VALUE 'loyalty';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'chat' AND enumtypid = 'capability_type'::regtype) THEN
    ALTER TYPE capability_type ADD VALUE 'chat';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'waitlist' AND enumtypid = 'capability_type'::regtype) THEN
    ALTER TYPE capability_type ADD VALUE 'waitlist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'referral' AND enumtypid = 'capability_type'::regtype) THEN
    ALTER TYPE capability_type ADD VALUE 'referral';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'staff' AND enumtypid = 'capability_type'::regtype) THEN
    ALTER TYPE capability_type ADD VALUE 'staff';
  END IF;
END$$;

-- 2. Customer Feedback table
CREATE TABLE IF NOT EXISTS customer_feedback (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  customer_name text,
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  queue_entry_id uuid REFERENCES queue_entries(id) ON DELETE SET NULL,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment text,
  service_type text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_feedback_business ON customer_feedback(business_id);
CREATE INDEX IF NOT EXISTS idx_customer_feedback_rating ON customer_feedback(business_id, rating);
CREATE INDEX IF NOT EXISTS idx_customer_feedback_created ON customer_feedback(business_id, created_at DESC);

-- 3. Loyalty Points table
CREATE TABLE IF NOT EXISTS loyalty_points (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  customer_name text,
  points_balance integer DEFAULT 0 NOT NULL,
  total_earned integer DEFAULT 0 NOT NULL,
  total_redeemed integer DEFAULT 0 NOT NULL,
  visit_count integer DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(business_id, customer_phone)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_points_business ON loyalty_points(business_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_points_phone ON loyalty_points(business_id, customer_phone);

-- 4. Loyalty Transactions table
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  points_change integer NOT NULL,
  reason text NOT NULL CHECK (reason IN ('visit', 'purchase', 'redemption', 'bonus', 'referral')),
  reference_id text,
  reference_type text,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_business ON loyalty_transactions(business_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_phone ON loyalty_transactions(business_id, customer_phone);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_created ON loyalty_transactions(business_id, created_at DESC);

-- 5. Chat Messages table
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  customer_name text,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_text text NOT NULL,
  is_read boolean DEFAULT false NOT NULL,
  staff_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_business ON chat_messages(business_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(business_id, customer_phone, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_unread ON chat_messages(business_id, is_read) WHERE is_read = false;

-- Enable realtime for chat_messages
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;

-- 6. Waitlist Entries table
CREATE TABLE IF NOT EXISTS waitlist_entries (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  customer_name text,
  service_id uuid REFERENCES services(id) ON DELETE SET NULL,
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  preferred_date date,
  status text DEFAULT 'waiting' NOT NULL CHECK (status IN ('waiting', 'notified', 'converted', 'expired')),
  notified_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_waitlist_entries_business ON waitlist_entries(business_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_entries_status ON waitlist_entries(business_id, status);
CREATE INDEX IF NOT EXISTS idx_waitlist_entries_phone ON waitlist_entries(business_id, customer_phone);

-- 7. Referrals table
CREATE TABLE IF NOT EXISTS referrals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  referrer_phone text NOT NULL,
  referrer_name text,
  referee_phone text,
  referral_code text NOT NULL,
  status text DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'converted', 'rewarded', 'expired')),
  reward_type text,
  reward_amount numeric(12,2),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(business_id, referral_code)
);

CREATE INDEX IF NOT EXISTS idx_referrals_business ON referrals(business_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(business_id, referrer_phone);

-- 8. Business Staff table
CREATE TABLE IF NOT EXISTS business_staff (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name text NOT NULL,
  phone text,
  email text,
  role text DEFAULT 'staff' NOT NULL CHECK (role IN ('staff', 'manager')),
  is_active boolean DEFAULT true NOT NULL,
  services text[] DEFAULT '{}',
  schedule jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_business_staff_business ON business_staff(business_id);
CREATE INDEX IF NOT EXISTS idx_business_staff_active ON business_staff(business_id) WHERE is_active = true;

-- 9. Products table enhancements for inventory tracking
ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_threshold integer DEFAULT 5;
ALTER TABLE products ADD COLUMN IF NOT EXISTS track_inventory boolean DEFAULT false;

-- 10. Stock decrement RPC
CREATE OR REPLACE FUNCTION decrement_stock(p_product_id uuid, qty integer)
RETURNS void AS $$
BEGIN
  UPDATE products
  SET stock_quantity = GREATEST(0, COALESCE(stock_quantity, 0) - qty)
  WHERE id = p_product_id AND track_inventory = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 11. RLS Policies — owner CRUD pattern

-- customer_feedback
ALTER TABLE customer_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_feedback_owner_select" ON customer_feedback
  FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "customer_feedback_owner_insert" ON customer_feedback
  FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "customer_feedback_owner_update" ON customer_feedback
  FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "customer_feedback_owner_delete" ON customer_feedback
  FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
-- Service role can insert (bot creates feedback entries)
CREATE POLICY "customer_feedback_service_insert" ON customer_feedback
  FOR INSERT WITH CHECK (true);

-- loyalty_points
ALTER TABLE loyalty_points ENABLE ROW LEVEL SECURITY;

CREATE POLICY "loyalty_points_owner_select" ON loyalty_points
  FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "loyalty_points_owner_insert" ON loyalty_points
  FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "loyalty_points_owner_update" ON loyalty_points
  FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "loyalty_points_owner_delete" ON loyalty_points
  FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "loyalty_points_service_insert" ON loyalty_points
  FOR INSERT WITH CHECK (true);
CREATE POLICY "loyalty_points_service_update" ON loyalty_points
  FOR UPDATE USING (true);

-- loyalty_transactions
ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "loyalty_transactions_owner_select" ON loyalty_transactions
  FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "loyalty_transactions_owner_insert" ON loyalty_transactions
  FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "loyalty_transactions_service_insert" ON loyalty_transactions
  FOR INSERT WITH CHECK (true);

-- chat_messages
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chat_messages_owner_select" ON chat_messages
  FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "chat_messages_owner_insert" ON chat_messages
  FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "chat_messages_owner_update" ON chat_messages
  FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "chat_messages_service_insert" ON chat_messages
  FOR INSERT WITH CHECK (true);

-- waitlist_entries
ALTER TABLE waitlist_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "waitlist_entries_owner_select" ON waitlist_entries
  FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "waitlist_entries_owner_insert" ON waitlist_entries
  FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "waitlist_entries_owner_update" ON waitlist_entries
  FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "waitlist_entries_owner_delete" ON waitlist_entries
  FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "waitlist_entries_service_insert" ON waitlist_entries
  FOR INSERT WITH CHECK (true);

-- referrals
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "referrals_owner_select" ON referrals
  FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "referrals_owner_insert" ON referrals
  FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "referrals_owner_update" ON referrals
  FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "referrals_owner_delete" ON referrals
  FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "referrals_service_insert" ON referrals
  FOR INSERT WITH CHECK (true);
CREATE POLICY "referrals_service_update" ON referrals
  FOR UPDATE USING (true);

-- business_staff
ALTER TABLE business_staff ENABLE ROW LEVEL SECURITY;

CREATE POLICY "business_staff_owner_select" ON business_staff
  FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "business_staff_owner_insert" ON business_staff
  FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "business_staff_owner_update" ON business_staff
  FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "business_staff_owner_delete" ON business_staff
  FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- 12. Updated_at triggers for new tables
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_customer_feedback_updated_at') THEN
    CREATE TRIGGER trg_customer_feedback_updated_at
      BEFORE UPDATE ON customer_feedback FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_loyalty_points_updated_at') THEN
    CREATE TRIGGER trg_loyalty_points_updated_at
      BEFORE UPDATE ON loyalty_points FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_waitlist_entries_updated_at') THEN
    CREATE TRIGGER trg_waitlist_entries_updated_at
      BEFORE UPDATE ON waitlist_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_referrals_updated_at') THEN
    CREATE TRIGGER trg_referrals_updated_at
      BEFORE UPDATE ON referrals FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_business_staff_updated_at') THEN
    CREATE TRIGGER trg_business_staff_updated_at
      BEFORE UPDATE ON business_staff FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END$$;
