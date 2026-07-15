-- Attendance check-in log for web-based QR code check-ins
-- Used by churches, events, workshops, gyms for "I'm here" tracking

CREATE TABLE attendance_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  customer_email TEXT,
  notes TEXT,
  checked_in_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT DEFAULT 'web',  -- web | whatsapp | manual
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_attendance_business ON attendance_log(business_id, checked_in_at DESC);
CREATE INDEX idx_attendance_phone ON attendance_log(business_id, customer_phone, checked_in_at DESC);

-- RLS
ALTER TABLE attendance_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_read" ON attendance_log FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

CREATE POLICY "service_insert" ON attendance_log FOR INSERT
  WITH CHECK (true);

CREATE POLICY "owners_delete" ON attendance_log FOR DELETE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
