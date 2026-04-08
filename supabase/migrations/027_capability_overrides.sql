-- ══════════════════════════════════════════════════════════
-- 027: Capability Overrides
-- Admin-granted capability overrides that bypass tier gating
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS capability_overrides (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  capability capability_type NOT NULL,
  granted_by uuid NOT NULL REFERENCES profiles(id),
  reason text,
  created_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(business_id, capability)
);

CREATE INDEX idx_capability_overrides_business ON capability_overrides(business_id);

ALTER TABLE capability_overrides ENABLE ROW LEVEL SECURITY;

-- Business owners can read their own overrides
CREATE POLICY "capability_overrides_owner_select" ON capability_overrides
  FOR SELECT USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- Service role (admin panel) can do everything
CREATE POLICY "capability_overrides_service_all" ON capability_overrides
  FOR ALL USING (true);
