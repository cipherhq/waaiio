-- Synthetic disposable database fixture; no hosted schema or customer data.

      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;


      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE TYPE flow_type AS ENUM ('scheduling','ordering','ticketing','reservation','payment','queue','chat','waitlist'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE booking_channel AS ENUM ('whatsapp','web','api','recurring'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE reservation_status AS ENUM ('pending','confirmed','cancelled','completed','in_progress','no_show'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE deposit_status AS ENUM ('none','pending','paid','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE payment_source AS ENUM ('whatsapp','web','api','subscription','invoice','manual'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), subscription_tier TEXT DEFAULT 'free', trial_ends_at TIMESTAMPTZ, payout_mode TEXT DEFAULT 'platform');
      CREATE TABLE IF NOT EXISTS customer_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID, user_id UUID,
        service_id UUID, amount NUMERIC(12,2), currency TEXT DEFAULT 'NGN',
        frequency TEXT DEFAULT 'monthly', status TEXT DEFAULT 'active',
        gateway TEXT, authorization_code TEXT, gateway_customer_code TEXT,
        gateway_subscription_code TEXT, customer_name TEXT, customer_phone TEXT,
        customer_email TEXT, card_last_four TEXT, card_brand TEXT,
        next_charge_at TIMESTAMPTZ, last_charged_at TIMESTAMPTZ,
        charge_count INT DEFAULT 0, total_charged NUMERIC(12,2) DEFAULT 0,
        failure_count INT DEFAULT 0, cancelled_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), reference_code TEXT UNIQUE,
        business_id UUID, user_id UUID, service_id UUID, date DATE, time TEXT,
        party_size INT DEFAULT 1, flow_type flow_type DEFAULT 'payment',
        channel booking_channel DEFAULT 'recurring', payment_source payment_source DEFAULT 'subscription',
        deposit_amount NUMERIC(12,2), deposit_status deposit_status DEFAULT 'paid',
        status reservation_status DEFAULT 'confirmed', total_amount NUMERIC(12,2),
        quantity INT DEFAULT 1, guest_name TEXT, guest_phone TEXT, confirmed_at TIMESTAMPTZ, notes TEXT
      );
      CREATE OR REPLACE FUNCTION generate_booking_reference() RETURNS TRIGGER AS $t$
      DECLARE new_code TEXT; BEGIN
        IF NEW.reference_code IS NULL THEN NEW.reference_code := 'BW-R' || LPAD(FLOOR(RANDOM()*100000)::TEXT,5,'0'); END IF;
        RETURN NEW;
      END; $t$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_booking_ref ON bookings;
      CREATE TRIGGER trg_booking_ref BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION generate_booking_reference();

      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID, user_id UUID,
        booking_id UUID, reservation_id UUID, amount NUMERIC(12,2), currency TEXT, gateway TEXT,
        gateway_reference TEXT UNIQUE, status TEXT DEFAULT 'pending',
        gateway_status TEXT, payment_method TEXT, card_last_four TEXT, card_brand TEXT,
        paid_at TIMESTAMPTZ, metadata JSONB, payment_authority_version INT
      );
      CREATE TABLE IF NOT EXISTS subscription_charges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id UUID,
        business_id UUID, user_id UUID, amount NUMERIC(12,2), currency TEXT,
        status TEXT, gateway TEXT, gateway_reference TEXT, payment_id UUID,
        booking_id UUID, charged_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS platform_fees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID,
        booking_id UUID, transaction_amount NUMERIC(12,2), fee_percentage NUMERIC(5,2),
        fee_flat NUMERIC(12,2), fee_total NUMERIC(12,2), tier TEXT
      );
      CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value JSONB);
      CREATE TABLE IF NOT EXISTS processed_webhook_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_id TEXT UNIQUE,
        gateway TEXT, event_type TEXT, status TEXT, attempts INT DEFAULT 1,
        first_received_at TIMESTAMPTZ, last_attempted_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recurring_interval TEXT
      );
      -- #164: spend marker + customer profiles tables
      CREATE TABLE IF NOT EXISTS payment_spend_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID NOT NULL UNIQUE,
        source_type TEXT NOT NULL CHECK (source_type IN ('booking', 'reservation')),
        source_id UUID NOT NULL,
        business_id UUID NOT NULL,
        customer_phone TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS customer_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        phone TEXT NOT NULL,
        name TEXT,
        total_spent NUMERIC(12,2) DEFAULT 0,
        total_visits INT DEFAULT 0,
        total_bookings INT DEFAULT 0,
        last_seen_at TIMESTAMPTZ,
        first_seen_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        UNIQUE(business_id, phone)
      );
      CREATE TABLE IF NOT EXISTS reservations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, guest_phone TEXT, guest_name TEXT, status TEXT DEFAULT 'pending'
      );

      INSERT INTO businesses (id) VALUES ('22aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') ON CONFLICT DO NOTHING;
