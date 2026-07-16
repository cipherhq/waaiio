-- Migration 241: Growth Engine
-- Tables: growth_contacts, growth_imports, customer_consents, growth_campaigns,
--         growth_campaign_recipients, growth_credits, growth_credit_transactions, growth_pricing
-- Also adds growth_enabled to businesses

-- 1. Add growth_enabled to businesses
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS growth_enabled BOOLEAN DEFAULT false;

-- 2. growth_imports (referenced by growth_contacts)
CREATE TABLE public.growth_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  filename TEXT,
  total_rows INTEGER,
  valid_rows INTEGER,
  duplicate_rows INTEGER,
  invalid_rows INTEGER,
  status TEXT CHECK (status IN ('processing', 'completed', 'failed')),
  field_mapping JSONB,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- 3. growth_contacts
CREATE TABLE public.growth_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  first_name TEXT,
  last_name TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  country_code TEXT,
  birthday DATE,
  tags TEXT[],
  custom_fields JSONB DEFAULT '{}',
  import_id UUID REFERENCES public.growth_imports(id),
  source TEXT,
  status TEXT CHECK (status IN ('active', 'invalid', 'duplicate', 'opted_out')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, phone)
);

-- 4. customer_consents
CREATE TABLE public.customer_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  channel TEXT CHECK (channel IN ('whatsapp', 'sms', 'email')),
  purpose TEXT CHECK (purpose IN ('utility', 'marketing', 'authentication')),
  status TEXT CHECK (status IN ('granted', 'revoked', 'pending', 'unknown')),
  source TEXT CHECK (source IN ('website', 'checkout', 'qr', 'pos', 'event', 'paper', 'crm_import', 'manual', 'sms', 'whatsapp', 'api')),
  evidence_reference TEXT,
  policy_version TEXT,
  granted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. growth_campaigns
CREATE TABLE public.growth_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT,
  status TEXT CHECK (status IN ('draft', 'scheduled', 'sending', 'completed', 'cancelled')),
  template_id TEXT,
  target_segment JSONB,
  total_recipients INTEGER,
  credits_reserved INTEGER,
  credits_consumed INTEGER,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. growth_campaign_recipients
CREATE TABLE public.growth_campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.growth_campaigns(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.growth_contacts(id),
  phone TEXT,
  channel TEXT,
  status TEXT CHECK (status IN ('pending', 'sent', 'delivered', 'clicked', 'converted', 'failed', 'opted_out')),
  credits_used INTEGER DEFAULT 0,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  converted_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 7. growth_credits
CREATE TABLE public.growth_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  type TEXT,
  amount INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  source TEXT,
  reference TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, type, reference)
);

-- 8. growth_credit_transactions
CREATE TABLE public.growth_credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  credit_id UUID REFERENCES public.growth_credits(id),
  campaign_id UUID REFERENCES public.growth_campaigns(id),
  type TEXT CHECK (type IN ('reserve', 'consume', 'release', 'refund', 'grant')),
  amount INTEGER NOT NULL,
  balance_after INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 9. growth_pricing
CREATE TABLE public.growth_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code TEXT NOT NULL,
  channel TEXT NOT NULL,
  provider TEXT,
  currency TEXT NOT NULL,
  base_cost_minor INTEGER,
  markup_percentage NUMERIC(5,2) DEFAULT 20,
  credit_cost INTEGER,
  effective_date DATE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  plan_discounts JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(country_code, channel, effective_date)
);

-- ============================================================
-- RLS Policies
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE public.growth_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_pricing ENABLE ROW LEVEL SECURITY;

-- growth_contacts: business owner read/write
CREATE POLICY "growth_contacts_select" ON public.growth_contacts
  FOR SELECT USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_contacts_insert" ON public.growth_contacts
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_contacts_update" ON public.growth_contacts
  FOR UPDATE USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_contacts_delete" ON public.growth_contacts
  FOR DELETE USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );

-- growth_imports: business owner read/write
CREATE POLICY "growth_imports_select" ON public.growth_imports
  FOR SELECT USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_imports_insert" ON public.growth_imports
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_imports_update" ON public.growth_imports
  FOR UPDATE USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_imports_delete" ON public.growth_imports
  FOR DELETE USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );

-- customer_consents: business owner read, service insert
CREATE POLICY "customer_consents_select" ON public.customer_consents
  FOR SELECT USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "customer_consents_service_insert" ON public.customer_consents
  FOR INSERT WITH CHECK (true);

-- growth_campaigns: business owner read/write
CREATE POLICY "growth_campaigns_select" ON public.growth_campaigns
  FOR SELECT USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_campaigns_insert" ON public.growth_campaigns
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_campaigns_update" ON public.growth_campaigns
  FOR UPDATE USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_campaigns_delete" ON public.growth_campaigns
  FOR DELETE USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );

-- growth_campaign_recipients: business owner read only
CREATE POLICY "growth_campaign_recipients_select" ON public.growth_campaign_recipients
  FOR SELECT USING (
    campaign_id IN (
      SELECT id FROM public.growth_campaigns
      WHERE business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
    )
  );

-- growth_credits: business owner read/write
CREATE POLICY "growth_credits_select" ON public.growth_credits
  FOR SELECT USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_credits_insert" ON public.growth_credits
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_credits_update" ON public.growth_credits
  FOR UPDATE USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_credits_delete" ON public.growth_credits
  FOR DELETE USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );

-- growth_credit_transactions: business owner read/write
CREATE POLICY "growth_credit_transactions_select" ON public.growth_credit_transactions
  FOR SELECT USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );
CREATE POLICY "growth_credit_transactions_insert" ON public.growth_credit_transactions
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );

-- growth_pricing: admin read, service write
CREATE POLICY "growth_pricing_admin_select" ON public.growth_pricing
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
      AND role IN ('admin', 'support', 'finance', 'operations')
    )
  );
CREATE POLICY "growth_pricing_service_insert" ON public.growth_pricing
  FOR INSERT WITH CHECK (true);
CREATE POLICY "growth_pricing_service_update" ON public.growth_pricing
  FOR UPDATE USING (true);

-- ============================================================
-- Indexes
-- ============================================================

-- growth_contacts indexes
CREATE INDEX idx_growth_contacts_business_created ON public.growth_contacts(business_id, created_at);
CREATE INDEX idx_growth_contacts_phone ON public.growth_contacts(phone);
CREATE INDEX idx_growth_contacts_import ON public.growth_contacts(import_id);

-- growth_imports indexes
CREATE INDEX idx_growth_imports_business_created ON public.growth_imports(business_id, created_at);

-- customer_consents indexes
CREATE INDEX idx_customer_consents_business_phone ON public.customer_consents(business_id, phone);
CREATE INDEX idx_customer_consents_business_created ON public.customer_consents(business_id, created_at);
CREATE INDEX idx_customer_consents_phone_channel ON public.customer_consents(phone, channel, purpose);

-- growth_campaigns indexes
CREATE INDEX idx_growth_campaigns_business_created ON public.growth_campaigns(business_id, created_at);
CREATE INDEX idx_growth_campaigns_status ON public.growth_campaigns(status);

-- growth_campaign_recipients indexes
CREATE INDEX idx_growth_campaign_recipients_campaign ON public.growth_campaign_recipients(campaign_id);
CREATE INDEX idx_growth_campaign_recipients_phone ON public.growth_campaign_recipients(phone);
CREATE INDEX idx_growth_campaign_recipients_status ON public.growth_campaign_recipients(status);

-- growth_credits indexes
CREATE INDEX idx_growth_credits_business ON public.growth_credits(business_id);
CREATE INDEX idx_growth_credits_business_remaining ON public.growth_credits(business_id, remaining) WHERE remaining > 0;

-- growth_credit_transactions indexes
CREATE INDEX idx_growth_credit_transactions_business ON public.growth_credit_transactions(business_id, created_at);
CREATE INDEX idx_growth_credit_transactions_campaign ON public.growth_credit_transactions(campaign_id);

-- growth_pricing indexes
CREATE INDEX idx_growth_pricing_country_channel ON public.growth_pricing(country_code, channel);
CREATE INDEX idx_growth_pricing_active ON public.growth_pricing(is_active) WHERE is_active = true;
