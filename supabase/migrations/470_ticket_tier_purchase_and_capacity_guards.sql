-- Migration 470: Ticket tier purchase and capacity guards (#716)
--
-- Fixes two P1 blockers from CTO review of PR #717:
--
-- P1-A: purchase_tickets_atomic ignores is_active — paused tiers can still
--        be purchased.  Fix: add is_active check under the existing FOR UPDATE
--        row lock, raising 'tier_paused' before any inventory mutation.
--
-- P1-B: No DB-enforced capacity guard — authenticated owners can reduce
--        total_tickets via direct Supabase Data API or partner API,
--        bypassing the dashboard's client-side validation.
--
--        Fix (two layers):
--        1. CHECK constraint: total_tickets >= tickets_sold (absolute floor).
--        2. BEFORE UPDATE trigger: rejects any decrease in total_tickets on
--           existing rows.  Capacity increases are allowed; inserts are
--           unrestricted.  This enforces the agreed conservative policy:
--           saved-tier capacity cannot decrease until authoritative pending-
--           hold accounting is implemented.  The trigger allows the system's
--           own tickets_sold increments (which don't touch total_tickets).
--
-- Rollback: DROP trigger + function + constraint, then CREATE OR REPLACE
-- the RPC from M383 (the pre-is_active version).  No data migration needed.

-- ═══════════════════════════════════════════════════════
-- Part 1a: CHECK constraint — absolute floor (capacity >= sold)
-- ═══════════════════════════════════════════════════════

ALTER TABLE event_ticket_types
  ADD CONSTRAINT chk_capacity_gte_sold CHECK (total_tickets >= tickets_sold);

-- ═══════════════════════════════════════════════════════
-- Part 1b: Trigger — no capacity decrease on saved tiers
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION prevent_ticket_capacity_decrease()
RETURNS TRIGGER AS $$
BEGIN
  -- Only fire on UPDATE (INSERT is unrestricted — new tiers can have any capacity)
  -- Allow total_tickets to stay the same or increase; reject any decrease.
  -- tickets_sold changes are unaffected (this trigger only guards total_tickets).
  IF NEW.total_tickets < OLD.total_tickets THEN
    RAISE EXCEPTION 'capacity_decrease_blocked:Cannot reduce ticket capacity from % to % — pending reservations may not be fully accounted for. Increase capacity or pause the tier instead.',
      OLD.total_tickets, NEW.total_tickets;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_ticket_capacity_decrease ON event_ticket_types;
CREATE TRIGGER trg_prevent_ticket_capacity_decrease
  BEFORE UPDATE ON event_ticket_types
  FOR EACH ROW
  EXECUTE FUNCTION prevent_ticket_capacity_decrease();

-- ═══════════════════════════════════════════════════════
-- Part 2: Replace purchase_tickets_atomic with is_active guard
-- ═══════════════════════════════════════════════════════

-- Defensively drop old 10-arg signature from M149 (M383 already does this,
-- but if this migration is applied in non-standard order — e.g. the R90 test
-- which skips M383 — the old overload would coexist and fail the stale-
-- overload assertion below).
DROP FUNCTION IF EXISTS public.purchase_tickets_atomic(
  uuid, uuid, uuid, integer, uuid, text, text, text, integer, text
);

-- Same 12-arg signature as M383 — CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.purchase_tickets_atomic(
  p_business_id UUID,
  p_event_id UUID,
  p_ticket_type_id UUID,
  p_quantity INT,
  p_user_id UUID,
  p_guest_name TEXT,
  p_guest_phone TEXT,
  p_guest_email TEXT,
  p_total_amount INT,
  p_channel TEXT DEFAULT 'web',
  p_bot_session_id UUID DEFAULT NULL,
  p_expected_price INT DEFAULT NULL
) RETURNS TABLE(booking_id UUID, reference_code TEXT, tickets_available BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_available INT;
  v_booking_id UUID;
  v_ref TEXT;
  v_event_date DATE;
  v_event_time TIME;
  v_event_name TEXT;
  v_event_status TEXT;
  v_event_biz UUID;
  v_event_price INT;
  v_tt_event_id UUID;
  v_tt_is_active BOOLEAN;          -- ← NEW: track tier active state
  v_has_configured_tiers BOOLEAN;  -- ← NEW: detect tiered vs tierless events
  v_committed_total INT;
  v_existing_booking_id UUID;
  v_existing_ref TEXT;
  v_ticket_price INT;
BEGIN
  -- Bot session idempotency
  IF p_bot_session_id IS NOT NULL THEN
    SELECT id, bookings.reference_code INTO v_existing_booking_id, v_existing_ref
    FROM bookings
    WHERE bot_session_id = p_bot_session_id
      AND status IN ('pending', 'confirmed')
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_existing_booking_id, v_existing_ref, true;
      RETURN;
    END IF;
  END IF;

  -- Quantity validation
  IF p_quantity < 1 THEN
    RAISE EXCEPTION 'invalid_quantity:Quantity must be at least 1';
  END IF;

  -- Lock event row to prevent overselling
  SELECT date, time, name, status::text, business_id, price
  INTO v_event_date, v_event_time, v_event_name, v_event_status, v_event_biz, v_event_price
  FROM events WHERE id = p_event_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, false;
    RETURN;
  END IF;

  -- Event→business binding
  IF v_event_biz != p_business_id THEN
    RAISE EXCEPTION 'event_wrong_business:Event % does not belong to business %', p_event_id, p_business_id;
  END IF;

  -- Event must be published
  IF v_event_status != 'published' THEN
    RAISE EXCEPTION 'event_not_published:Event % is not published (status=%)', p_event_id, v_event_status;
  END IF;

  -- ▼ ALL-PAUSED GUARD: distinguish tiered events (all paused) from legacy tierless events.
  -- A tiered event with zero active tiers must not fall through to event-level pricing.
  IF p_ticket_type_id IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM event_ticket_types WHERE event_id = p_event_id
    ) INTO v_has_configured_tiers;

    IF v_has_configured_tiers THEN
      -- Event has configured tiers but caller sent no tier ID.
      -- Check if ANY tier is active — if none, the event is fully paused.
      IF NOT EXISTS (
        SELECT 1 FROM event_ticket_types WHERE event_id = p_event_id AND is_active = true
      ) THEN
        RAISE EXCEPTION 'all_tiers_paused:All ticket types for this event are currently unavailable';
      ELSE
        -- Active tiers exist but caller didn't select one — require selection.
        RAISE EXCEPTION 'tier_required:This event requires a ticket type selection';
      END IF;
    END IF;
    -- No configured tiers at all → legitimate tierless event, proceed with event-level pricing
  END IF;

  -- Price validation + server-authoritative total
  v_committed_total := v_event_price * p_quantity;  -- default: event base price × qty

  IF p_ticket_type_id IS NOT NULL THEN
    -- Ticket-type→event binding: must belong to this event
    -- ▼ P1-A FIX: also select is_active under the same FOR UPDATE lock
    SELECT price, event_id, is_active INTO v_ticket_price, v_tt_event_id, v_tt_is_active
    FROM event_ticket_types WHERE id = p_ticket_type_id FOR UPDATE;
    IF v_ticket_price IS NULL THEN
      RAISE EXCEPTION 'ticket_type_not_found:Ticket type % does not exist', p_ticket_type_id;
    END IF;
    IF v_tt_event_id != p_event_id THEN
      RAISE EXCEPTION 'ticket_type_wrong_event:Ticket type % does not belong to event %', p_ticket_type_id, p_event_id;
    END IF;
    -- ▼ P1-A FIX: reject purchase of paused tier
    IF NOT v_tt_is_active THEN
      RAISE EXCEPTION 'tier_paused:Ticket type % is not currently available for sale', p_ticket_type_id;
    END IF;
    v_committed_total := v_ticket_price * p_quantity;  -- override with ticket-type price
  END IF;

  IF p_expected_price IS NOT NULL THEN
    IF p_ticket_type_id IS NOT NULL THEN
      IF v_ticket_price != p_expected_price THEN
        RAISE EXCEPTION 'price_changed:Ticket price changed from % to %', p_expected_price, v_ticket_price;
      END IF;
    ELSE
      IF v_event_price != p_expected_price THEN
        RAISE EXCEPTION 'price_changed:Event price changed from % to %', p_expected_price, v_event_price;
      END IF;
    END IF;
  END IF;

  -- Check availability
  IF p_ticket_type_id IS NOT NULL THEN
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

  -- Create booking with server-authoritative total
  INSERT INTO bookings (
    business_id, user_id, event_id, date, time, party_size, quantity,
    flow_type, channel, deposit_amount, deposit_status, status,
    total_amount, guest_name, guest_phone, guest_email, notes,
    bot_session_id, tickets_finalized
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
    v_committed_total,
    CASE WHEN v_committed_total > 0 THEN 'pending'::deposit_status ELSE 'none'::deposit_status END,
    CASE WHEN v_committed_total > 0 THEN 'pending'::reservation_status ELSE 'confirmed'::reservation_status END,
    v_committed_total,
    p_guest_name,
    p_guest_phone,
    p_guest_email,
    'Tickets for: ' || v_event_name,
    p_bot_session_id,
    true
  ) RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Part 2b: Atomic ticket booking fence for bot paid-ticket path
-- ═══════════════════════════════════════════════════════
-- The bot creates pending bookings for paid events BEFORE payment.
-- Unlike purchase_tickets_atomic (which increments tickets_sold at
-- creation), this function creates a pending booking WITHOUT
-- incrementing sold counters. Inventory is committed later by
-- finalize_free_ticket_booking after payment succeeds.
--
-- Crucially, it acquires a FOR UPDATE lock on the tier row and
-- checks is_active + availability atomically, closing the TOCTOU
-- gap between the bot's application-level read and INSERT.

CREATE OR REPLACE FUNCTION public.create_ticket_booking_checked(
  p_business_id UUID,
  p_event_id UUID,
  p_ticket_type_id UUID,    -- NULL for tierless events
  p_quantity INT,
  p_user_id UUID,
  p_total_amount INT,
  p_guest_name TEXT,
  p_guest_phone TEXT,
  p_bot_session_id UUID,
  p_expected_price INT DEFAULT NULL
) RETURNS TABLE(booking_id UUID, reference_code TEXT, success BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking_id UUID;
  v_ref TEXT;
  v_event_date DATE;
  v_event_time TIME;
  v_event_name TEXT;
  v_event_status TEXT;
  v_event_biz UUID;
  v_available INT;
  v_has_tiers BOOLEAN;
  v_tt_price INT;
  v_tt_event_id UUID;
  v_tt_active BOOLEAN;
  v_existing_id UUID;
  v_existing_ref TEXT;
BEGIN
  -- Bot session idempotency: return existing booking if present
  IF p_bot_session_id IS NOT NULL THEN
    SELECT id, bookings.reference_code INTO v_existing_id, v_existing_ref
    FROM bookings
    WHERE bot_session_id = p_bot_session_id
      AND status IN ('pending', 'confirmed')
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_existing_id, v_existing_ref, true;
      RETURN;
    END IF;
  END IF;

  -- Lock event
  SELECT date, time, name, status::text, business_id
  INTO v_event_date, v_event_time, v_event_name, v_event_status, v_event_biz
  FROM events WHERE id = p_event_id FOR UPDATE;

  IF NOT FOUND OR v_event_biz != p_business_id OR v_event_status != 'published' THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, false;
    RETURN;
  END IF;

  -- Tier validation (mirrors purchase_tickets_atomic logic)
  IF p_ticket_type_id IS NOT NULL THEN
    SELECT price, event_id, is_active INTO v_tt_price, v_tt_event_id, v_tt_active
    FROM event_ticket_types WHERE id = p_ticket_type_id FOR UPDATE;

    IF v_tt_price IS NULL OR v_tt_event_id != p_event_id THEN
      RETURN QUERY SELECT NULL::UUID, NULL::TEXT, false;
      RETURN;
    END IF;
    IF NOT v_tt_active THEN
      RAISE EXCEPTION 'tier_paused:Ticket type % is not currently available for sale', p_ticket_type_id;
    END IF;
    IF p_expected_price IS NOT NULL AND v_tt_price != p_expected_price THEN
      RAISE EXCEPTION 'price_changed:Ticket price changed from % to %', p_expected_price, v_tt_price;
    END IF;

    SELECT (total_tickets - tickets_sold) INTO v_available
    FROM event_ticket_types WHERE id = p_ticket_type_id;
  ELSE
    -- All-paused guard for null-tier
    SELECT EXISTS (SELECT 1 FROM event_ticket_types WHERE event_id = p_event_id) INTO v_has_tiers;
    IF v_has_tiers THEN
      IF NOT EXISTS (SELECT 1 FROM event_ticket_types WHERE event_id = p_event_id AND is_active = true) THEN
        RAISE EXCEPTION 'all_tiers_paused:All ticket types for this event are currently unavailable';
      ELSE
        RAISE EXCEPTION 'tier_required:This event requires a ticket type selection';
      END IF;
    END IF;

    SELECT (total_tickets - tickets_sold) INTO v_available FROM events WHERE id = p_event_id;
  END IF;

  IF v_available IS NULL OR v_available < p_quantity THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, false;
    RETURN;
  END IF;

  -- Create PENDING booking WITHOUT incrementing tickets_sold.
  -- Inventory commitment deferred to finalize_free_ticket_booking after payment.
  INSERT INTO bookings (
    business_id, user_id, event_id, date, time, party_size, quantity,
    flow_type, channel, deposit_amount, deposit_status, status,
    total_amount, guest_name, guest_phone, notes, bot_session_id
  ) VALUES (
    p_business_id, p_user_id, p_event_id,
    v_event_date, COALESCE(v_event_time, '00:00'::TIME),
    p_quantity, p_quantity,
    'ticketing'::flow_type, 'whatsapp'::booking_channel,
    p_total_amount,
    CASE WHEN p_total_amount > 0 THEN 'pending'::deposit_status ELSE 'none'::deposit_status END,
    CASE WHEN p_total_amount > 0 THEN 'pending'::reservation_status ELSE 'confirmed'::reservation_status END,
    p_total_amount, p_guest_name, p_guest_phone,
    'Tickets for: ' || v_event_name, p_bot_session_id
  ) RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- ACL for create_ticket_booking_checked (service_role only)
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.create_ticket_booking_checked(
    uuid, uuid, uuid, integer, uuid, integer, text, text, uuid, integer
  ) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.create_ticket_booking_checked(
      uuid, uuid, uuid, integer, uuid, integer, text, text, uuid, integer
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.create_ticket_booking_checked(
      uuid, uuid, uuid, integer, uuid, integer, text, text, uuid, integer
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.create_ticket_booking_checked(
      uuid, uuid, uuid, integer, uuid, integer, text, text, uuid, integer
    ) TO service_role;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════
-- Part 3: Re-apply ACL (CREATE OR REPLACE resets grants)
-- ═══════════════════════════════════════════════════════

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.purchase_tickets_atomic(
    uuid, uuid, uuid, integer, uuid, text, text, text, integer, text, uuid, int
  ) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.purchase_tickets_atomic(
      uuid, uuid, uuid, integer, uuid, text, text, text, integer, text, uuid, int
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.purchase_tickets_atomic(
      uuid, uuid, uuid, integer, uuid, text, text, text, integer, text, uuid, int
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.purchase_tickets_atomic(
      uuid, uuid, uuid, integer, uuid, text, text, text, integer, text, uuid, int
    ) TO service_role;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════
-- Part 4: Stale-overload assertion (still exactly 1 signature)
-- ═══════════════════════════════════════════════════════

DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'purchase_tickets_atomic';
  IF v_count != 1 THEN
    RAISE EXCEPTION 'stale_overload:purchase_tickets_atomic has % signatures (expected 1)', v_count;
  END IF;
  RAISE NOTICE 'M470 overload assertion passed: purchase_tickets_atomic has 1 signature';
END $$;
