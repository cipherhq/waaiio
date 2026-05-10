-- Standalone party invites (not tied to events)
CREATE TABLE IF NOT EXISTS parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  date DATE NOT NULL,
  time VARCHAR(10),
  end_time VARCHAR(10),
  venue VARCHAR(300),
  venue_address TEXT,
  dress_code VARCHAR(100),
  image_url TEXT,
  allow_plus_ones BOOLEAN NOT NULL DEFAULT true,
  max_plus_ones INTEGER DEFAULT 3,
  ask_dietary BOOLEAN NOT NULL DEFAULT false,
  invite_message TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Business owners manage parties" ON parties
  FOR ALL USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Allow event_invites to optionally link to a party instead of an event
ALTER TABLE event_invites ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE event_invites ADD COLUMN IF NOT EXISTS party_id UUID REFERENCES parties(id) ON DELETE CASCADE;
-- At least one of event_id or party_id must be set
ALTER TABLE event_invites DROP CONSTRAINT IF EXISTS event_invites_event_id_guest_phone_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_invites_unique ON event_invites(COALESCE(event_id, '00000000-0000-0000-0000-000000000000'), COALESCE(party_id, '00000000-0000-0000-0000-000000000000'), guest_phone);

CREATE INDEX IF NOT EXISTS idx_parties_business ON parties(business_id);
CREATE INDEX IF NOT EXISTS idx_event_invites_party ON event_invites(party_id);
