-- Event invitations / RSVP tracking
CREATE TABLE IF NOT EXISTS event_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_phone VARCHAR(20) NOT NULL,
  guest_name VARCHAR(100),
  guest_email VARCHAR(200),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'maybe', 'declined')),
  plus_ones INTEGER NOT NULL DEFAULT 0,
  dietary_notes TEXT,
  message TEXT, -- personal note from guest
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  reminder_sent BOOLEAN NOT NULL DEFAULT false,
  invite_token VARCHAR(32) NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(event_id, guest_phone)
);

ALTER TABLE event_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Business owners manage invites" ON event_invites
  FOR ALL USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
-- Public read for guests checking their own invite via token
CREATE POLICY "Guests view own invite" ON event_invites
  FOR SELECT USING (true);

CREATE INDEX IF NOT EXISTS idx_event_invites_event ON event_invites(event_id);
CREATE INDEX IF NOT EXISTS idx_event_invites_phone ON event_invites(guest_phone);
CREATE INDEX IF NOT EXISTS idx_event_invites_token ON event_invites(invite_token);

-- Add invite-related fields to events table
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_invite_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS invite_message TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS allow_plus_ones BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE events ADD COLUMN IF NOT EXISTS max_plus_ones INTEGER DEFAULT 3;
ALTER TABLE events ADD COLUMN IF NOT EXISTS ask_dietary BOOLEAN NOT NULL DEFAULT false;
