-- ══ Public Event + Booking Web Pages ══
-- Adds event slugs for public URLs, event_id FK on bookings,
-- public RLS policies, and atomic ticket purchase function.

-- 1. Add slug column to events (globally unique for /e/[slug] URLs)
ALTER TABLE events ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);

-- 2. Auto-generate slug from event name on INSERT
CREATE OR REPLACE FUNCTION generate_event_slug()
RETURNS TRIGGER AS $$
DECLARE
  base_slug TEXT;
  final_slug TEXT;
  counter INT := 0;
BEGIN
  IF NEW.slug IS NOT NULL AND NEW.slug != '' THEN
    RETURN NEW;
  END IF;

  base_slug := LOWER(REGEXP_REPLACE(TRIM(NEW.name), '[^a-z0-9]+', '-', 'gi'));
  base_slug := TRIM(BOTH '-' FROM base_slug);

  IF LENGTH(base_slug) < 2 THEN
    base_slug := 'event';
  END IF;

  final_slug := base_slug;
  LOOP
    IF NOT EXISTS (SELECT 1 FROM events WHERE slug = final_slug AND id != NEW.id) THEN
      NEW.slug := final_slug;
      RETURN NEW;
    END IF;
    counter := counter + 1;
    final_slug := base_slug || '-' || counter;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_generate_event_slug ON events;
CREATE TRIGGER trg_generate_event_slug
  BEFORE INSERT OR UPDATE ON events
  FOR EACH ROW
  EXECUTE FUNCTION generate_event_slug();

-- 3. Backfill existing events with slugs
UPDATE events SET slug = NULL WHERE slug IS NULL;
-- Trigger will auto-generate slugs

-- 4. Add event_id FK on bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_event_id ON bookings(event_id);

-- 5. Public SELECT policies for web pages

-- Events: anyone can read published events
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'events' AND policyname = 'public_read_published_events') THEN
    CREATE POLICY public_read_published_events ON events FOR SELECT TO anon, authenticated
      USING (status = 'published');
  END IF;
END $$;

-- Services: anyone can read active services
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'services' AND policyname = 'public_read_active_services') THEN
    CREATE POLICY public_read_active_services ON services FOR SELECT TO anon, authenticated
      USING (is_active = true);
  END IF;
END $$;

-- Businesses: anyone can read active businesses (basic info)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'businesses' AND policyname = 'public_read_active_businesses') THEN
    CREATE POLICY public_read_active_businesses ON businesses FOR SELECT TO anon, authenticated
      USING (status = 'active');
  END IF;
END $$;

-- Event ticket types: anyone can read active types
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_ticket_types' AND policyname = 'public_read_active_ticket_types') THEN
    CREATE POLICY public_read_active_ticket_types ON event_ticket_types FOR SELECT TO anon, authenticated
      USING (is_active = true);
  END IF;
END $$;

-- 6. Atomic ticket purchase function
CREATE OR REPLACE FUNCTION purchase_tickets_atomic(
  p_business_id UUID,
  p_event_id UUID,
  p_ticket_type_id UUID,
  p_quantity INT,
  p_user_id UUID,
  p_guest_name TEXT,
  p_guest_phone TEXT,
  p_guest_email TEXT,
  p_total_amount INT,
  p_channel TEXT DEFAULT 'web'
) RETURNS TABLE(booking_id UUID, reference_code TEXT, tickets_available BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_available INT;
  v_booking_id UUID;
  v_ref TEXT;
  v_event_date DATE;
  v_event_time TIME;
  v_event_name TEXT;
BEGIN
  -- Lock event row to prevent overselling
  SELECT date, time, name INTO v_event_date, v_event_time, v_event_name
  FROM events WHERE id = p_event_id FOR UPDATE;

  -- Check availability
  IF p_ticket_type_id IS NOT NULL THEN
    PERFORM id FROM event_ticket_types WHERE id = p_ticket_type_id FOR UPDATE;
    SELECT (total_tickets - tickets_sold) INTO v_available
    FROM event_ticket_types WHERE id = p_ticket_type_id;
  ELSE
    SELECT (total_tickets - tickets_sold) INTO v_available
    FROM events WHERE id = p_event_id;
  END IF;

  IF v_available IS NULL OR v_available < p_quantity THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, false;
    RETURN;
  END IF;

  -- Increment tickets_sold
  UPDATE events SET tickets_sold = tickets_sold + p_quantity WHERE id = p_event_id;
  IF p_ticket_type_id IS NOT NULL THEN
    UPDATE event_ticket_types SET tickets_sold = tickets_sold + p_quantity WHERE id = p_ticket_type_id;
  END IF;

  -- Create booking
  INSERT INTO bookings (
    business_id, user_id, event_id, date, time, party_size, quantity,
    flow_type, channel, deposit_amount, deposit_status, status,
    total_amount, guest_name, guest_phone, guest_email, notes
  ) VALUES (
    p_business_id,
    p_user_id,
    p_event_id,
    v_event_date,
    COALESCE(v_event_time, '00:00'::TIME),
    p_quantity,
    p_quantity,
    'ticketing'::flow_type,
    p_channel::booking_channel,
    p_total_amount,
    CASE WHEN p_total_amount > 0 THEN 'pending'::deposit_status ELSE 'none'::deposit_status END,
    CASE WHEN p_total_amount > 0 THEN 'pending' ELSE 'confirmed' END,
    p_total_amount,
    p_guest_name,
    p_guest_phone,
    p_guest_email,
    'Tickets for: ' || v_event_name
  ) RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;
