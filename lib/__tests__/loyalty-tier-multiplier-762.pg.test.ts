/**
 * Disposable PG test: loyalty tier multiplier in apply_payment_loyalty_once (#762 W17)
 *
 * Exercises the actual M484-corrected RPC against a real PostgreSQL database.
 * The CI job clones pg_template_clean (minimal schema). This test provisions
 * the required tables, applies the M484 function, and tears down afterward.
 *
 * Requires TEST_DATABASE_URL or REQUIRE_PG_TESTS=true.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// TEST_DATABASE_URL is provided per-file by the CI PG runner.
// REQUIRE_PG_TESTS=true in CI means these must execute, not skip.
const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl) {
  // Outside CI: skip gracefully. In CI: this file is run with TEST_DATABASE_URL set.
  console.warn('[762] TEST_DATABASE_URL not set — PG tests will be skipped');
}

function psql(sql: string): string {
  return execSync(`psql "${dbUrl!}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

const BIZ = '00000000-0000-0762-0001-000000000001';
const BIZ2 = '00000000-0000-0762-0001-000000000002';
const BOOKING = '00000000-0000-0762-0002-000000000001';
const PHONE = '+2341234567890';

describe.skipIf(!dbUrl)('#762 loyalty tier multiplier (disposable PG)', () => {
  beforeAll(() => {
    // Provision required schema on top of the minimal CI template.
    // The businesses table already exists but needs metadata + subscription_tier columns.
    psql(`
      -- Add columns the RPC needs that the minimal schema lacks
      ALTER TABLE public.businesses
        ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'free';

      -- Payments
      CREATE TABLE IF NOT EXISTS public.payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        booking_id UUID,
        reservation_id UUID,
        order_id UUID,
        invoice_id UUID,
        campaign_id UUID,
        gateway TEXT DEFAULT 'paystack',
        currency TEXT DEFAULT 'NGN'
      );

      -- Bookings (minimal: just what the RPC needs)
      CREATE TABLE IF NOT EXISTS public.bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES public.businesses(id),
        guest_phone TEXT,
        guest_name TEXT,
        service_id UUID,
        date DATE,
        time TEXT,
        status TEXT DEFAULT 'completed'
      );

      -- Customer profiles
      CREATE TABLE IF NOT EXISTS public.customer_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id),
        phone TEXT NOT NULL,
        name TEXT,
        total_spent NUMERIC(12,2) DEFAULT 0,
        total_visits INTEGER DEFAULT 0,
        membership_tier_id UUID,
        UNIQUE(business_id, phone)
      );

      -- Membership tiers
      CREATE TABLE IF NOT EXISTS public.membership_tiers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id),
        name VARCHAR(50) NOT NULL,
        min_spend NUMERIC NOT NULL DEFAULT 0,
        discount_percent NUMERIC NOT NULL DEFAULT 0,
        points_multiplier NUMERIC NOT NULL DEFAULT 1,
        benefits TEXT,
        color VARCHAR(20) DEFAULT '#6B7280',
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- FK for tier reference
      ALTER TABLE public.customer_profiles
        ADD CONSTRAINT fk_customer_profiles_tier
        FOREIGN KEY (membership_tier_id) REFERENCES public.membership_tiers(id) ON DELETE SET NULL;

      -- Loyalty points
      CREATE TABLE IF NOT EXISTS public.loyalty_points (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id),
        customer_phone TEXT NOT NULL,
        customer_name TEXT,
        points_balance INTEGER DEFAULT 0 NOT NULL,
        total_earned INTEGER DEFAULT 0 NOT NULL,
        total_redeemed INTEGER DEFAULT 0 NOT NULL,
        visit_count INTEGER DEFAULT 0 NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE(business_id, customer_phone)
      );

      -- Loyalty transactions
      CREATE TABLE IF NOT EXISTS public.loyalty_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id),
        customer_phone TEXT NOT NULL,
        points_change INTEGER NOT NULL,
        reason TEXT,
        reference_id TEXT,
        reference_type TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      -- Payment loyalty applications (exactly-once marker)
      CREATE TABLE IF NOT EXISTS public.payment_loyalty_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID NOT NULL UNIQUE,
        business_id UUID NOT NULL,
        customer_phone TEXT NOT NULL,
        points_awarded INTEGER NOT NULL DEFAULT 0,
        points_mode TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      -- Grant service_role access
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    `);

    // Apply the M484 migration (the corrected RPC)
    const migration = readFileSync(
      resolve(__dirname, '../../supabase/migrations/484_fix_loyalty_tier_multiplier.sql'),
      'utf-8'
    );
    psql(migration);

    // Seed auth users (FK target for businesses.owner_id)
    psql(`
      INSERT INTO auth.users (id) VALUES
        ('00000000-0000-0762-9001-000000000001'),
        ('00000000-0000-0762-9001-000000000002')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed test businesses
    psql(`
      INSERT INTO public.businesses (id, name, owner_id, metadata)
      VALUES
        ('${BIZ}', 'Tier Test Biz', '00000000-0000-0762-9001-000000000001',
         '{"loyalty_earning_enabled": true, "loyalty_points_mode": "per_visit", "loyalty_points_per_visit": 10}'::jsonb),
        ('${BIZ2}', 'Other Biz', '00000000-0000-0762-9001-000000000002', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterEach(() => {
    psql(`
      DELETE FROM public.payment_loyalty_applications WHERE business_id IN ('${BIZ}', '${BIZ2}');
      DELETE FROM public.loyalty_transactions WHERE business_id IN ('${BIZ}', '${BIZ2}');
      DELETE FROM public.loyalty_points WHERE business_id IN ('${BIZ}', '${BIZ2}');
      DELETE FROM public.customer_profiles WHERE business_id IN ('${BIZ}', '${BIZ2}');
      DELETE FROM public.membership_tiers WHERE business_id IN ('${BIZ}', '${BIZ2}');
      DELETE FROM public.payments WHERE booking_id IN (SELECT id FROM public.bookings WHERE business_id IN ('${BIZ}', '${BIZ2}'));
      DELETE FROM public.bookings WHERE business_id IN ('${BIZ}', '${BIZ2}');
    `);
  });

  afterAll(() => {
    psql(`
      DELETE FROM public.businesses WHERE id IN ('${BIZ}', '${BIZ2}');
      DELETE FROM auth.users WHERE id IN ('00000000-0000-0762-9001-000000000001', '00000000-0000-0762-9001-000000000002');
    `);
  });

  function seedBookingAndPayment(amount = 5000): string {
    psql(`
      INSERT INTO public.bookings (id, business_id, guest_phone, guest_name, date, time, status)
      VALUES ('${BOOKING}', '${BIZ}', '${PHONE}', 'Test Customer', '2099-01-01', '10:00', 'completed');
    `);
    const payId = psql(`
      INSERT INTO public.payments (amount, status, booking_id, gateway, currency)
      VALUES (${amount}, 'success', '${BOOKING}', 'paystack', 'NGN')
      RETURNING id;
    `);
    return payId;
  }

  function callRpc(paymentId: string): Record<string, unknown> {
    const raw = psql(`SELECT apply_payment_loyalty_once('${paymentId}'::uuid);`);
    return JSON.parse(raw);
  }

  it('applies Gold tier 2x multiplier to base per-visit points', () => {
    const tierId = psql(`
      INSERT INTO public.membership_tiers (business_id, name, min_spend, points_multiplier, is_active, sort_order)
      VALUES ('${BIZ}', 'Gold', 0, 2, true, 1) RETURNING id;
    `);
    psql(`
      INSERT INTO public.customer_profiles (business_id, phone, name, membership_tier_id)
      VALUES ('${BIZ}', '${PHONE}', 'Test', '${tierId}');
    `);
    const payId = seedBookingAndPayment();
    const result = callRpc(payId);
    expect(result.applied).toBe(true);
    expect(result.already_applied).toBe(false);
    expect(result.points_awarded).toBe(20); // 10 base * 2x
  });

  it('uses default 1x when customer has no profile', () => {
    const payId = seedBookingAndPayment();
    const result = callRpc(payId);
    expect(result.applied).toBe(true);
    expect(result.points_awarded).toBe(10);
  });

  it('uses default 1x when customer has no tier assigned', () => {
    psql(`
      INSERT INTO public.customer_profiles (business_id, phone, name, membership_tier_id)
      VALUES ('${BIZ}', '${PHONE}', 'Test', NULL);
    `);
    const payId = seedBookingAndPayment();
    const result = callRpc(payId);
    expect(result.applied).toBe(true);
    expect(result.points_awarded).toBe(10);
  });

  it('uses default 1x when assigned tier is inactive', () => {
    const tierId = psql(`
      INSERT INTO public.membership_tiers (business_id, name, min_spend, points_multiplier, is_active, sort_order)
      VALUES ('${BIZ}', 'Inactive Gold', 0, 3, false, 1) RETURNING id;
    `);
    psql(`
      INSERT INTO public.customer_profiles (business_id, phone, name, membership_tier_id)
      VALUES ('${BIZ}', '${PHONE}', 'Test', '${tierId}');
    `);
    const payId = seedBookingAndPayment();
    const result = callRpc(payId);
    expect(result.applied).toBe(true);
    expect(result.points_awarded).toBe(10);
  });

  it('uses default 1x when tier belongs to different business (tenant isolation)', () => {
    const tierId = psql(`
      INSERT INTO public.membership_tiers (business_id, name, min_spend, points_multiplier, is_active, sort_order)
      VALUES ('${BIZ2}', 'Other Gold', 0, 5, true, 1) RETURNING id;
    `);
    psql(`
      INSERT INTO public.customer_profiles (business_id, phone, name, membership_tier_id)
      VALUES ('${BIZ}', '${PHONE}', 'Test', '${tierId}');
    `);
    const payId = seedBookingAndPayment();
    const result = callRpc(payId);
    expect(result.applied).toBe(true);
    expect(result.points_awarded).toBe(10);
  });

  it('replay idempotency: exactly one marker, one ledger entry, correct balance/earned/visits', () => {
    const payId = seedBookingAndPayment();
    const first = callRpc(payId);
    expect(first.applied).toBe(true);
    expect(first.already_applied).toBe(false);
    expect(first.points_awarded).toBe(10);
    // Replay
    const second = callRpc(payId);
    expect(second.applied).toBe(true);
    expect(second.already_applied).toBe(true);
    // Durable state: exactly one marker
    const markerCount = psql(`SELECT COUNT(*) FROM public.payment_loyalty_applications WHERE payment_id = '${payId}';`);
    expect(Number(markerCount)).toBe(1);
    // Exactly one transaction
    const txCount = psql(`SELECT COUNT(*) FROM public.loyalty_transactions WHERE business_id = '${BIZ}' AND customer_phone = '${PHONE}';`);
    expect(Number(txCount)).toBe(1);
    // Correct balance, lifetime earned, visit count (not doubled)
    const loyalty = psql(`SELECT points_balance, total_earned, visit_count FROM public.loyalty_points WHERE business_id = '${BIZ}' AND customer_phone = '${PHONE}';`);
    const [balance, earned, visits] = loyalty.split('|');
    expect(Number(balance)).toBe(10);
    expect(Number(earned)).toBe(10);
    expect(Number(visits)).toBe(1);
  });

  it('concurrent calls: two simultaneous RPC calls produce exactly one award', () => {
    const payId = seedBookingAndPayment();
    // Run two concurrent psql calls
    const { execSync: exec } = require('child_process');
    const cmd1 = `psql "${dbUrl}" -tAXq -c "SELECT apply_payment_loyalty_once('${payId}'::uuid);"`;
    const cmd2 = `psql "${dbUrl}" -tAXq -c "SELECT apply_payment_loyalty_once('${payId}'::uuid);"`;
    // Fire both in parallel using shell background
    const result = exec(
      `echo "$(${cmd1} & ${cmd2} & wait)"`,
      { encoding: 'utf-8', timeout: 15000, shell: '/bin/bash' }
    ).trim();
    // Parse both results
    const lines = result.split('\n').filter(Boolean);
    const results = lines.map((l: string) => JSON.parse(l));
    // Exactly one should be first-apply, one should be already_applied
    const firstApply = results.filter((r: any) => r.applied && !r.already_applied);
    const replays = results.filter((r: any) => r.applied && r.already_applied);
    expect(firstApply.length + replays.length).toBe(2);
    expect(firstApply.length).toBe(1);
    expect(replays.length).toBe(1);
    // Durable: exactly one marker, one transaction, correct balance
    const markerCount = psql(`SELECT COUNT(*) FROM public.payment_loyalty_applications WHERE payment_id = '${payId}';`);
    expect(Number(markerCount)).toBe(1);
    const loyalty = psql(`SELECT points_balance FROM public.loyalty_points WHERE business_id = '${BIZ}' AND customer_phone = '${PHONE}';`);
    expect(Number(loyalty)).toBe(10);
  });

  it('records transaction with correct multiplied points_awarded', () => {
    const tierId = psql(`
      INSERT INTO public.membership_tiers (business_id, name, min_spend, points_multiplier, is_active, sort_order)
      VALUES ('${BIZ}', 'Silver', 0, 1.5, true, 1) RETURNING id;
    `);
    psql(`
      INSERT INTO public.customer_profiles (business_id, phone, name, membership_tier_id)
      VALUES ('${BIZ}', '${PHONE}', 'Test', '${tierId}');
    `);
    const payId = seedBookingAndPayment();
    callRpc(payId);
    const tx = psql(`
      SELECT points_change, reason FROM public.loyalty_transactions
      WHERE business_id = '${BIZ}' AND customer_phone = '${PHONE}'
      ORDER BY created_at DESC LIMIT 1;
    `);
    const [points, reason] = tx.split('|');
    expect(Number(points)).toBe(15); // floor(10 * 1.5)
    expect(reason).toBe('visit');
  });

  it('floors the multiplied result (no rounding up)', () => {
    psql(`UPDATE public.businesses SET metadata = '{"loyalty_earning_enabled": true, "loyalty_points_mode": "per_amount", "loyalty_points_per_currency": 100}'::jsonb WHERE id = '${BIZ}';`);
    const tierId = psql(`
      INSERT INTO public.membership_tiers (business_id, name, min_spend, points_multiplier, is_active, sort_order)
      VALUES ('${BIZ}', 'Silver', 0, 1.5, true, 1) RETURNING id;
    `);
    psql(`
      INSERT INTO public.customer_profiles (business_id, phone, name, membership_tier_id)
      VALUES ('${BIZ}', '${PHONE}', 'Test', '${tierId}');
    `);
    const payId = seedBookingAndPayment(550);
    const result = callRpc(payId);
    expect(result.points_awarded).toBe(7); // floor(floor(550/100) * 1.5) = floor(5 * 1.5) = 7
    // Restore metadata
    psql(`UPDATE public.businesses SET metadata = '{"loyalty_earning_enabled": true, "loyalty_points_mode": "per_visit", "loyalty_points_per_visit": 10}'::jsonb WHERE id = '${BIZ}';`);
  });

  it('ACL: anon role cannot execute the function', () => {
    const payId = seedBookingAndPayment();
    try {
      psql(`SET ROLE anon; SELECT apply_payment_loyalty_once('${payId}'::uuid); RESET ROLE;`);
      expect.unreachable('anon should not be able to execute');
    } catch (err: any) {
      expect(err.message || String(err)).toContain('permission denied');
    }
  });

  it('ACL: authenticated role cannot execute the function', () => {
    const payId = seedBookingAndPayment();
    try {
      psql(`SET ROLE authenticated; SELECT apply_payment_loyalty_once('${payId}'::uuid); RESET ROLE;`);
      expect.unreachable('authenticated should not be able to execute');
    } catch (err: any) {
      expect(err.message || String(err)).toContain('permission denied');
    }
  });

  it('ACL: service_role can execute the function', () => {
    const payId = seedBookingAndPayment();
    // Should not throw — service_role has EXECUTE privilege
    const raw = psql(`SET ROLE service_role; SELECT apply_payment_loyalty_once('${payId}'::uuid); RESET ROLE;`);
    const result = JSON.parse(raw);
    expect(result.applied).toBe(true);
  });
});
