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

-- Backfill strategy:
--   a) avoids MIN(uuid) which does not exist in all PostgreSQL versions;
--   b) only considers (business_id, guest_phone) pairs with exactly one distinct user_id;
--   c) globally collision-safe: when multiple initially-unlinked customer_profiles rows
--      (different phones) resolve to the same (business_id, user_id), only the first
--      candidate (by cp.id) is linked. Others are left unlinked to preserve history
--      and avoid partial unique index violation.
--   d) also skips if another cp row already has that user_id (pre-existing linkage).

WITH candidates AS (
  -- Step 1: find unambiguous phone→user_id mappings from bookings
  SELECT DISTINCT ON (agg.business_id, agg.guest_phone)
    agg.business_id, agg.guest_phone, agg.the_user_id AS single_user_id
  FROM (
    SELECT b.business_id, b.guest_phone, b.user_id AS the_user_id
    FROM public.bookings b
    WHERE b.user_id IS NOT NULL
      AND b.guest_phone IS NOT NULL
      AND b.guest_phone != ''
    GROUP BY b.business_id, b.guest_phone, b.user_id
  ) agg
  WHERE (
    SELECT COUNT(DISTINCT b2.user_id)
    FROM public.bookings b2
    WHERE b2.business_id = agg.business_id
      AND b2.guest_phone = agg.guest_phone
      AND b2.user_id IS NOT NULL
  ) = 1
),
matched AS (
  -- Step 2: match candidates to customer_profiles rows, then pick exactly
  -- one winner per (business_id, single_user_id) to prevent partial unique
  -- index collision when multiple phones map to the same durable user
  SELECT DISTINCT ON (c.business_id, c.single_user_id)
    cp.id AS cp_id, c.single_user_id
  FROM candidates c
  JOIN public.customer_profiles cp
    ON cp.business_id = c.business_id
    AND cp.phone = c.guest_phone
    AND cp.user_id IS NULL
  -- Skip if another cp row in same business already has this user_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.customer_profiles cp2
    WHERE cp2.business_id = c.business_id
      AND cp2.user_id = c.single_user_id
  )
  ORDER BY c.business_id, c.single_user_id, cp.id  -- deterministic: first by id wins
)
UPDATE public.customer_profiles cp
SET user_id = m.single_user_id
FROM matched m
WHERE cp.id = m.cp_id;


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
    -- Bookings: join services for purpose, resolve customer from guest_name
    -- or customer_profiles with durable-ID-first (phone fallback only when
    -- source booking user_id IS NULL)
    SELECT
      b.id AS txn_id,
      'booking'::TEXT AS txn_type,
      COALESCE(b.flow_type::TEXT, 'booking') AS flow_type,
      b.reference_code::TEXT,
      CASE
        WHEN b.flow_type = 'payment' AND s.service_type = 'giving'
          THEN 'Giving' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
        WHEN b.flow_type = 'payment'
          THEN 'Payment' || E' \u2014 ' || b.reference_code
        WHEN b.flow_type = 'ticketing'
          THEN 'Ticket' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
        ELSE 'Booking' || E' \u2014 ' || COALESCE(s.name, b.reference_code)
      END::TEXT AS purpose,
      COALESCE(b.guest_name, cp_u.name, cp_p.name)::TEXT AS customer_name,
      COALESCE(b.total_amount, b.deposit_amount, 0)::BIGINT AS amount,
      b.status::TEXT,
      b.created_at AS event_date
    FROM public.bookings b
    LEFT JOIN public.services s ON s.id = b.service_id
    LEFT JOIN public.customer_profiles cp_u
      ON cp_u.business_id = b.business_id AND cp_u.user_id = b.user_id
      AND b.user_id IS NOT NULL
    LEFT JOIN public.customer_profiles cp_p
      ON cp_p.business_id = b.business_id AND cp_p.phone = b.guest_phone
      AND b.user_id IS NULL       -- source must be legacy (no durable identity)
      AND cp_p.user_id IS NULL    -- target must also be unlinked (not owned by another user)
    WHERE b.business_id = p_business_id

    UNION ALL

    -- Orders: resolve customer from customer_profiles by user_id (primary)
    -- or delivery_phone (fallback ONLY when source order has no user_id).
    -- Never from profiles RLS.
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
      AND o.user_id IS NOT NULL
    LEFT JOIN public.customer_profiles cp_p
      ON cp_p.business_id = o.business_id AND cp_p.phone = o.delivery_phone
      AND o.user_id IS NULL       -- source must be legacy (no durable identity)
      AND cp_p.user_id IS NULL    -- target must also be unlinked (not owned by another user)
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
    -- Bookings: durable user_id primary; phone fallback ONLY for legacy rows
    -- where source booking has no user_id (prevents cross-attribution on shared phones)
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
        ELSE COALESCE(initcap(b.flow_type::TEXT), 'Booking') || E' \u2014 ' || COALESCE(s.name, b.reference_code)
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
        OR (v_phone IS NOT NULL AND b.user_id IS NULL AND b.guest_phone = v_phone)
      )

    UNION ALL

    -- Orders: durable user_id primary; phone fallback ONLY for legacy rows
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
        OR (v_phone IS NOT NULL AND o.user_id IS NULL AND o.delivery_phone = v_phone)
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

  -- Booking revenue: payment-aware net settlement.
  -- Payment-backed bookings: only count successful payments, minus completed refunds.
  -- Non-payment bookings: use booking total_amount/deposit_amount (scheduling, etc.).
  -- Deduplication: DISTINCT ON (booking_id) picks the successful payment when
  -- multiple attempts exist (failed → retry → success).
  SELECT COALESCE(SUM(net_amount), 0)::BIGINT INTO v_booking
  FROM (
    -- Payment-backed bookings: net = settled - completed_refunds
    SELECT DISTINCT ON (p.booking_id)
      GREATEST(
        CASE WHEN p.status = 'success' THEN p.amount ELSE 0 END
        - COALESCE((
          SELECT SUM(r.amount) FROM public.refunds r
          WHERE r.payment_id = p.id AND r.status = 'success'
        ), 0),
        0
      ) AS net_amount
    FROM public.payments p
    JOIN public.bookings b ON b.id = p.booking_id
    WHERE p.business_id = p_business_id
      AND p.booking_id IS NOT NULL
      AND b.status NOT IN ('cancelled', 'no_show')
    ORDER BY p.booking_id, (p.status = 'success') DESC, p.created_at DESC

    UNION ALL

    -- Non-payment bookings: no linked payment row
    SELECT COALESCE(b.total_amount, b.deposit_amount, 0) AS net_amount
    FROM public.bookings b
    WHERE b.business_id = p_business_id
      AND b.status NOT IN ('cancelled', 'no_show')
      AND NOT EXISTS (
        SELECT 1 FROM public.payments p WHERE p.booking_id = b.id
      )
  ) sub;

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


-- 7. Defense-in-depth: harden create_recurring_offer RPC (#224)
-- Add service-level validation so bypassing application checks cannot create
-- an invalid recurring offer for a one-time, inactive, or non-Giving service.

CREATE OR REPLACE FUNCTION public.create_recurring_offer(
  p_source_payment_id UUID,
  p_business_id UUID,
  p_provider TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
  v_new_id UUID;
  v_amount INTEGER;
  v_currency VARCHAR(3);
  v_user_id UUID;
  v_service_id UUID;
  v_service RECORD;
BEGIN
  -- Validate provider
  IF p_provider != 'paystack' THEN
    RETURN jsonb_build_object('created', false, 'reason', 'unsupported_provider');
  END IF;

  -- Load authoritative values from source payment and its associated booking
  SELECT p.amount, p.currency, p.user_id, b.service_id
  INTO v_amount, v_currency, v_user_id, v_service_id
  FROM public.payments p
  INNER JOIN public.bookings b ON b.id = p.booking_id
  WHERE p.id = p_source_payment_id
    AND p.business_id = p_business_id
    AND p.gateway = p_provider
    AND p.status = 'success'
    AND p.finalization_completed_at IS NOT NULL
    AND p.confirmation_sent_at IS NOT NULL
    AND b.flow_type = 'payment'
    AND b.business_id = p_business_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('created', false, 'reason', 'payment_not_eligible');
  END IF;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('created', false, 'reason', 'payment_missing_user');
  END IF;

  -- Defense-in-depth: validate the source service (#224)
  IF v_service_id IS NULL THEN
    RETURN jsonb_build_object('created', false, 'reason', 'no_service');
  END IF;

  SELECT s.billing_type, s.recurring_interval, s.service_type, s.is_active, s.business_id
  INTO v_service
  FROM public.services s
  WHERE s.id = v_service_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('created', false, 'reason', 'service_not_found');
  END IF;

  -- Service must belong to the same business
  IF v_service.business_id != p_business_id THEN
    RETURN jsonb_build_object('created', false, 'reason', 'service_wrong_business');
  END IF;

  -- Service must be a Giving category
  IF v_service.service_type != 'giving' THEN
    RETURN jsonb_build_object('created', false, 'reason', 'service_not_giving');
  END IF;

  -- Service must be active
  IF NOT v_service.is_active THEN
    RETURN jsonb_build_object('created', false, 'reason', 'service_inactive');
  END IF;

  -- Service must be configured as recurring with a supported interval
  IF v_service.billing_type != 'recurring' OR v_service.recurring_interval IS NULL THEN
    RETURN jsonb_build_object('created', false, 'reason', 'service_not_recurring');
  END IF;

  IF v_service.recurring_interval NOT IN ('weekly', 'monthly') THEN
    RETURN jsonb_build_object('created', false, 'reason', 'unsupported_interval');
  END IF;

  -- Check for existing active subscription
  IF v_service_id IS NOT NULL THEN
    PERFORM id FROM public.customer_subscriptions
    WHERE business_id = p_business_id AND user_id = v_user_id
      AND service_id = v_service_id AND status = 'active';
  ELSE
    PERFORM id FROM public.customer_subscriptions
    WHERE business_id = p_business_id AND user_id = v_user_id
      AND service_id IS NULL AND status = 'active';
  END IF;

  IF FOUND THEN
    RETURN jsonb_build_object('created', false, 'reason', 'active_subscription_exists');
  END IF;

  -- Idempotent insert
  INSERT INTO public.recurring_setup_intents (
    source_payment_id, business_id, user_id, service_id,
    amount, currency, provider
  ) VALUES (
    p_source_payment_id, p_business_id, v_user_id, v_service_id,
    v_amount, v_currency, p_provider
  )
  ON CONFLICT (source_payment_id) DO NOTHING
  RETURNING id INTO v_new_id;

  IF v_new_id IS NOT NULL THEN
    RETURN jsonb_build_object('created', true, 'intent_id', v_new_id);
  END IF;

  -- Existing intent — return its current state
  SELECT id, status, expires_at INTO v_intent
  FROM public.recurring_setup_intents
  WHERE source_payment_id = p_source_payment_id;

  RETURN jsonb_build_object(
    'created', false,
    'reason', 'already_exists',
    'intent_id', v_intent.id,
    'status', v_intent.status,
    'expired', v_intent.expires_at < NOW()
  );
END;
$$;
