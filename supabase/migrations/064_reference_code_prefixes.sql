-- ═══════════════════════════════════════════════════════
-- Migration 064: WA- Reference Code Prefixes + Reschedule Tracking
-- Updates reference code generators to use WA-XX- prefixes
-- Adds reschedule tracking columns to bookings
-- ═══════════════════════════════════════════════════════

-- ── 1. Drop triggers that depend on reference_code columns ──

DROP TRIGGER IF EXISTS set_reference_code ON public.bookings;
DROP TRIGGER IF EXISTS set_order_reference_code ON public.orders;
DROP TRIGGER IF EXISTS trg_reservation_reference ON public.reservations;
DROP TRIGGER IF EXISTS set_invoice_reference_code ON public.invoices;

-- ── 2. Widen reference_code columns to VARCHAR(12) for safety ──

ALTER TABLE public.bookings ALTER COLUMN reference_code TYPE VARCHAR(12);
ALTER TABLE public.orders ALTER COLUMN reference_code TYPE VARCHAR(12);
ALTER TABLE public.reservations ALTER COLUMN reference_code TYPE VARCHAR(12);
ALTER TABLE public.invoices ALTER COLUMN reference_code TYPE VARCHAR(12);

-- ── 3. Booking reference codes (flow_type → prefix) ──

CREATE OR REPLACE FUNCTION public.generate_reference_code()
RETURNS TRIGGER AS $$
DECLARE
  new_code VARCHAR(12);
  code_exists BOOLEAN;
  prefix VARCHAR(6);
BEGIN
  prefix := CASE NEW.flow_type
    WHEN 'scheduling'  THEN 'WA-BK-'
    WHEN 'payment'     THEN 'WA-PY-'
    WHEN 'ticketing'   THEN 'WA-TK-'
    WHEN 'reservation' THEN 'WA-RS-'
    ELSE 'WA-QU-'
  END;

  LOOP
    new_code := prefix || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
    SELECT EXISTS(SELECT 1 FROM public.bookings WHERE reference_code = new_code) INTO code_exists;
    EXIT WHEN NOT code_exists;
  END LOOP;

  NEW.reference_code := new_code;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 4. Order reference codes (WA-OR-XXXX) ──

CREATE OR REPLACE FUNCTION public.generate_order_reference()
RETURNS TRIGGER AS $$
DECLARE
  new_code VARCHAR(12);
  code_exists BOOLEAN;
BEGIN
  LOOP
    new_code := 'WA-OR-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
    SELECT EXISTS(SELECT 1 FROM public.orders WHERE reference_code = new_code) INTO code_exists;
    EXIT WHEN NOT code_exists;
  END LOOP;

  NEW.reference_code := new_code;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 5. Reservation reference codes (WA-RS-XXXX) ──

CREATE OR REPLACE FUNCTION public.generate_reservation_reference()
RETURNS TRIGGER AS $$
DECLARE
  new_code VARCHAR(12);
  code_exists BOOLEAN;
BEGIN
  LOOP
    new_code := 'WA-RS-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
    SELECT EXISTS(SELECT 1 FROM public.reservations WHERE reference_code = new_code) INTO code_exists;
    EXIT WHEN NOT code_exists;
  END LOOP;

  NEW.reference_code := new_code;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 6. Invoice reference codes (WA-IN-XXXX) ──

CREATE OR REPLACE FUNCTION public.generate_invoice_reference()
RETURNS TRIGGER AS $$
DECLARE
  new_code VARCHAR(12);
  code_exists BOOLEAN;
BEGIN
  LOOP
    new_code := 'WA-IN-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
    SELECT EXISTS(SELECT 1 FROM public.invoices WHERE reference_code = new_code) INTO code_exists;
    EXIT WHEN NOT code_exists;
  END LOOP;

  NEW.reference_code := new_code;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 7. Recreate triggers with new functions ──

CREATE TRIGGER set_reference_code
  BEFORE INSERT ON public.bookings
  FOR EACH ROW
  WHEN (NEW.reference_code IS NULL OR NEW.reference_code = '')
  EXECUTE FUNCTION public.generate_reference_code();

CREATE TRIGGER set_order_reference_code
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  WHEN (NEW.reference_code IS NULL OR NEW.reference_code = '')
  EXECUTE FUNCTION public.generate_order_reference();

CREATE TRIGGER trg_reservation_reference
  BEFORE INSERT ON public.reservations
  FOR EACH ROW
  WHEN (NEW.reference_code IS NULL)
  EXECUTE FUNCTION public.generate_reservation_reference();

CREATE TRIGGER set_invoice_reference_code
  BEFORE INSERT ON public.invoices
  FOR EACH ROW
  WHEN (NEW.reference_code IS NULL OR NEW.reference_code = '')
  EXECUTE FUNCTION public.generate_invoice_reference();

-- ── 8. Reschedule tracking columns on bookings ──

ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMPTZ;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS original_date DATE;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS original_time TEXT;
