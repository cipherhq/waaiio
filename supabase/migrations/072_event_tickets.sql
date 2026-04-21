-- Individual event tickets with unique codes for QR verification
CREATE TABLE public.event_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  ticket_code VARCHAR(12) UNIQUE NOT NULL,   -- e.g. "TK-A3F8X2"
  ticket_number INTEGER NOT NULL,             -- 1, 2, 3, 4 (within booking)
  guest_name TEXT,
  guest_phone TEXT,
  status TEXT NOT NULL DEFAULT 'valid',       -- 'valid' | 'used' | 'cancelled'
  scanned_at TIMESTAMPTZ,
  scanned_by TEXT,                            -- staff name or device ID
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_event_tickets_booking ON public.event_tickets(booking_id);
CREATE INDEX idx_event_tickets_event ON public.event_tickets(event_id);
CREATE INDEX idx_event_tickets_code ON public.event_tickets(ticket_code);

-- RLS
ALTER TABLE public.event_tickets ENABLE ROW LEVEL SECURITY;

-- Business owner can manage their own tickets
CREATE POLICY "business_owner_tickets" ON public.event_tickets
  FOR ALL USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );

-- Public can read by ticket_code (for QR verification page)
CREATE POLICY "public_verify_ticket" ON public.event_tickets
  FOR SELECT USING (true);
