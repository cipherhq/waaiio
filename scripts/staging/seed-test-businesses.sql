-- Staging test businesses seed (issue #1080, Owner decision 2026-11-16 on #1079).
--
-- STAGING ONLY (Supabase project tqjvrzopvtczxfxiwmnz). Never run on production.
-- The guard below aborts unless the staging-only shared WhatsApp channel exists.
--
-- Mirrors the app's own sign-up path, in the same order and with the same values:
--   app/api/onboarding/register -> lib/onboarding/provision-business.ts
--     businesses (pending, free, shared) -> reassign_shared_channel (staging
--     designated number) -> whatsapp_config -> business_capabilities ->
--     finalizeOnboarding (canned replies when chat is on; profile role is
--     already restaurant_owner, so no profile write)
--   app/api/onboarding/verify (free plan)
--     subscriptions (free, active, amount 0, gateway null, currency NGN, as the
--     route writes for every free plan) -> businesses.status active ->
--     activate_trial_if_eligible (non-fatal; the 14-day feature trial is set by
--     trg_set_feature_trial_clock at insert)
-- plus a small amount of catalogue data per business, like a merchant would add
-- from the dashboard.
--
-- Shared (Waaiio-owned) payment route only: no merchant keys, no connected
-- accounts, no provider calls. Contact emails use example.com; phone numbers
-- are fictional. All ids are fixed so the script is idempotent and removal is
-- exact (see remove-test-businesses.sql). Runs as one atomic DO block.

DO $$
DECLARE
  -- Owner login for all six businesses (coordinator decision on #1080).
  v_owner CONSTANT uuid := 'ce910912-79bb-4ebc-8983-f7893cb71e16';
  v_channel CONSTANT uuid := '1f3d8f48-acfb-4c4a-b788-5cc815f19173';
  v_hours CONSTANT jsonb := '{"monday":{"open":"09:00","close":"18:00"},"tuesday":{"open":"09:00","close":"18:00"},"wednesday":{"open":"09:00","close":"18:00"},"thursday":{"open":"09:00","close":"18:00"},"friday":{"open":"09:00","close":"18:00"},"saturday":{"open":"10:00","close":"16:00"},"sunday":{"open":"10:00","close":"16:00","closed":true}}';
  v_biz record;
  v_result jsonb;
  v_greeting text;
BEGIN
  -- ── Guards ──
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_channels
     WHERE id = v_channel AND channel_type = 'shared' AND phone_number = '12404712139'
  ) THEN
    RAISE EXCEPTION 'Staging guard failed: designated staging shared channel not found. Not staging?';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_owner AND role = 'restaurant_owner') THEN
    RAISE EXCEPTION 'Owner profile % not found or not a merchant', v_owner;
  END IF;

  -- ── 1. Businesses (as provisionPendingBusiness inserts them) ──
  DROP TABLE IF EXISTS pg_temp._seed_biz;
  CREATE TEMP TABLE _seed_biz ON COMMIT DROP AS
  SELECT * FROM (VALUES
    ('7e570000-0000-4000-8000-000000000001'::uuid, 'TEST – Lagos Kitchen', 'test-lagos-kitchen', 'TEST-LAGOS-KITCHEN',
     'restaurant'::public.business_category, 'NG', 'Lagos', 'Lagos', '1 Test Street, Victoria Island', '+2340000000001', 'Africa/Lagos', 'paystack', 500000::bigint,
     'Test restaurant for ordering, table booking and loyalty.'),
    ('7e570000-0000-4000-8000-000000000002', 'TEST – Glow Beauty Studio', 'test-glow-beauty-studio', 'TEST-GLOW-BEAUTY',
     'salon', 'NG', 'Lagos', 'Lagos', '2 Test Street, Lekki', '+2340000000002', 'Africa/Lagos', 'paystack', 500000,
     'Test salon for appointments, deposits, staff and packages.'),
    ('7e570000-0000-4000-8000-000000000003', 'TEST – Grace Community Church', 'test-grace-community-church', 'TEST-GRACE-CHURCH',
     'church', 'NG', 'Abuja', 'FCT', '3 Test Street, Wuse', '+2340000000003', 'Africa/Lagos', 'paystack', 500000,
     'Test church for giving, fundraising, polls and surveys.'),
    ('7e570000-0000-4000-8000-000000000004', 'TEST – Brooklyn Live Events', 'test-brooklyn-live-events', 'TEST-BROOKLYN-EVENTS',
     'events', 'US', 'Brooklyn', 'NY', '4 Test Street', '+12025550104', 'America/New_York', 'stripe', 5000,
     'Test events business for ticket sales and waitlists.'),
    ('7e570000-0000-4000-8000-000000000005', 'TEST – London Fitness Club', 'test-london-fitness-club', 'TEST-LONDON-FITNESS',
     'gym', 'GB', 'London', NULL, '5 Test Street', '+442079460105', 'Europe/London', 'stripe', 4000,
     'Test gym for classes, memberships, appointments and queues.'),
    ('7e570000-0000-4000-8000-000000000006', 'TEST – Austin Home Services', 'test-austin-home-services', 'TEST-AUSTIN-HOME',
     'handyman', 'US', 'Austin', 'TX', '6 Test Street', '+12025550106', 'America/Chicago', 'stripe', 5000,
     'Test home services for quotes, invoices, contracts and recurring visits.')
  ) AS t(id, name, slug, bot_code, category, country_code, city, state, address, phone, timezone, gateway, payout_limit, description);

  FOR v_biz IN SELECT s.*, ct.flow_type AS template_flow, ct.default_greeting
                 FROM _seed_biz s
                 JOIN public.category_templates ct ON ct.key = s.category::text AND ct.is_active
  LOOP
    INSERT INTO public.businesses (
      id, owner_id, name, slug, bot_code, city, state, address, phone, email, category, flow_type,
      country_code, wa_method, subscription_tier, status, payment_gateway, verification_level,
      payout_limit_monthly, timezone, operating_hours, description, discovery_description,
      discovery_keywords, metadata
    ) VALUES (
      v_biz.id, v_owner, v_biz.name, v_biz.slug, v_biz.bot_code, v_biz.city, v_biz.state, v_biz.address,
      v_biz.phone, 'test-' || replace(v_biz.slug, 'test-', '') || '@example.com', v_biz.category,
      v_biz.template_flow::public.flow_type, v_biz.country_code, 'shared', 'free', 'pending', v_biz.gateway,
      'basic', v_biz.payout_limit, v_biz.timezone, v_hours, v_biz.description, v_biz.description,
      ARRAY['test'], jsonb_build_object('staging_test_seed', 'issue-1080')
    ) ON CONFLICT (id) DO NOTHING;

    -- ── 2. Shared channel (staging designated number, same RPC as the app) ──
    IF (SELECT assigned_channel_id FROM public.businesses WHERE id = v_biz.id) IS DISTINCT FROM v_channel THEN
      v_result := public.reassign_shared_channel(v_biz.id, v_channel);
      IF NOT COALESCE((v_result ->> 'reassigned')::boolean, false) THEN
        RAISE EXCEPTION 'Channel assignment failed for %: %', v_biz.name, v_result;
      END IF;
    END IF;

    -- ── 3. WhatsApp config ──
    v_greeting := COALESCE(replace(v_biz.default_greeting, '{{name}}', v_biz.name),
                           'Welcome to ' || v_biz.name || '! How can I help you today?');
    INSERT INTO public.whatsapp_config (business_id, bot_greeting, bot_alias, auto_confirm)
    VALUES (v_biz.id, v_greeting, NULL, true)
    ON CONFLICT (business_id) DO NOTHING;
  END LOOP;

  IF (SELECT count(*) FROM public.businesses WHERE id IN (SELECT id FROM _seed_biz)) <> 6 THEN
    RAISE EXCEPTION 'Expected 6 test businesses after insert';
  END IF;

  -- ── 4. Capabilities (explicit list, as register does when capabilities are chosen) ──
  INSERT INTO public.business_capabilities (business_id, capability, is_enabled)
  SELECT b::uuid, c::public.capability_type, true FROM (VALUES
    ('7e570000-0000-4000-8000-000000000001', ARRAY['ordering','payment','table_reservation','feedback','chat','loyalty']),
    ('7e570000-0000-4000-8000-000000000002', ARRAY['appointment','payment','staff','reminders','packages','waitlist','feedback','chat','auto_reply']),
    ('7e570000-0000-4000-8000-000000000003', ARRAY['giving','crowdfunding','poll','survey','broadcast','chat']),
    ('7e570000-0000-4000-8000-000000000004', ARRAY['ticketing','payment','waitlist','feedback','chat']),
    ('7e570000-0000-4000-8000-000000000005', ARRAY['class_booking','membership','appointment','queue','payment','chat']),
    ('7e570000-0000-4000-8000-000000000006', ARRAY['scheduling','invoice','estimates','whatsapp_sign','recurring','payment','chat'])
  ) AS t(b, caps), unnest(caps) AS c
  ON CONFLICT (business_id, capability) DO NOTHING;

  -- ── 5. finalizeOnboarding: default canned replies (all six have chat) ──
  INSERT INTO public.canned_responses (business_id, title, message_text, sort_order)
  SELECT s.id, cr.title, cr.message_text, cr.sort_order
    FROM _seed_biz s
   CROSS JOIN (VALUES
     ('Thanks for waiting', 'Thanks for your patience! How can I help you?', 0),
     ('Operating hours', 'Our operating hours are Monday - Saturday, 9am - 6pm.', 1),
     ('Price inquiry', 'I''d be happy to help with pricing! What are you interested in?', 2),
     ('How to book', 'I can help you get started. Would you like to proceed?', 3),
     ('Follow up', 'Just following up on our conversation. Is there anything else I can help with?', 4)
   ) AS cr(title, message_text, sort_order)
   WHERE NOT EXISTS (SELECT 1 FROM public.canned_responses x WHERE x.business_id = s.id);

  -- ── 6. Free-plan verify: subscription row, then activation ──
  INSERT INTO public.subscriptions (business_id, plan, status, amount, gateway, currency,
                                    current_period_start, current_period_end)
  SELECT id, 'free', 'active', 0, NULL, 'NGN', now(), now() + interval '30 days'
    FROM _seed_biz
  ON CONFLICT (business_id) DO NOTHING;

  UPDATE public.businesses SET status = 'active', subscription_tier = 'free'
   WHERE id IN (SELECT id FROM _seed_biz) AND status = 'pending';

  -- Messaging-credit trial (non-fatal in the app; returns phone_not_verified
  -- and writes nothing when the owner has no confirmed phone).
  PERFORM public.activate_trial_if_eligible(id) FROM _seed_biz;

  -- ── 7. Catalogue data ──
  -- Products (prices are in major units, as the dashboard stores them)
  INSERT INTO public.products (id, business_id, name, description, price, category, sort_order) VALUES
    ('7e570001-0000-4000-8000-000000001001', '7e570000-0000-4000-8000-000000000001', 'Jollof Rice & Chicken', 'Test menu item', 4500, 'Mains', 0),
    ('7e570001-0000-4000-8000-000000001002', '7e570000-0000-4000-8000-000000000001', 'Pounded Yam & Egusi', 'Test menu item', 5500, 'Mains', 1),
    ('7e570001-0000-4000-8000-000000001003', '7e570000-0000-4000-8000-000000000001', 'Suya Platter', 'Test menu item', 6000, 'Grills', 2),
    ('7e570001-0000-4000-8000-000000001004', '7e570000-0000-4000-8000-000000000001', 'Chapman', 'Test drink', 1500, 'Drinks', 3),
    ('7e570001-0000-4000-8000-000000001005', '7e570000-0000-4000-8000-000000000001', 'Puff Puff (6 pcs)', 'Test snack', 1000, 'Snacks', 4)
  ON CONFLICT (id) DO NOTHING;

  -- Services
  INSERT INTO public.services (id, business_id, name, description, price, duration_minutes,
                               deposit_required, deposit_amount, billing_type, recurring_interval, max_capacity, sort_order) VALUES
    ('7e570002-0000-4000-8000-000000005002', '7e570000-0000-4000-8000-000000000005', 'Group HIIT Class', 'Test group class', 12, 45, false, 0, 'one_time', NULL, 15, 0),
    ('7e570002-0000-4000-8000-000000006001', '7e570000-0000-4000-8000-000000000006', 'Handyman Visit (1 hour)', 'Test service', 85, 60, false, 0, 'one_time', NULL, NULL, 0),
    ('7e570002-0000-4000-8000-000000006002', '7e570000-0000-4000-8000-000000000006', 'Lawn Care (monthly)', 'Test recurring service', 120, 90, false, 0, 'recurring', 'monthly', NULL, 1),
    ('7e570002-0000-4000-8000-000000006003', '7e570000-0000-4000-8000-000000000006', 'Kitchen Repair Quote', 'Test service, price varies', 0, 60, false, 0, 'one_time', NULL, NULL, 2)
  ON CONFLICT (id) DO NOTHING;
  UPDATE public.services SET price_is_variable = true
   WHERE id = '7e570002-0000-4000-8000-000000006003' AND price_is_variable IS DISTINCT FROM true;
  -- The gym class backs class_booking (sessions are scheduled from the dashboard).
  UPDATE public.services SET is_class = true, class_schedule = '[]'::jsonb
   WHERE id = '7e570002-0000-4000-8000-000000005002' AND is_class IS DISTINCT FROM true;

  -- Giving options (church; the bot's giving menu reads services with service_type 'giving')
  INSERT INTO public.services (id, business_id, name, description, price, price_is_variable, duration_minutes, service_type, sort_order) VALUES
    ('7e570002-0000-4000-8000-000000003001', '7e570000-0000-4000-8000-000000000003', 'TEST Tithe', 'Test giving option, any amount', 0, true, 0, 'giving', 0),
    ('7e570002-0000-4000-8000-000000003002', '7e570000-0000-4000-8000-000000000003', 'TEST Thanksgiving Offering', 'Test giving option, fixed amount', 5000, false, 0, 'giving', 1)
  ON CONFLICT (id) DO NOTHING;

  -- Appointment types (salon and gym; back the appointment capability)
  INSERT INTO public.appointments (id, business_id, name, description, price, duration_minutes, deposit_amount, is_active, sort_order) VALUES
    ('7e570008-0000-4000-8000-000000002001', '7e570000-0000-4000-8000-000000000002', 'Wash & Blow-dry', 'Test appointment', 8000, 60, 0, true, 0),
    ('7e570008-0000-4000-8000-000000002002', '7e570000-0000-4000-8000-000000000002', 'Knotless Braids', 'Test appointment with deposit', 25000, 240, 5000, true, 1),
    ('7e570008-0000-4000-8000-000000002003', '7e570000-0000-4000-8000-000000000002', 'Gel Manicure', 'Test appointment', 6000, 45, 0, true, 2),
    ('7e570008-0000-4000-8000-000000002004', '7e570000-0000-4000-8000-000000000002', 'Lash Extensions', 'Test appointment', 15000, 90, 0, true, 3),
    ('7e570008-0000-4000-8000-000000005001', '7e570000-0000-4000-8000-000000000005', 'Personal Training Session', 'Test appointment', 50, 60, 0, true, 0),
    ('7e570008-0000-4000-8000-000000005002', '7e570000-0000-4000-8000-000000000005', 'Fitness Assessment', 'Test appointment', 0, 30, 0, true, 1)
  ON CONFLICT (id) DO NOTHING;

  -- Tables (restaurant; back table_reservation)
  INSERT INTO public.seating_resources (id, business_id, name, resource_type, capacity, min_party_size, reservation_duration_minutes, deposit_amount, is_active, sort_order) VALUES
    ('7e570009-0000-4000-8000-000000001001', '7e570000-0000-4000-8000-000000000001', 'TEST Table for 2', 'table', 2, 1, 90, 0, true, 0),
    ('7e570009-0000-4000-8000-000000001002', '7e570000-0000-4000-8000-000000000001', 'TEST Family Table', 'table', 6, 3, 120, 0, true, 1)
  ON CONFLICT (id) DO NOTHING;

  -- Staff (salon)
  INSERT INTO public.business_staff (id, business_id, name, email, role, is_active) VALUES
    ('7e570003-0000-4000-8000-000000002001', '7e570000-0000-4000-8000-000000000002', 'Test Stylist Ada', 'stylist-ada@example.com', 'stylist', true),
    ('7e570003-0000-4000-8000-000000002002', '7e570000-0000-4000-8000-000000000002', 'Test Stylist Bisi', 'stylist-bisi@example.com', 'stylist', true)
  ON CONFLICT (id) DO NOTHING;

  -- Events (published, future dates) and ticket types
  INSERT INTO public.events (id, business_id, name, description, date, time, venue, price, total_tickets, max_per_order, status) VALUES
    ('7e570004-0000-4000-8000-000000004001', '7e570000-0000-4000-8000-000000000004', 'TEST Winter Jazz Night', 'Test event', '2026-12-12', '19:00', 'Test Hall, Brooklyn', 0, 150, 6, 'published'),
    ('7e570004-0000-4000-8000-000000004002', '7e570000-0000-4000-8000-000000000004', 'TEST New Year Comedy Show', 'Test event', '2027-01-16', '20:00', 'Test Theatre, Brooklyn', 25, 120, 6, 'published')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.event_ticket_types (id, event_id, name, price, total_tickets, sort_order, is_active) VALUES
    ('7e570005-0000-4000-8000-000000004011', '7e570004-0000-4000-8000-000000004001', 'Free RSVP', 0, 100, 0, true),
    ('7e570005-0000-4000-8000-000000004012', '7e570004-0000-4000-8000-000000004001', 'VIP', 40, 50, 1, true),
    ('7e570005-0000-4000-8000-000000004021', '7e570004-0000-4000-8000-000000004002', 'General', 25, 100, 0, true),
    ('7e570005-0000-4000-8000-000000004022', '7e570004-0000-4000-8000-000000004002', 'Front Row', 60, 20, 1, true)
  ON CONFLICT (id) DO NOTHING;

  -- Fundraising campaigns (church; backs crowdfunding). goal_amount 0 = no goal, as the dashboard writes.
  INSERT INTO public.campaigns (id, business_id, title, description, goal_amount, currency, start_date, status) VALUES
    ('7e570006-0000-4000-8000-000000003001', '7e570000-0000-4000-8000-000000000003', 'TEST Building Fund', 'Test fundraising campaign with a goal', 1000000, 'NGN', current_date, 'active'),
    ('7e570006-0000-4000-8000-000000003002', '7e570000-0000-4000-8000-000000000003', 'TEST Sunday Offering', 'Test giving campaign without a goal', 0, 'NGN', current_date, 'active')
  ON CONFLICT (id) DO NOTHING;

  -- Poll (draft, as the polls API creates it; the owner activates it from the dashboard)
  INSERT INTO public.polls (id, business_id, question, options, status) VALUES
    ('7e570007-0000-4000-8000-000000003001', '7e570000-0000-4000-8000-000000000003', 'TEST: Which service time suits you best?', '["8am", "10am", "12pm"]', 'draft')
  ON CONFLICT (id) DO NOTHING;
END $$;
