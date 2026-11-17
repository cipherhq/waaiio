-- Remove the staging test businesses created by seed-test-businesses.sql (issue #1080).
--
-- STAGING ONLY (Supabase project tqjvrzopvtczxfxiwmnz). Never run on production.
-- Matches only the six fixed ids AND the 'TEST – ' name prefix.
--
-- Default mode is 'retire': suspend and hide from the directory / WhatsApp bot,
-- keeping all history. Set v_mode to 'delete' to hard-delete instead; that
-- refuses (and changes nothing) if any money or booking record exists for
-- them, because those tables intentionally block deletes.

DO $$
DECLARE
  v_mode CONSTANT text := 'retire';  -- 'retire' or 'delete'
  v_ids CONSTANT uuid[] := ARRAY[
    '7e570000-0000-4000-8000-000000000001', '7e570000-0000-4000-8000-000000000002',
    '7e570000-0000-4000-8000-000000000003', '7e570000-0000-4000-8000-000000000004',
    '7e570000-0000-4000-8000-000000000005', '7e570000-0000-4000-8000-000000000006'
  ]::uuid[];
  v_targets uuid[];
  v_blockers text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_channels
     WHERE id = '1f3d8f48-acfb-4c4a-b788-5cc815f19173' AND channel_type = 'shared' AND phone_number = '12404712139'
  ) THEN
    RAISE EXCEPTION 'Staging guard failed: designated staging shared channel not found. Not staging?';
  END IF;

  SELECT array_agg(id) INTO v_targets
    FROM public.businesses
   WHERE id = ANY (v_ids) AND name LIKE 'TEST – %'
     AND owner_id = 'ce910912-79bb-4ebc-8983-f7893cb71e16';
  IF v_targets IS NULL THEN
    RAISE NOTICE 'No test businesses found; nothing to do.';
    RETURN;
  END IF;

  IF v_mode = 'retire' THEN
    UPDATE public.businesses
       SET status = 'suspended', discovery_enabled = false
     WHERE id = ANY (v_targets);
    RETURN;
  END IF;

  IF v_mode <> 'delete' THEN
    RAISE EXCEPTION 'Unknown mode %', v_mode;
  END IF;

  -- Every table whose foreign key to businesses blocks deletes (NO ACTION / RESTRICT).
  SELECT string_agg(t, ', ') INTO v_blockers FROM (
    SELECT 'payments' t WHERE EXISTS (SELECT 1 FROM public.payments WHERE business_id = ANY (v_targets))
    UNION ALL SELECT 'orders' WHERE EXISTS (SELECT 1 FROM public.orders WHERE business_id = ANY (v_targets))
    UNION ALL SELECT 'bookings' WHERE EXISTS (SELECT 1 FROM public.bookings WHERE business_id = ANY (v_targets))
    UNION ALL SELECT 'invoices' WHERE EXISTS (SELECT 1 FROM public.invoices WHERE business_id = ANY (v_targets))
    UNION ALL SELECT 'platform_fees' WHERE EXISTS (SELECT 1 FROM public.platform_fees WHERE business_id = ANY (v_targets))
    UNION ALL SELECT 'business_payouts' WHERE EXISTS (SELECT 1 FROM public.business_payouts WHERE business_id = ANY (v_targets))
    UNION ALL SELECT 'messaging_allowances' WHERE EXISTS (SELECT 1 FROM public.messaging_allowances WHERE business_id = ANY (v_targets))
    UNION ALL SELECT 'message_send_attempts' WHERE EXISTS (SELECT 1 FROM public.message_send_attempts WHERE business_id = ANY (v_targets))
  ) x;
  IF v_blockers IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing hard delete: test businesses have records in %. Use retire mode instead.', v_blockers;
  END IF;

  -- Any other blocking table still raises a foreign-key error, which rolls the
  -- whole block back, so a partial delete cannot happen.
  DELETE FROM public.businesses WHERE id = ANY (v_targets);
END $$;
