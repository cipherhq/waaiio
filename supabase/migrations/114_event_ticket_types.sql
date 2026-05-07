-- Event ticket types (Regular, VIP, etc.)
CREATE TABLE IF NOT EXISTS event_ticket_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'General Admission',
  price numeric NOT NULL DEFAULT 0,
  total_tickets integer NOT NULL DEFAULT 100,
  tickets_sold integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE event_ticket_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY event_ticket_types_owner_select ON event_ticket_types FOR SELECT
  USING (event_id IN (SELECT id FROM events WHERE business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())));
CREATE POLICY event_ticket_types_owner_insert ON event_ticket_types FOR INSERT
  WITH CHECK (event_id IN (SELECT id FROM events WHERE business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())));
CREATE POLICY event_ticket_types_owner_update ON event_ticket_types FOR UPDATE
  USING (event_id IN (SELECT id FROM events WHERE business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())));
CREATE POLICY event_ticket_types_owner_delete ON event_ticket_types FOR DELETE
  USING (event_id IN (SELECT id FROM events WHERE business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())));
CREATE POLICY event_ticket_types_service_all ON event_ticket_types FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Track which ticket type was purchased
ALTER TABLE event_tickets ADD COLUMN IF NOT EXISTS ticket_type_id uuid REFERENCES event_ticket_types(id) ON DELETE SET NULL;
ALTER TABLE event_tickets ADD COLUMN IF NOT EXISTS ticket_type_name text;
