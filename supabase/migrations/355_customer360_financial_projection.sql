-- ============================================================================
-- Migration 355: Customer 360 + Financial Projection (#225, #226)
--
-- 1. Add nullable user_id to customer_profiles for durable identity
-- 2. Deterministic backfill from bookings (unambiguous phone->user_id only)
-- 3. get_business_transactions() -- unified financial projection
-- 4. get_customer_history() -- per-customer history projection
-- 5. get_business_revenue_totals() -- authoritative server-side totals
-- ============================================================================

-- 1. Add user_id to customer_profiles

ALTER TABLE public.customer_profiles
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

-- Partial unique index: one profile per user per business (when user_id known)
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_profiles_business_user
  ON public.customer_profiles(business_id, user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_profiles_user_id
  ON public.customer_profiles(user_id) WHERE user_id IS NOT NULL;


-- 2. Deterministic backfill
-- Only set user_id when ALL bookings for the same (business_id, guest_phone)
-- resolve to exactly one user_id. Ambiguous/conflicting mappings stay NULL.

UPDATE public.customer_profiles cp
SET user_id = sub.single_user_id
FROM (
  SELECT b.business_id, b.guest_phone, MIN(b.user_id) AS single_user_id
  FROM public.bookings b
  WHERE b.user_id IS NOT NULL
    AND b.guest_phone IS NOT NULL
    AND b.guest_phone != ''
  GROUP BY b.business_id, b.guest_phone
  HAVING COUNT(DISTINCT b.user_id) = 1
) sub
WHERE cp.business_id = sub.business_id
  AND cp.phone = sub.guest_phone
  AND cp.user_id IS NULL;


-- 3. get_business_transactions()
-- Unified, purpose-aware, tenant-safe financial transaction projection.
-- SECURITY DEFINER to resolve customer from business-owned customer_profiles
-- instead of joining profiles (which RLS correctly blocks for non-own users).

CREATE OR REPLACE FUNCTION public.get_business_transactions(
  p_business_id UUID,
  p_limit INTEGER DEFAULT 500,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  txn_id UUID,
  txn_type TEXT,
  flow_type TEXT,
  reference_code TEXT,
  purpose TEXT,
  customer_name TEXT,
  amount BIGINT,
  status TEXT,
  event_date TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- Ownership check
  IF NOT EXISTS (
    SELECT 1 FROM public.businesses WHERE id = p_business_id AND owner_id = auth.uid()
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  (
    -- Bookings: join services for purpose, guest_name + customer_profiles for customer
    SELECT
      b.id AS txn_id,
      'booking'::TEXT AS txn_type,
      COALESCE(b.flow_type, 'booking')::TEXT AS flow_type,
      b.reference_code::TEXT,
      CASE
        WHEN b.flow_type = 'payment' AND s.service_type = 'giving'
          THEN 'Giving' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
        WHEN b.flow_type = 'payment'
          THEN 'Payment' || E' \u2014 ' || b.reference_code
        WHEN b.flow_type = 'ticketing'
          THEN 'Ticket' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
        WHEN b.flow_type = 'reservation'
          THEN 'Reservation' || E' \u2014 ' || b.reference_code
        ELSE 'Booking' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
      END::TEXT AS purpose,
      COALESCE(b.guest_name, cp.name)::TEXT AS customer_name,
      COALESCE(b.total_amount, b.deposit_amount, 0)::BIGINT AS amount,
      b.status::TEXT,
      b.created_at AS event_date
    FROM public.bookings b
    LEFT JOIN public.services s ON s.id = b.service_id
    LEFT JOIN public.customer_profiles cp
      ON cp.business_id = b.business_id AND cp.phone = b.guest_phone
    WHERE b.business_id = p_business_id

    UNION ALL

    -- Orders: resolve customer from customer_profiles by user_id (primary)
    -- or delivery_phone (fallback). Never from profiles RLS.
    SELECT
      o.id AS txn_id,
      'order'::TEXT AS txn_type,
      'ordering'::TEXT AS flow_type,
      o.reference_code::TEXT,
      ('Order' || E' \u2014 ' || o.reference_code)::TEXT AS purpose,
      COALESCE(cp_u.name, cp_p.name)::TEXT AS customer_name,
      COALESCE(o.total_amount, 0)::BIGINT AS amount,
      o.status::TEXT,
      o.created_at AS event_date
    FROM public.orders o
    LEFT JOIN public.customer_profiles cp_u
      ON cp_u.business_id = o.business_id AND cp_u.user_id = o.user_id
      AND cp_u.user_id IS NOT NULL
    LEFT JOIN public.customer_profiles cp_p
      ON cp_p.business_id = o.business_id AND cp_p.phone = o.delivery_phone
      AND cp_u.id IS NULL
    WHERE o.business_id = p_business_id
      AND o.deleted_at IS NULL

    UNION ALL

    -- Invoices: customer_name is denormalized on the invoice
    SELECT
      inv.id AS txn_id,
      'invoice'::TEXT AS txn_type,
      'invoice'::TEXT AS flow_type,
      inv.reference_code::TEXT,
      ('Invoice' || E' \u2014 ' || inv.reference_code)::TEXT AS purpose,
      inv.customer_name::TEXT AS customer_name,
      COALESCE(inv.amount_paid, inv.total_amount, 0)::BIGINT AS amount,
      inv.status::TEXT,
      COALESCE(inv.paid_at, inv.created_at) AS event_date
    FROM public.invoices inv
    WHERE inv.business_id = p_business_id
  )
  ORDER BY event_date DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;


-- 4. get_customer_history()
-- Per-customer history for the Customer 360 page.
-- Resolves by customer_profiles.id -> user_id (primary) + phone (fallback).

CREATE OR REPLACE FUNCTION public.get_customer_history(
  p_business_id UUID,
  p_customer_profile_id UUID,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  history_type TEXT,
  subject_id UUID,
  reference_code TEXT,
  purpose TEXT,
  amount BIGINT,
  currency TEXT,
  status TEXT,
  event_date TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_phone TEXT;
  v_user_id UUID;
BEGIN
  -- Ownership check
  IF NOT EXISTS (
    SELECT 1 FROM public.businesses WHERE id = p_business_id AND owner_id = auth.uid()
  ) THEN
    RETURN;
  END IF;

  -- Load customer identity
  SELECT cp.phone, cp.user_id INTO v_phone, v_user_id
  FROM public.customer_profiles cp
  WHERE cp.id = p_customer_profile_id AND cp.business_id = p_business_id;

  IF v_phone IS NULL AND v_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  (
    -- Bookings: match by user_id (primary) OR guest_phone (fallback)
    SELECT
      'booking'::TEXT AS history_type,
      b.id AS subject_id,
      b.reference_code::TEXT,
      CASE
        WHEN b.flow_type = 'payment' AND s.service_type = 'giving'
          THEN 'Giving' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
        WHEN b.flow_type = 'payment'
          THEN 'Payment' || E' \u2014 ' || b.reference_code
        WHEN b.flow_type = 'ticketing'
          THEN 'Ticket' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
        WHEN b.flow_type = 'scheduling'
          THEN 'Booking' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
        ELSE COALESCE(initcap(b.flow_type), 'Booking') || E' \u2014 ' || COALESCE(s.name, b.reference_code)
      END::TEXT AS purpose,
      COALESCE(b.total_amount, b.deposit_amount, 0)::BIGINT AS amount,
      'NGN'::TEXT AS currency,
      b.status::TEXT,
      COALESCE(b.date::TIMESTAMPTZ, b.created_at) AS event_date
    FROM public.bookings b
    LEFT JOIN public.services s ON s.id = b.service_id
    WHERE b.business_id = p_business_id
      AND (
        (v_user_id IS NOT NULL AND b.user_id = v_user_id)
        OR (v_phone IS NOT NULL AND b.guest_phone = v_phone)
      )

    UNION ALL

    -- Orders: match by user_id (primary) OR delivery_phone (fallback)
    SELECT
      'order'::TEXT AS history_type,
      o.id AS subject_id,
      o.reference_code::TEXT,
      ('Order' || E' \u2014 ' || o.reference_code)::TEXT AS purpose,
      COALESCE(o.total_amount, 0)::BIGINT AS amount,
      'NGN'::TEXT AS currency,
      o.status::TEXT,
      o.created_at AS event_date
    FROM public.orders o
    WHERE o.business_id = p_business_id
      AND o.deleted_at IS NULL
      AND (
        (v_user_id IS NOT NULL AND o.user_id = v_user_id)
        OR (v_phone IS NOT NULL AND o.delivery_phone = v_phone)
      )

    UNION ALL

    -- Standalone payments (no linked booking — avoids double-counting)
    SELECT
      'payment'::TEXT AS history_type,
      p.id AS subject_id,
      p.gateway_reference::TEXT AS reference_code,
      CASE
        WHEN s.service_type = 'giving'
          THEN 'Giving' || E' \u2014 ' || COALESCE(s.name, p.gateway_reference)
        ELSE 'Payment' || E' \u2014 ' || p.gateway_reference
      END::TEXT AS purpose,
      COALESCE(p.amount, 0)::BIGINT AS amount,
      COALESCE(p.currency, 'NGN')::TEXT AS currency,
      p.status::TEXT,
      COALESCE(p.paid_at, p.created_at) AS event_date
    FROM public.payments p
    LEFT JOIN public.bookings pb ON pb.id = p.booking_id
    LEFT JOIN public.services s ON s.id = pb.service_id
    WHERE p.business_id = p_business_id
      AND p.booking_id IS NULL
      AND v_user_id IS NOT NULL
      AND p.user_id = v_user_id
  )
  ORDER BY event_date DESC
  LIMIT p_limit;
END;
$$;


-- 5. get_business_revenue_totals()
-- Authoritative server-side revenue totals with same inclusion semantics as
-- transaction rows. Page size cannot change revenue.

CREATE OR REPLACE FUNCTION public.get_business_revenue_totals(p_business_id UUID)
RETURNS TABLE (
  booking_revenue BIGINT,
  order_revenue BIGINT,
  invoice_revenue BIGINT,
  total_revenue BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_booking BIGINT;
  v_order BIGINT;
  v_invoice BIGINT;
BEGIN
  -- Ownership check
  IF NOT EXISTS (
    SELECT 1 FROM public.businesses WHERE id = p_business_id AND owner_id = auth.uid()
  ) THEN
    booking_revenue := 0; order_revenue := 0; invoice_revenue := 0; total_revenue := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(SUM(COALESCE(b.total_amount, b.deposit_amount, 0)), 0)::BIGINT INTO v_booking
  FROM public.bookings b
  WHERE b.business_id = p_business_id
    AND b.status NOT IN ('cancelled', 'no_show');

  SELECT COALESCE(SUM(COALESCE(o.total_amount, 0)), 0)::BIGINT INTO v_order
  FROM public.orders o
  WHERE o.business_id = p_business_id
    AND o.deleted_at IS NULL
    AND o.status IN ('confirmed', 'processing', 'ready', 'shipped', 'delivered');

  SELECT COALESCE(SUM(COALESCE(inv.amount_paid, inv.total_amount, 0)), 0)::BIGINT INTO v_invoice
  FROM public.invoices inv
  WHERE inv.business_id = p_business_id
    AND inv.status = 'paid';

  booking_revenue := v_booking;
  order_revenue := v_order;
  invoice_revenue := v_invoice;
  total_revenue := v_booking + v_order + v_invoice;
  RETURN NEXT;
END;
$$;


-- 6. Access control

REVOKE ALL ON FUNCTION public.get_business_transactions(UUID, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_business_transactions(UUID, INTEGER, INTEGER) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_business_revenue_totals(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_business_revenue_totals(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_customer_history(UUID, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_history(UUID, UUID, INTEGER) TO authenticated, service_role;
