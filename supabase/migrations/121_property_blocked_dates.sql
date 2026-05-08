-- Property blocked dates: prevent bookings on specific date ranges
-- Used for maintenance, personal use, or pre-existing bookings
CREATE TABLE IF NOT EXISTS property_blocked_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  date_from date NOT NULL,
  date_to date NOT NULL,
  reason varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_date_range CHECK (date_to >= date_from)
);

CREATE INDEX IF NOT EXISTS idx_blocked_dates_property ON property_blocked_dates(property_id, date_from, date_to);

ALTER TABLE property_blocked_dates ENABLE ROW LEVEL SECURITY;

CREATE POLICY blocked_dates_owner ON property_blocked_dates FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY blocked_dates_service ON property_blocked_dates FOR ALL TO service_role
  USING (true) WITH CHECK (true);
