-- Move blocked phones from business metadata JSONB to a proper table
-- Enables efficient lookups, audit trail, and proper indexing

CREATE TABLE IF NOT EXISTS blocked_phones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone VARCHAR(30) NOT NULL,
  blocked_by UUID,
  reason TEXT,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(business_id, phone)
);

CREATE INDEX idx_blocked_phones_business ON blocked_phones(business_id);
CREATE INDEX idx_blocked_phones_phone ON blocked_phones(phone);

ALTER TABLE blocked_phones ENABLE ROW LEVEL SECURITY;

-- Business owners can manage their blocked phones
CREATE POLICY "owners_manage_blocked_phones" ON blocked_phones
  FOR ALL USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Service role has full access (for admin panel and bot)
CREATE POLICY "service_manage_blocked_phones" ON blocked_phones
  FOR ALL TO service_role USING (true);

-- Admin/support can view/manage all blocked phones
CREATE POLICY "admin_manage_blocked_phones" ON blocked_phones
  FOR ALL USING (public.is_admin_or_support());
