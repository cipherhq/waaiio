-- ═══════════════════════════════════════════════════════
-- 099: Business Team Members & Roles
-- ═══════════════════════════════════════════════════════

CREATE TYPE business_role AS ENUM ('owner', 'admin', 'manager', 'staff', 'finance', 'support');

CREATE TABLE IF NOT EXISTS business_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  email text NOT NULL,
  role business_role NOT NULL DEFAULT 'staff',
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended')),
  invite_token text,
  invited_by uuid REFERENCES auth.users(id),
  invited_at timestamptz DEFAULT now(),
  joined_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(business_id, email)
);

CREATE INDEX idx_business_members_business ON business_members(business_id);
CREATE INDEX idx_business_members_user ON business_members(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_business_members_token ON business_members(invite_token) WHERE invite_token IS NOT NULL;

-- RLS
ALTER TABLE business_members ENABLE ROW LEVEL SECURITY;

-- Owner and admins can manage members
CREATE POLICY business_members_manage ON business_members FOR ALL USING (
  business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  OR user_id = auth.uid()
);

CREATE POLICY business_members_service ON business_members FOR ALL USING (auth.role() = 'service_role');

-- Function to check if a user has a specific role (or higher) for a business
CREATE OR REPLACE FUNCTION check_business_role(
  p_user_id uuid,
  p_business_id uuid,
  p_required_roles business_role[]
) RETURNS boolean AS $$
BEGIN
  -- Owner always has access
  IF EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_id = p_user_id) THEN
    RETURN true;
  END IF;

  -- Check member role
  RETURN EXISTS (
    SELECT 1 FROM business_members
    WHERE business_id = p_business_id
      AND user_id = p_user_id
      AND status = 'active'
      AND role = ANY(p_required_roles)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
