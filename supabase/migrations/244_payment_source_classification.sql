-- Payment source classification
--
-- Adds payment_source to bookings to distinguish the business workflow origin
-- of a payment-related booking. This is separate from channel (delivery method).
--
-- channel = HOW the interaction happened (whatsapp, web, api, dashboard)
-- payment_source = WHY the booking exists (payment_request, subscription, booking, etc.)
--
-- Safety:
--   - Column is nullable TEXT with CHECK constraint (not enum, for extensibility)
--   - Backfill uses conservative heuristics documented per-rule
--   - Ambiguous records are left NULL (not misclassified)
--   - No records are deleted
--   - Migration is idempotent (IF NOT EXISTS, WHERE payment_source IS NULL guards)

-- ── Step 1: Add payment_source column ──
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS payment_source TEXT;

-- CHECK constraint: restrict values to known sources
-- Using DO block for idempotency (constraint may already exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bookings_payment_source_check'
      AND conrelid = 'public.bookings'::regclass
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_payment_source_check
      CHECK (payment_source IS NULL OR payment_source IN (
        'payment_request', 'subscription', 'booking', 'invoice',
        'event', 'order', 'donation', 'other'
      ));
  END IF;
END $$;

-- Index for filtering by payment_source (used by Payment Requests page)
CREATE INDEX IF NOT EXISTS idx_bookings_payment_source
  ON public.bookings (business_id, payment_source, created_at DESC)
  WHERE payment_source IS NOT NULL;

-- ── Step 2: Backfill existing records ──
-- Each UPDATE only touches rows where payment_source IS NULL (idempotent).

-- Rule 1: Dashboard-created payment requests
-- Signature: flow_type='payment', service_id IS NULL, time='00:00', status='confirmed'
-- Dashboard send/route.ts never sets service_id, uses time='00:00' placeholder,
-- and creates bookings with status='confirmed'. Bot-created bookings start as
-- 'pending' and have service_id set from the selected service.
UPDATE public.bookings
SET payment_source = 'payment_request'
WHERE flow_type = 'payment'
  AND payment_source IS NULL
  AND service_id IS NULL
  AND time = '00:00'
  AND status = 'confirmed';

-- Rule 2: WhatsApp bot payment requests
-- Signature: flow_type='payment', channel='whatsapp', service_id IS NOT NULL
-- Bot payment flow (payment.flow.ts) always sets service_id from selected service
-- and channel='whatsapp'.
UPDATE public.bookings
SET payment_source = 'payment_request'
WHERE flow_type = 'payment'
  AND payment_source IS NULL
  AND channel = 'whatsapp'
  AND service_id IS NOT NULL;

-- Rule 3: Recurring subscription charges
-- Signature: flow_type='payment', notes starts with 'Recurring'
-- Both Stripe webhook (stripe-webhook/route.ts:378,696) and Paystack RPC
-- (migration 233:111) set notes = 'Recurring {frequency} charge [...]'
-- Note: channel='recurring' may or may not be in the enum; notes is safer.
UPDATE public.bookings
SET payment_source = 'subscription'
WHERE flow_type = 'payment'
  AND payment_source IS NULL
  AND notes LIKE 'Recurring %';

-- Rule 4: Event/ticketing bookings
UPDATE public.bookings
SET payment_source = 'event'
WHERE flow_type = 'ticketing'
  AND payment_source IS NULL;

-- Rule 5: Scheduling/appointment bookings (deposits)
UPDATE public.bookings
SET payment_source = 'booking'
WHERE flow_type IN ('scheduling', 'appointment')
  AND payment_source IS NULL;

-- Rule 6: Order bookings
UPDATE public.bookings
SET payment_source = 'order'
WHERE flow_type = 'ordering'
  AND payment_source IS NULL;

-- Rule 7: Reservation bookings
UPDATE public.bookings
SET payment_source = 'booking'
WHERE flow_type = 'reservation'
  AND payment_source IS NULL;

-- ── Step 3: Update process_recurring_charge RPC to set payment_source ──
-- The existing RPC (migration 233) inserts bookings without payment_source.
-- Replace it to include payment_source='subscription' on new inserts.
CREATE OR REPLACE FUNCTION process_recurring_charge(
  p_event_id        TEXT,
  p_event_type      TEXT,
  p_gateway_ref     TEXT,
  p_auth_code       TEXT,
  p_cust_code       TEXT,
  p_amount_kobo     BIGINT,
  p_currency        TEXT DEFAULT 'NGN',
  p_channel         TEXT DEFAULT 'card',
  p_card_last_four  TEXT DEFAULT NULL,
  p_card_brand      TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub              RECORD;
  v_charge_amount    NUMERIC(12,2);
  v_now              TIMESTAMPTZ := NOW();
  v_today            DATE := CURRENT_DATE;
  v_time             TEXT;
  v_booking_id       UUID;
  v_booking_ref      TEXT;
  v_payment_id       UUID;
  v_next_charge      TIMESTAMPTZ;
  v_business         RECORD;
  v_fee_pct          NUMERIC(5,2);
  v_fee_flat         NUMERIC(12,2);
  v_fee_total        NUMERIC(12,2);
  v_is_in_trial      BOOLEAN;
  v_tier             TEXT;
  v_claimed_status   TEXT;
  v_claimed_attempts INT;
BEGIN
  -- ── 1. Claim the webhook event (atomic dedup) ──
  INSERT INTO processed_webhook_events (event_id, gateway, event_type, status, attempts, first_received_at, last_attempted_at)
  VALUES (p_event_id, 'paystack', p_event_type, 'processing', 1, v_now, v_now)
  ON CONFLICT (event_id) DO UPDATE
    SET attempts = processed_webhook_events.attempts + 1,
        last_attempted_at = v_now
  RETURNING status, attempts INTO v_claimed_status, v_claimed_attempts;

  IF v_claimed_status = 'completed' THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'already_completed');
  END IF;

  IF v_claimed_status = 'processing' AND v_claimed_attempts > 2 THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'already_processing');
  END IF;

  -- ── 2. Check gateway reference uniqueness on payments ──
  IF EXISTS (SELECT 1 FROM payments WHERE gateway_reference = p_gateway_ref AND status = 'success') THEN
    UPDATE processed_webhook_events
      SET status = 'completed', completed_at = v_now
      WHERE event_id = p_event_id;
    RETURN jsonb_build_object('skipped', true, 'reason', 'payment_exists');
  END IF;

  -- ── 3. Find the matching active subscription ──
  IF p_auth_code IS NOT NULL AND p_auth_code != '' THEN
    SELECT * INTO v_sub FROM customer_subscriptions
      WHERE authorization_code = p_auth_code AND status = 'active'
      LIMIT 1;
  ELSIF p_cust_code IS NOT NULL AND p_cust_code != '' THEN
    SELECT * INTO v_sub FROM customer_subscriptions
      WHERE gateway_customer_code = p_cust_code AND status = 'active'
      LIMIT 1;
  END IF;

  IF v_sub IS NULL THEN
    UPDATE processed_webhook_events
      SET status = 'failed', last_error = 'No matching active subscription', last_attempted_at = v_now
      WHERE event_id = p_event_id;
    RETURN jsonb_build_object('skipped', true, 'reason', 'no_subscription');
  END IF;

  v_charge_amount := p_amount_kobo / 100.0;
  v_time := TO_CHAR(v_now, 'HH24:MI');

  -- ── 4. Create booking record (with payment_source) ──
  INSERT INTO bookings (
    business_id, user_id, service_id, date, time, party_size,
    flow_type, channel, payment_source, deposit_amount, deposit_status, status,
    total_amount, quantity, guest_name, guest_phone, confirmed_at, notes
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_sub.service_id, v_today, v_time, 1,
    'payment', 'recurring', 'subscription', v_charge_amount, 'paid', 'confirmed',
    v_charge_amount, 1, COALESCE(v_sub.customer_name, ''), COALESCE(v_sub.customer_phone, ''),
    v_now, 'Recurring ' || v_sub.frequency || ' charge'
  )
  RETURNING id, reference_code INTO v_booking_id, v_booking_ref;

  -- ── 5. Create payment record ──
  INSERT INTO payments (
    business_id, user_id, booking_id, amount, currency, gateway,
    gateway_reference, status, gateway_status, payment_method,
    card_last_four, card_brand, paid_at, metadata
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_booking_id, v_charge_amount, v_sub.currency, 'paystack',
    p_gateway_ref, 'success', 'success', p_channel,
    COALESCE(p_card_last_four, v_sub.card_last_four), COALESCE(p_card_brand, v_sub.card_brand),
    v_now, jsonb_build_object('recurring', true, 'subscription_id', v_sub.id)
  )
  RETURNING id INTO v_payment_id;

  -- ── 6. Log subscription charge ──
  INSERT INTO subscription_charges (
    subscription_id, business_id, user_id, amount, currency,
    status, gateway, gateway_reference, payment_id, booking_id, charged_at
  ) VALUES (
    v_sub.id, v_sub.business_id, v_sub.user_id, v_charge_amount, v_sub.currency,
    'success', 'paystack', p_gateway_ref, v_payment_id, v_booking_id, v_now
  );

  -- ── 7. Record platform fee ──
  SELECT subscription_tier, trial_ends_at, payout_mode
    INTO v_business
    FROM businesses WHERE id = v_sub.business_id;

  IF v_business IS NOT NULL AND COALESCE(v_business.payout_mode, 'platform') != 'direct_split' THEN
    v_is_in_trial := v_business.trial_ends_at > v_now;
    v_tier := COALESCE(v_business.subscription_tier, 'free');

    IF v_is_in_trial THEN
      v_fee_pct := 0; v_fee_flat := 0; v_fee_total := 0;
    ELSE
      SELECT
        COALESCE((value::jsonb -> v_tier ->> 'feePercentage')::numeric, CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END),
        COALESCE((value::jsonb -> v_tier ->> 'feeFlat')::numeric, 0)
      INTO v_fee_pct, v_fee_flat
      FROM platform_settings WHERE key = 'pricing_tiers' LIMIT 1;

      IF v_fee_pct IS NULL THEN
        v_fee_pct := CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END;
        v_fee_flat := 0;
      END IF;

      IF v_fee_flat > 0 AND v_charge_amount > 0 AND v_fee_flat / v_charge_amount > 0.10 THEN
        v_fee_flat := 0;
      END IF;

      v_fee_total := ROUND(v_charge_amount * v_fee_pct / 100, 2) + v_fee_flat;
    END IF;

    INSERT INTO platform_fees (
      business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier
    ) VALUES (
      v_sub.business_id, v_booking_id, v_charge_amount, v_fee_pct, v_fee_flat, v_fee_total, v_tier
    );
  END IF;

  -- ── 8. Update subscription totals and next charge date ──
  IF v_sub.frequency = 'weekly' THEN
    v_next_charge := v_now + INTERVAL '7 days';
  ELSE
    v_next_charge := v_now + INTERVAL '1 month';
  END IF;

  UPDATE customer_subscriptions SET
    charge_count = COALESCE(charge_count, 0) + 1,
    total_charged = COALESCE(total_charged, 0) + v_charge_amount,
    last_charged_at = v_now,
    next_charge_at = v_next_charge,
    failure_count = 0
  WHERE id = v_sub.id;

  -- ── 9. Mark event completed ──
  UPDATE processed_webhook_events
    SET status = 'completed', completed_at = v_now
    WHERE event_id = p_event_id;

  -- ── 10. Return data needed for non-critical notifications ──
  RETURN jsonb_build_object(
    'success', true,
    'subscription_id', v_sub.id,
    'booking_id', v_booking_id,
    'booking_ref', v_booking_ref,
    'payment_id', v_payment_id,
    'amount', v_charge_amount,
    'currency', v_sub.currency,
    'business_id', v_sub.business_id,
    'customer_phone', v_sub.customer_phone,
    'customer_name', v_sub.customer_name
  );

EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION process_recurring_charge FROM PUBLIC;
GRANT EXECUTE ON FUNCTION process_recurring_charge TO service_role;

-- Remaining: Any flow_type='payment' rows not matched by rules 1-3 are left
-- with payment_source IS NULL. These are ambiguous records that could not be
-- classified from existing fields alone. The Payment Requests page excludes them
-- (shows only payment_source = 'payment_request'). The Payments Received page
-- shows them if they have a successful payment record.

-- ── Step 4: Add RLS policy for payments via business_id ──
--
-- GAP: The existing "Owners view business payments" policy (migration 002) only
-- allows SELECT where booking_id matches a business's bookings:
--
--   USING (booking_id IN (SELECT b.id FROM bookings b JOIN businesses biz
--          ON b.business_id = biz.id WHERE biz.owner_id = auth.uid()))
--
-- This means payments with booking_id IS NULL are invisible to business owners.
-- This can occur when:
--   - A booking insert fails but the payment was already created
--   - A scan-to-pay payment has no associated booking
--   - A pending transfer confirmation creates a payment without a booking
--
-- The payments table has a business_id column (added in migration 010, backfilled
-- from bookings, and set by all gateway insert paths). Adding a policy via
-- business_id ensures business owners can see ALL their payments.
--
-- This does NOT weaken tenant isolation — it uses the same ownership chain
-- (business_id → businesses.owner_id = auth.uid()) as the bookings policy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'payments' AND policyname = 'Owners view payments by business'
  ) THEN
    CREATE POLICY "Owners view payments by business"
      ON public.payments FOR SELECT
      USING (
        business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
      );
  END IF;
END $$;

-- ── Preview queries (for pre-deploy verification) ──
-- Run these SELECT queries before applying the migration to verify row counts:
--
-- Dashboard requests (Rule 1):
--   SELECT COUNT(*) FROM bookings WHERE flow_type='payment' AND service_id IS NULL
--     AND time='00:00' AND status='confirmed' AND payment_source IS NULL;
--
-- WhatsApp requests (Rule 2):
--   SELECT COUNT(*) FROM bookings WHERE flow_type='payment' AND channel='whatsapp'
--     AND service_id IS NOT NULL AND payment_source IS NULL;
--
-- Subscriptions (Rule 3):
--   SELECT COUNT(*) FROM bookings WHERE flow_type='payment'
--     AND notes LIKE 'Recurring %' AND payment_source IS NULL;
--
-- Unclassified (should be 0 or small):
--   SELECT COUNT(*) FROM bookings WHERE flow_type='payment' AND payment_source IS NULL;
