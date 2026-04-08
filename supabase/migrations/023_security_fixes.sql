-- ============================================================
-- Migration 023: Security Hardening & Schema Fixes
-- ============================================================

-- ── 1. Enable RLS on processed_webhook_events ──
ALTER TABLE IF EXISTS processed_webhook_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'processed_webhook_events'
    AND policyname = 'processed_webhook_events_service_only'
  ) THEN
    CREATE POLICY "processed_webhook_events_service_only"
      ON processed_webhook_events
      FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ── 2. Fix whatsapp_channels RLS — allow owner UPDATE/DELETE ──
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'whatsapp_channels'
    AND policyname = 'Business owners can update own channel'
  ) THEN
    CREATE POLICY "Business owners can update own channel"
      ON whatsapp_channels FOR UPDATE
      USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'whatsapp_channels'
    AND policyname = 'Business owners can delete own channel'
  ) THEN
    CREATE POLICY "Business owners can delete own channel"
      ON whatsapp_channels FOR DELETE
      USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
  END IF;
END $$;

-- ── 3. Fix overly permissive RLS policies (WITH CHECK (true) → service_role only) ──

-- customer_feedback
DROP POLICY IF EXISTS "customer_feedback_service_insert" ON customer_feedback;
CREATE POLICY "customer_feedback_service_insert" ON customer_feedback
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "customer_feedback_service_update" ON customer_feedback;
CREATE POLICY "customer_feedback_service_update" ON customer_feedback
  FOR UPDATE USING (auth.role() = 'service_role');

-- loyalty_points
DROP POLICY IF EXISTS "loyalty_points_service_insert" ON loyalty_points;
CREATE POLICY "loyalty_points_service_insert" ON loyalty_points
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "loyalty_points_service_update" ON loyalty_points;
CREATE POLICY "loyalty_points_service_update" ON loyalty_points
  FOR UPDATE USING (auth.role() = 'service_role');

-- loyalty_transactions
DROP POLICY IF EXISTS "loyalty_transactions_service_insert" ON loyalty_transactions;
CREATE POLICY "loyalty_transactions_service_insert" ON loyalty_transactions
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- chat_messages
DROP POLICY IF EXISTS "chat_messages_service_insert" ON chat_messages;
CREATE POLICY "chat_messages_service_insert" ON chat_messages
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "chat_messages_service_update" ON chat_messages;
CREATE POLICY "chat_messages_service_update" ON chat_messages
  FOR UPDATE USING (auth.role() = 'service_role');

-- waitlist_entries
DROP POLICY IF EXISTS "waitlist_entries_service_insert" ON waitlist_entries;
CREATE POLICY "waitlist_entries_service_insert" ON waitlist_entries
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "waitlist_entries_service_update" ON waitlist_entries;
CREATE POLICY "waitlist_entries_service_update" ON waitlist_entries
  FOR UPDATE USING (auth.role() = 'service_role');

-- referrals
DROP POLICY IF EXISTS "referrals_service_insert" ON referrals;
CREATE POLICY "referrals_service_insert" ON referrals
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "referrals_service_update" ON referrals;
CREATE POLICY "referrals_service_update" ON referrals
  FOR UPDATE USING (auth.role() = 'service_role');

-- customer_profiles
DROP POLICY IF EXISTS "customer_profiles_service_insert" ON customer_profiles;
CREATE POLICY "customer_profiles_service_insert" ON customer_profiles
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "customer_profiles_service_update" ON customer_profiles;
CREATE POLICY "customer_profiles_service_update" ON customer_profiles
  FOR UPDATE USING (auth.role() = 'service_role');

-- booking_slots
DROP POLICY IF EXISTS "booking_slots_service_all" ON booking_slots;
CREATE POLICY "booking_slots_service_all" ON booking_slots
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── 4. Add missing indexes for performance ──

CREATE INDEX IF NOT EXISTS idx_chat_messages_business_customer_time
  ON chat_messages (business_id, customer_phone, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_unread
  ON chat_messages (business_id, is_read) WHERE is_read = false;

CREATE INDEX IF NOT EXISTS idx_loyalty_points_business_customer
  ON loyalty_points (business_id, customer_phone);

CREATE INDEX IF NOT EXISTS idx_waitlist_entries_business_status
  ON waitlist_entries (business_id, status);

CREATE INDEX IF NOT EXISTS idx_referrals_business_code
  ON referrals (business_id, referral_code);

CREATE INDEX IF NOT EXISTS idx_customer_feedback_business_rating
  ON customer_feedback (business_id, rating, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_business_status_time
  ON payments (business_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_business_user
  ON bookings (business_id, user_id, created_at DESC);

-- ── 5. Standardize phone columns to VARCHAR(20) ──
DO $$ BEGIN
  ALTER TABLE customer_feedback ALTER COLUMN customer_phone TYPE VARCHAR(20);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE customer_profiles ALTER COLUMN customer_phone TYPE VARCHAR(20);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE chat_messages ALTER COLUMN customer_phone TYPE VARCHAR(20);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE waitlist_entries ALTER COLUMN customer_phone TYPE VARCHAR(20);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE referrals ALTER COLUMN referrer_phone TYPE VARCHAR(20);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE referrals ALTER COLUMN referee_phone TYPE VARCHAR(20);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE loyalty_points ALTER COLUMN customer_phone TYPE VARCHAR(20);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE loyalty_transactions ALTER COLUMN customer_phone TYPE VARCHAR(20);
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE business_staff ALTER COLUMN phone TYPE VARCHAR(20);
EXCEPTION WHEN others THEN NULL;
END $$;

-- ── 6. Add check constraints for data integrity ──
DO $$ BEGIN
  ALTER TABLE loyalty_points ADD CONSTRAINT chk_loyalty_points_balance
    CHECK (points_balance >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE loyalty_points ADD CONSTRAINT chk_loyalty_total_earned
    CHECK (total_earned >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE customer_feedback ADD CONSTRAINT chk_feedback_rating
    CHECK (rating >= 1 AND rating <= 5);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 7. Add soft delete columns to important tables ──
ALTER TABLE payments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE loyalty_points ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ── 8. Add updated_at trigger to processed_webhook_events ──
ALTER TABLE processed_webhook_events
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$ BEGIN
  CREATE TRIGGER set_processed_webhook_events_updated_at
    BEFORE UPDATE ON processed_webhook_events
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
