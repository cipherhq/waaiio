-- ═══════════════════════════════════════════════════════
-- Waaiio Database Schema
-- Single migration for fresh Supabase project
-- ═══════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ═══════════════════════════════════════
-- ENUM TYPES
-- ═══════════════════════════════════════

CREATE TYPE user_role AS ENUM ('restaurant_owner', 'restaurant_staff');
CREATE TYPE restaurant_status AS ENUM ('pending', 'active', 'suspended');
CREATE TYPE whatsapp_plan AS ENUM ('starter', 'professional', 'enterprise');
CREATE TYPE reservation_status AS ENUM ('pending', 'confirmed', 'seated', 'completed', 'no_show', 'cancelled');
CREATE TYPE booking_channel AS ENUM ('whatsapp', 'web');
CREATE TYPE deposit_status AS ENUM ('none', 'pending', 'paid', 'refunded', 'forfeited');
CREATE TYPE payment_status AS ENUM ('pending', 'success', 'failed', 'refunded');
CREATE TYPE cancelled_by AS ENUM ('diner', 'restaurant', 'system');
CREATE TYPE subscription_status AS ENUM ('active', 'past_due', 'cancelled');
CREATE TYPE notification_type AS ENUM ('booking_confirmation', 'reminder_24h', 'reminder_2h', 'payment', 'system');
CREATE TYPE notification_channel AS ENUM ('whatsapp', 'sms', 'email');
CREATE TYPE notification_status AS ENUM ('queued', 'sent', 'delivered', 'failed');

-- ═══════════════════════════════════════
-- PROFILES (extends Supabase Auth)
-- ═══════════════════════════════════════

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone VARCHAR(20) UNIQUE,
  email VARCHAR(255),
  first_name VARCHAR(100) NOT NULL DEFAULT '',
  last_name VARCHAR(100) NOT NULL DEFAULT '',
  avatar_url TEXT,
  role user_role NOT NULL DEFAULT 'restaurant_owner',
  notification_prefs JSONB NOT NULL DEFAULT '{"whatsapp": true, "sms": true, "email": true}'::jsonb,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-create profile on auth.users insert
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, phone, email)
  VALUES (NEW.id, NEW.phone, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ═══════════════════════════════════════
-- RESTAURANTS
-- ═══════════════════════════════════════

CREATE TABLE public.restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(200) UNIQUE NOT NULL,
  description TEXT,
  cuisine_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  address TEXT NOT NULL,
  city VARCHAR(50) NOT NULL,
  neighborhood VARCHAR(100) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(255),
  status restaurant_status NOT NULL DEFAULT 'pending',
  whatsapp_plan whatsapp_plan,
  is_whitelabel BOOLEAN NOT NULL DEFAULT false,
  operating_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  deposit_per_guest INTEGER NOT NULL DEFAULT 0,
  cancellation_window_hours INTEGER NOT NULL DEFAULT 4,
  max_advance_booking_days INTEGER NOT NULL DEFAULT 30,
  rating_avg DECIMAL(2, 1) NOT NULL DEFAULT 0.0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  total_bookings INTEGER NOT NULL DEFAULT 0,
  logo_url TEXT,
  cover_photo_url TEXT,
  menu_url TEXT,
  instagram_handle VARCHAR(100),
  bot_code VARCHAR(30) UNIQUE,
  gupshup_app_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_restaurants_updated_at
  BEFORE UPDATE ON public.restaurants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE INDEX idx_restaurants_city ON public.restaurants(city, neighborhood);
CREATE INDEX idx_restaurants_status ON public.restaurants(status);
CREATE INDEX idx_restaurants_slug ON public.restaurants USING hash(slug);
CREATE INDEX idx_restaurants_owner ON public.restaurants(owner_id);
CREATE UNIQUE INDEX idx_restaurants_bot_code ON public.restaurants(bot_code) WHERE bot_code IS NOT NULL;
CREATE INDEX idx_restaurants_name_trgm ON public.restaurants USING gin(name gin_trgm_ops);

-- ═══════════════════════════════════════
-- WHATSAPP CONFIG
-- ═══════════════════════════════════════

CREATE TABLE public.whatsapp_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL UNIQUE REFERENCES public.restaurants(id) ON DELETE CASCADE,
  bot_greeting TEXT NOT NULL DEFAULT 'Welcome! Let''s book you a table.',
  bot_confirmation_template TEXT NOT NULL DEFAULT E'\\u2705 Booking Confirmed!\\n\\n\\ud83c\\udf7d\\ufe0f {restaurant_name}\\n\\ud83d\\udcc5 {date}\\n\\ud83d\\udd50 {time}\\n\\ud83d\\udc65 {party_size} guests\\n\\ud83d\\udd11 Ref: {reference_code}',
  bot_reminder_template TEXT NOT NULL DEFAULT E'\\u23f0 Reminder\\n\\nYour reservation at {restaurant_name} is tomorrow at {time} for {party_size} guests.\\n\\nRef: {reference_code}',
  bot_alias VARCHAR(50) DEFAULT NULL,
  auto_confirm BOOLEAN NOT NULL DEFAULT true,
  welcome_image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_whatsapp_config_restaurant ON public.whatsapp_config(restaurant_id);

CREATE TRIGGER update_whatsapp_config_updated_at
  BEFORE UPDATE ON public.whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ═══════════════════════════════════════
-- BOT SESSIONS
-- ═══════════════════════════════════════

CREATE TABLE public.bot_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) NOT NULL,
  restaurant_id UUID REFERENCES public.restaurants(id) ON DELETE SET NULL,
  step VARCHAR(50) NOT NULL DEFAULT 'greeting',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_bot_sessions_phone_restaurant
  ON public.bot_sessions(phone, restaurant_id) WHERE restaurant_id IS NOT NULL;
CREATE INDEX idx_bot_sessions_phone ON public.bot_sessions(phone);

CREATE TRIGGER update_bot_sessions_updated_at
  BEFORE UPDATE ON public.bot_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ═══════════════════════════════════════
-- RESERVATIONS
-- ═══════════════════════════════════════

CREATE TABLE public.reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code VARCHAR(10) UNIQUE NOT NULL,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id),
  user_id UUID NOT NULL REFERENCES public.profiles(id),
  date DATE NOT NULL,
  time TIME NOT NULL,
  end_time TIME GENERATED ALWAYS AS (time + INTERVAL '2 hours') STORED,
  party_size INTEGER NOT NULL CHECK (party_size > 0),
  status reservation_status NOT NULL DEFAULT 'pending',
  channel booking_channel NOT NULL DEFAULT 'whatsapp',
  special_requests TEXT,
  guest_name VARCHAR(100),
  guest_phone VARCHAR(20),
  guest_email VARCHAR(255),
  deposit_amount INTEGER NOT NULL DEFAULT 0,
  deposit_status deposit_status NOT NULL DEFAULT 'none',
  payment_id UUID,
  confirmed_at TIMESTAMPTZ,
  seated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_by cancelled_by,
  cancellation_reason TEXT,
  no_show_marked_at TIMESTAMPTZ,
  reminder_24h_sent BOOLEAN NOT NULL DEFAULT false,
  reminder_2h_sent BOOLEAN NOT NULL DEFAULT false,
  feedback_requested BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_reservations_updated_at
  BEFORE UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Generate unique reference code (BW- prefix)
CREATE OR REPLACE FUNCTION public.generate_reference_code()
RETURNS TRIGGER AS $$
DECLARE
  new_code VARCHAR(10);
  code_exists BOOLEAN;
BEGIN
  LOOP
    new_code := 'BW-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
    SELECT EXISTS(SELECT 1 FROM public.reservations WHERE reference_code = new_code) INTO code_exists;
    EXIT WHEN NOT code_exists;
  END LOOP;
  NEW.reference_code := new_code;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_reference_code
  BEFORE INSERT ON public.reservations
  FOR EACH ROW
  WHEN (NEW.reference_code IS NULL OR NEW.reference_code = '')
  EXECUTE FUNCTION public.generate_reference_code();

-- Indexes
CREATE INDEX idx_reservations_restaurant_date ON public.reservations(restaurant_id, date, status) WHERE status NOT IN ('cancelled');
CREATE INDEX idx_reservations_user_date ON public.reservations(user_id, date DESC);
CREATE INDEX idx_reservations_reference ON public.reservations USING hash(reference_code);
CREATE INDEX idx_reservations_status ON public.reservations(status, date);
CREATE INDEX idx_reservations_reminder ON public.reservations(date, reminder_24h_sent) WHERE status = 'confirmed' AND reminder_24h_sent = false;

ALTER PUBLICATION supabase_realtime ADD TABLE public.reservations;

-- ═══════════════════════════════════════
-- PAYMENTS
-- ═══════════════════════════════════════

CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID REFERENCES public.reservations(id),
  user_id UUID REFERENCES public.profiles(id),
  amount INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
  gateway_reference VARCHAR(100) UNIQUE NOT NULL,
  gateway_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  payment_method VARCHAR(20),
  card_last_four VARCHAR(4),
  card_brand VARCHAR(20),
  status payment_status NOT NULL DEFAULT 'pending',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add FK from reservations to payments
ALTER TABLE public.reservations ADD CONSTRAINT fk_reservations_payment
  FOREIGN KEY (payment_id) REFERENCES public.payments(id);

CREATE INDEX idx_payments_gateway_ref ON public.payments USING hash(gateway_reference);
CREATE INDEX idx_payments_reservation ON public.payments(reservation_id);

-- ═══════════════════════════════════════
-- SUBSCRIPTIONS
-- ═══════════════════════════════════════

CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  plan VARCHAR(20) NOT NULL,
  status subscription_status NOT NULL DEFAULT 'active',
  amount INTEGER NOT NULL,
  paystack_subscription_code VARCHAR(100),
  paystack_customer_code VARCHAR(100),
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_restaurant ON public.subscriptions(restaurant_id);

CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ═══════════════════════════════════════
-- NOTIFICATIONS
-- ═══════════════════════════════════════

CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES public.restaurants(id) ON DELETE CASCADE,
  reservation_id UUID REFERENCES public.reservations(id) ON DELETE SET NULL,
  recipient_phone VARCHAR(20),
  recipient_email VARCHAR(255),
  type notification_type NOT NULL,
  channel notification_channel NOT NULL,
  status notification_status NOT NULL DEFAULT 'queued',
  subject TEXT,
  body TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_restaurant ON public.notifications(restaurant_id, created_at DESC);
CREATE INDEX idx_notifications_reservation ON public.notifications(reservation_id);

-- ═══════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Profiles: users manage own profile
CREATE POLICY "Users manage own profile"
  ON public.profiles FOR ALL
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Restaurants: owners manage own restaurants
CREATE POLICY "Owners manage own restaurants"
  ON public.restaurants FOR ALL
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- WhatsApp config: owners manage own, service role reads all
CREATE POLICY "Owners manage own whatsapp config"
  ON public.whatsapp_config FOR ALL
  USING (restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid()))
  WITH CHECK (restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid()));

-- Bot sessions: service role only (no direct user access needed)
-- The service role key bypasses RLS, so no policies needed for bot

-- Reservations: owners see their restaurant's reservations
CREATE POLICY "Owners view restaurant reservations"
  ON public.reservations FOR SELECT
  USING (restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid()));

CREATE POLICY "Owners update restaurant reservations"
  ON public.reservations FOR UPDATE
  USING (restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid()));

-- Payments: owners see their restaurant's payments
CREATE POLICY "Owners view restaurant payments"
  ON public.payments FOR SELECT
  USING (
    reservation_id IN (
      SELECT r.id FROM public.reservations r
      JOIN public.restaurants rest ON r.restaurant_id = rest.id
      WHERE rest.owner_id = auth.uid()
    )
  );

-- Subscriptions: owners see own
CREATE POLICY "Owners read own subscription"
  ON public.subscriptions FOR SELECT
  USING (restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid()));

-- Notifications: owners see own restaurant's
CREATE POLICY "Owners view restaurant notifications"
  ON public.notifications FOR SELECT
  USING (restaurant_id IN (SELECT id FROM public.restaurants WHERE owner_id = auth.uid()));
