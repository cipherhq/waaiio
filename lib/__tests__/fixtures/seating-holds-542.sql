      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TYPE flow_type AS ENUM ('scheduling', 'payment', 'ordering', 'ticketing', 'reservation', 'appointment', 'queue');
      CREATE TYPE reservation_status AS ENUM ('pending', 'confirmed', 'in_progress', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'completed');
      CREATE TYPE booking_channel AS ENUM ('whatsapp', 'dashboard', 'api');
      CREATE TYPE deposit_status AS ENUM ('none', 'pending', 'paid');
      CREATE TABLE businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID,
        name TEXT NOT NULL DEFAULT 'Test Business',
        timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
        operating_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'
      );
      CREATE TABLE profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reference_code VARCHAR(10) UNIQUE,
        business_id UUID NOT NULL REFERENCES businesses(id),
        user_id UUID NOT NULL REFERENCES profiles(id),
        service_id UUID, appointment_id UUID, staff_id UUID, staff_name TEXT,
        date DATE NOT NULL,
        time TIME NOT NULL,
        party_size INTEGER NOT NULL DEFAULT 1,
        flow_type flow_type,
        channel booking_channel NOT NULL DEFAULT 'whatsapp',
        deposit_amount INTEGER NOT NULL DEFAULT 0,
        deposit_status deposit_status NOT NULL DEFAULT 'none',
        status reservation_status NOT NULL DEFAULT 'pending',
        total_amount INTEGER NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 1,
        guest_name TEXT, guest_phone TEXT, guest_email TEXT, special_requests TEXT,
        venue_address TEXT, end_date DATE, addons_snapshot JSONB, promo_code_id UUID,
        location_id UUID, class_session_id UUID, original_date DATE, original_time TEXT,
        rescheduled_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'::jsonb,
        bot_session_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE OR REPLACE FUNCTION public.generate_reference_code() RETURNS TRIGGER AS $$
      BEGIN NEW.reference_code := 'BW-' || substr(md5(random()::text), 1, 7); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER set_reference_code BEFORE INSERT ON bookings FOR EACH ROW
        WHEN (NEW.reference_code IS NULL) EXECUTE FUNCTION generate_reference_code();
      CREATE TABLE services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id),
        name TEXT, price INTEGER DEFAULT 0, deposit_amount INTEGER DEFAULT 0, is_active BOOLEAN DEFAULT true,
        max_capacity INTEGER DEFAULT 1, duration_minutes INTEGER DEFAULT 30, is_class BOOLEAN DEFAULT false,
        requires_staff BOOLEAN DEFAULT false, staff_ids TEXT[], metadata JSONB DEFAULT '{}', class_schedule JSONB,
        auto_approve BOOLEAN DEFAULT true
      );
      CREATE TABLE appointments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id),
        name TEXT, requires_staff BOOLEAN DEFAULT false, available_days TEXT[], available_from TIME, available_to TIME
      );
      CREATE TABLE business_staff (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id),
        name TEXT, is_active BOOLEAN DEFAULT true, schedule JSONB DEFAULT '{}'
      );
      CREATE TABLE class_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id),
        service_id UUID REFERENCES services(id), date DATE, start_time TIME, capacity INTEGER DEFAULT 10,
        status TEXT DEFAULT 'scheduled', staff_id UUID, location_id UUID
      );
      CREATE OR REPLACE FUNCTION check_staff_availability(p_staff_id UUID, p_biz UUID, p_date DATE, p_time TEXT, p_dur INTEGER DEFAULT 30)
        RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$ BEGIN RETURN QUERY SELECT true, 'ok'; END $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION check_appointment_schedule(p_appt UUID, p_biz UUID, p_date DATE, p_time TEXT)
        RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$ BEGIN RETURN QUERY SELECT true, 'ok'; END $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION public.has_admin_role(roles TEXT[]) RETURNS BOOLEAN AS $$ BEGIN RETURN false; END $$ LANGUAGE plpgsql;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ BEGIN RETURN nullif(current_setting('request.jwt.claim.sub',true),'')::uuid; END $$ LANGUAGE plpgsql;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$ BEGIN RETURN 'service_role'; END $$ LANGUAGE plpgsql;
