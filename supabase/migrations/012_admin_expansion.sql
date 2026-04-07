-- 012_admin_expansion.sql
-- New tables and RLS policies for full admin platform management

-- ============================================================
-- 1. SUPPORT TICKETS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  priority VARCHAR(10) NOT NULL DEFAULT 'medium',
  category VARCHAR(50),
  requester_id UUID NOT NULL REFERENCES public.profiles(id),
  requester_type VARCHAR(20) NOT NULL DEFAULT 'user',
  business_id UUID REFERENCES public.businesses(id),
  assigned_to UUID REFERENCES public.profiles(id),
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_requester ON public.support_tickets(requester_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned ON public.support_tickets(assigned_to);

-- ============================================================
-- 2. SUPPORT TICKET MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.support_ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.profiles(id),
  message TEXT NOT NULL,
  is_internal BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON public.support_ticket_messages(ticket_id);

-- ============================================================
-- 3. IMPERSONATION LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.impersonation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES public.profiles(id),
  admin_email VARCHAR(255) NOT NULL,
  target_business_id UUID NOT NULL REFERENCES public.businesses(id),
  target_business_name VARCHAR(255),
  action VARCHAR(50) NOT NULL,
  changes JSONB DEFAULT '{}',
  ip_address VARCHAR(45),
  session_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_impersonation_admin ON public.impersonation_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_impersonation_business ON public.impersonation_logs(target_business_id);

-- ============================================================
-- 4. PLATFORM SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  description TEXT,
  updated_by UUID REFERENCES public.profiles(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.platform_settings (key, value, description) VALUES
  ('platform_fee_percentage', '15', 'Default platform fee %'),
  ('supported_countries', '["NG","GH","US","UK","CA"]', 'Active country codes'),
  ('supported_currencies', '{"NG":"NGN","GH":"GHS","US":"USD","UK":"GBP","CA":"CAD"}', 'Currency map'),
  ('maintenance_mode', 'false', 'Enable maintenance mode'),
  ('min_app_version', '"1.0.0"', 'Minimum client app version'),
  ('terms_version', '"1.0"', 'Current ToS version'),
  ('privacy_version', '"1.0"', 'Current privacy policy version'),
  ('support_email', '"support@waaiio.com"', 'Support contact email'),
  ('max_bot_sessions_per_business', '1000', 'Monthly bot session limit')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 5. ADMIN BROADCASTS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.admin_broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES public.profiles(id),
  channel VARCHAR(20) NOT NULL,
  audience VARCHAR(20) NOT NULL,
  audience_filter JSONB DEFAULT '{}',
  subject VARCHAR(200),
  message TEXT NOT NULL,
  recipient_count INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 6. ENABLE RLS ON NEW TABLES
-- ============================================================
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.impersonation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_broadcasts ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 7. RLS POLICIES — Admin full access on new tables
-- ============================================================

-- Helper: check if current user is admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Support tickets
CREATE POLICY "admin_all_support_tickets" ON public.support_tickets
  FOR ALL USING (public.is_admin());

-- Support ticket messages
CREATE POLICY "admin_all_ticket_messages" ON public.support_ticket_messages
  FOR ALL USING (public.is_admin());

-- Impersonation logs
CREATE POLICY "admin_all_impersonation_logs" ON public.impersonation_logs
  FOR ALL USING (public.is_admin());

-- Platform settings
CREATE POLICY "admin_all_platform_settings" ON public.platform_settings
  FOR ALL USING (public.is_admin());

-- Admin broadcasts
CREATE POLICY "admin_all_broadcasts" ON public.admin_broadcasts
  FOR ALL USING (public.is_admin());

-- ============================================================
-- 8. RLS POLICIES — Admin SELECT on existing tables
-- ============================================================

-- Profiles: admin can read all + update for user management
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_profiles' AND tablename = 'profiles') THEN
    CREATE POLICY "admin_select_profiles" ON public.profiles FOR SELECT USING (public.is_admin());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_update_profiles' AND tablename = 'profiles') THEN
    CREATE POLICY "admin_update_profiles" ON public.profiles FOR UPDATE USING (public.is_admin());
  END IF;
END $$;

-- Bookings
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_bookings' AND tablename = 'bookings') THEN
    CREATE POLICY "admin_select_bookings" ON public.bookings FOR SELECT USING (public.is_admin());
  END IF;
END $$;

-- Orders
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_orders' AND tablename = 'orders') THEN
    CREATE POLICY "admin_select_orders" ON public.orders FOR SELECT USING (public.is_admin());
  END IF;
END $$;

-- Payments
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_payments' AND tablename = 'payments') THEN
    CREATE POLICY "admin_select_payments" ON public.payments FOR SELECT USING (public.is_admin());
  END IF;
END $$;

-- Subscriptions
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_subscriptions' AND tablename = 'subscriptions') THEN
    CREATE POLICY "admin_select_subscriptions" ON public.subscriptions FOR SELECT USING (public.is_admin());
  END IF;
END $$;

-- Bot sessions
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_bot_sessions' AND tablename = 'bot_sessions') THEN
    CREATE POLICY "admin_select_bot_sessions" ON public.bot_sessions FOR SELECT USING (public.is_admin());
  END IF;
END $$;

-- WhatsApp config
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_whatsapp_config' AND tablename = 'whatsapp_config') THEN
    CREATE POLICY "admin_select_whatsapp_config" ON public.whatsapp_config FOR SELECT USING (public.is_admin());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_update_whatsapp_config' AND tablename = 'whatsapp_config') THEN
    CREATE POLICY "admin_update_whatsapp_config" ON public.whatsapp_config FOR UPDATE USING (public.is_admin());
  END IF;
END $$;

-- WhatsApp channels
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_whatsapp_channels' AND tablename = 'whatsapp_channels') THEN
    CREATE POLICY "admin_select_whatsapp_channels" ON public.whatsapp_channels FOR SELECT USING (public.is_admin());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_update_whatsapp_channels' AND tablename = 'whatsapp_channels') THEN
    CREATE POLICY "admin_update_whatsapp_channels" ON public.whatsapp_channels FOR UPDATE USING (public.is_admin());
  END IF;
END $$;

-- Notifications
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_notifications' AND tablename = 'notifications') THEN
    CREATE POLICY "admin_select_notifications" ON public.notifications FOR SELECT USING (public.is_admin());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_insert_notifications' AND tablename = 'notifications') THEN
    CREATE POLICY "admin_insert_notifications" ON public.notifications FOR INSERT WITH CHECK (public.is_admin());
  END IF;
END $$;

-- Services
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_services' AND tablename = 'services') THEN
    CREATE POLICY "admin_select_services" ON public.services FOR SELECT USING (public.is_admin());
  END IF;
END $$;

-- Products
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_products' AND tablename = 'products') THEN
    CREATE POLICY "admin_select_products" ON public.products FOR SELECT USING (public.is_admin());
  END IF;
END $$;

-- Events
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_events' AND tablename = 'events') THEN
    CREATE POLICY "admin_select_events" ON public.events FOR SELECT USING (public.is_admin());
  END IF;
END $$;

-- Campaigns
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_campaigns' AND tablename = 'campaigns') THEN
    CREATE POLICY "admin_select_campaigns" ON public.campaigns FOR SELECT USING (public.is_admin());
  END IF;
END $$;

-- Site pages
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_site_pages' AND tablename = 'site_pages') THEN
    CREATE POLICY "admin_select_site_pages" ON public.site_pages FOR SELECT USING (public.is_admin());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_update_site_pages' AND tablename = 'site_pages') THEN
    CREATE POLICY "admin_update_site_pages" ON public.site_pages FOR UPDATE USING (public.is_admin());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_insert_site_pages' AND tablename = 'site_pages') THEN
    CREATE POLICY "admin_insert_site_pages" ON public.site_pages FOR INSERT WITH CHECK (public.is_admin());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_delete_site_pages' AND tablename = 'site_pages') THEN
    CREATE POLICY "admin_delete_site_pages" ON public.site_pages FOR DELETE USING (public.is_admin());
  END IF;
END $$;

-- Platform fees
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'admin_select_platform_fees' AND tablename = 'platform_fees') THEN
    CREATE POLICY "admin_select_platform_fees" ON public.platform_fees FOR SELECT USING (public.is_admin());
  END IF;
END $$;
