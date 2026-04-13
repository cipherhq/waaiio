-- ═══════════════════════════════════════════════════════
-- Migration 039: Reservation (Stay) & WhatsApp Sign
-- New tables: reservations, contracts
-- Enum extensions: flow_type, business_category, capability_type
-- Storage bucket: contracts
-- ═══════════════════════════════════════════════════════

-- 1A. Extend PostgreSQL Enums
ALTER TYPE flow_type ADD VALUE IF NOT EXISTS 'reservation';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'shortlet';
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'reservation';
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'whatsapp_sign';

-- 1B. Reservation Status Enum
DO $$ BEGIN
  CREATE TYPE reservation_status AS ENUM (
    'pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 1C. Reservations Table
CREATE TABLE IF NOT EXISTS reservations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  reference_code varchar(10) UNIQUE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  service_id uuid REFERENCES services(id) ON DELETE SET NULL,
  check_in date NOT NULL,
  check_out date NOT NULL,
  nights integer GENERATED ALWAYS AS (check_out - check_in) STORED,
  guests integer DEFAULT 1 NOT NULL,
  nightly_rate integer NOT NULL DEFAULT 0,
  total_amount integer NOT NULL DEFAULT 0,
  deposit_amount integer DEFAULT 0,
  deposit_status varchar(20) DEFAULT 'none' CHECK (deposit_status IN ('none', 'pending', 'paid')),
  status reservation_status DEFAULT 'pending' NOT NULL,
  special_requests text,
  guest_name varchar(200),
  guest_phone varchar(30),
  guest_email varchar(200),
  channel varchar(20) DEFAULT 'whatsapp',
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  platform_fee integer DEFAULT 0,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  confirmed_at timestamptz,
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by varchar(20),
  CONSTRAINT check_out_after_check_in CHECK (check_out > check_in)
);

-- Reference code trigger for reservations (BW-RXXXX pattern)
CREATE OR REPLACE FUNCTION generate_reservation_reference()
RETURNS trigger AS $$
DECLARE
  new_ref varchar(10);
  exists_already boolean;
BEGIN
  LOOP
    new_ref := 'BW-R' || lpad(floor(random() * 10000)::text, 4, '0');
    SELECT EXISTS(SELECT 1 FROM reservations WHERE reference_code = new_ref) INTO exists_already;
    EXIT WHEN NOT exists_already;
  END LOOP;
  NEW.reference_code := new_ref;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reservation_reference ON reservations;
CREATE TRIGGER trg_reservation_reference
  BEFORE INSERT ON reservations
  FOR EACH ROW
  WHEN (NEW.reference_code IS NULL)
  EXECUTE FUNCTION generate_reservation_reference();

-- Updated_at trigger for reservations
DROP TRIGGER IF EXISTS trg_reservations_updated_at ON reservations;
CREATE TRIGGER trg_reservations_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_reservations_business ON reservations(business_id);
CREATE INDEX IF NOT EXISTS idx_reservations_user ON reservations(user_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(business_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_dates ON reservations(business_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_reservations_reference ON reservations(reference_code);

-- RLS
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business owners manage their reservations" ON reservations;
CREATE POLICY "Business owners manage their reservations" ON reservations
  FOR ALL USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users view their own reservations" ON reservations;
CREATE POLICY "Users view their own reservations" ON reservations
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Service role full access to reservations" ON reservations;
CREATE POLICY "Service role full access to reservations" ON reservations
  FOR ALL USING (auth.role() = 'service_role');

-- 1D. Contracts Table
CREATE TABLE IF NOT EXISTS contracts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title varchar(300) NOT NULL,
  template_url text,
  signed_url text,
  signer_name varchar(200),
  signer_phone varchar(30),
  signer_email varchar(200),
  token varchar(64) UNIQUE NOT NULL,
  token_expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
  status varchar(20) DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'expired', 'revoked')),
  signature_data text,
  audit_trail jsonb DEFAULT '{}'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  signed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Updated_at trigger for contracts
DROP TRIGGER IF EXISTS trg_contracts_updated_at ON contracts;
CREATE TRIGGER trg_contracts_updated_at
  BEFORE UPDATE ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_contracts_business ON contracts(business_id);
CREATE INDEX IF NOT EXISTS idx_contracts_token ON contracts(token);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(business_id, status);

-- RLS
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business owners manage their contracts" ON contracts;
CREATE POLICY "Business owners manage their contracts" ON contracts
  FOR ALL USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "Service role full access to contracts" ON contracts;
CREATE POLICY "Service role full access to contracts" ON contracts
  FOR ALL USING (auth.role() = 'service_role');

-- 1E. Add reservation_id to platform_fees and payments
ALTER TABLE platform_fees ADD COLUMN IF NOT EXISTS reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL;

-- 1F. Contracts storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('contracts', 'contracts', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS for contracts bucket
DROP POLICY IF EXISTS "Business owners upload contracts" ON storage.objects;
CREATE POLICY "Business owners upload contracts" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'contracts' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Business owners read contracts" ON storage.objects;
CREATE POLICY "Business owners read contracts" ON storage.objects
  FOR SELECT USING (bucket_id = 'contracts' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Service role manages contracts storage" ON storage.objects;
CREATE POLICY "Service role manages contracts storage" ON storage.objects
  FOR ALL USING (bucket_id = 'contracts' AND auth.role() = 'service_role');

-- 1G. Seed shortlet into category_templates
INSERT INTO category_templates (key, label, icon, flow_type, sort_order, default_services, default_greeting, labels)
VALUES
  ('shortlet', 'Shortlet / Airbnb', '🏘️', 'scheduling', 39,
   '[{"name":"Apartment Stay","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0}]',
   'Welcome to {{name}}! 🏘️ Looking for a comfortable stay? Let me help you book the perfect apartment.',
   '{"entityName":"reservation","entityNamePlural":"reservations","actionVerb":"Book","confirmationEmoji":"🏘️","receiptTitle":"Reservation Confirmed","quantityLabel":"nights","personLabel":"Guest","personLabelPlural":"Guests","hiddenStatuses":[]}')
ON CONFLICT (key) DO NOTHING;
