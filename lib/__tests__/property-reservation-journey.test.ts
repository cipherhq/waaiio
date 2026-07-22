/**
 * Property & Reservation Journey — Real Database Integration Tests
 *
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/property-reservation-journey.test.ts
 *
 * Tests the full property/reservation lifecycle against a real Supabase database:
 * 1. Create property with required fields
 * 2. Create reservation linked to property
 * 3. Deposit status transitions (pending → paid)
 * 4. Blocked dates prevent overlapping reservations (app-level)
 * 5. Cancel reservation
 * 6. Cross-business RLS isolation
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient; // service-role client (bypasses RLS)
let supabaseUrl: string;
let anonKey: string;

// User A (owner of business A)
let userAId: string;
let bizAId: string;
let propertyAId: string;

// User B (owner of business B — for cross-business isolation test)
let userBId: string;
let bizBId: string;

// Track IDs for cleanup
const createdReservationIds: string[] = [];
const createdBlockedDateIds: string[] = [];

describeIntegration('Property & Reservation Journey — real database', () => {
  beforeAll(async () => {
    supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    let serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

    if (!serviceKey || !anonKey) {
      const { execSync } = await import('child_process');
      const env = execSync('supabase status -o env 2>/dev/null', { encoding: 'utf-8' });
      for (const line of env.split('\n')) {
        if (line.startsWith('SERVICE_ROLE_KEY=')) {
          serviceKey = line.split('=')[1].replace(/"/g, '').trim();
        }
        if (line.startsWith('ANON_KEY=')) {
          anonKey = line.split('=')[1].replace(/"/g, '').trim();
        }
      }
    }

    db = createClient(supabaseUrl, serviceKey);

    const ts = Date.now();

    // Create user A + business A
    const { data: userA } = await db.auth.admin.createUser({
      email: `prop-journey-a-${ts}@test.local`,
      password: 'test-pass-123',
      email_confirm: true,
    });
    userAId = userA.user!.id;

    const { data: bizA } = await db.from('businesses').insert({
      owner_id: userAId,
      name: `Property Test A ${ts}`,
      slug: `prop-test-a-${ts}`,
      address: '100 Property Lane',
      city: 'TestCity',
      neighborhood: 'TestHood',
      phone: '+1000000001',
      status: 'active',
    }).select('id').single();
    bizAId = bizA!.id;

    // Create user B + business B
    const { data: userB } = await db.auth.admin.createUser({
      email: `prop-journey-b-${ts}@test.local`,
      password: 'test-pass-456',
      email_confirm: true,
    });
    userBId = userB.user!.id;

    const { data: bizB } = await db.from('businesses').insert({
      owner_id: userBId,
      name: `Property Test B ${ts}`,
      slug: `prop-test-b-${ts}`,
      address: '200 Other Road',
      city: 'TestCity',
      neighborhood: 'OtherHood',
      phone: '+1000000002',
      status: 'active',
    }).select('id').single();
    bizBId = bizB!.id;
  }, 30000);

  afterAll(async () => {
    if (!db) return;

    // Clean up in dependency order
    if (createdReservationIds.length) {
      await db.from('reservations').delete().in('id', createdReservationIds);
    }
    if (createdBlockedDateIds.length) {
      await db.from('property_blocked_dates').delete().in('id', createdBlockedDateIds);
    }
    // Delete properties for both businesses
    await db.from('properties').delete().eq('business_id', bizAId);
    await db.from('properties').delete().eq('business_id', bizBId);
    // Delete businesses
    await db.from('businesses').delete().eq('id', bizAId);
    await db.from('businesses').delete().eq('id', bizBId);
    // Delete users
    await db.auth.admin.deleteUser(userAId);
    await db.auth.admin.deleteUser(userBId);
  }, 15000);

  // ── 1. Create Property ──────────────────────────────────────────

  describe('Property creation', () => {
    it('creates a property with name, type, price, deposit_amount, max_guests and verifies record', async () => {
      const { data: property, error } = await db.from('properties').insert({
        business_id: bizAId,
        name: 'Oceanview Suite',
        property_type: 'apartment',
        price: 15000,       // nightly rate in cents
        deposit_amount: 5000,
        max_guests: 4,
        bedrooms: 2,
        bathrooms: 1,
        amenities: ['wifi', 'pool', 'parking'],
        description: 'A lovely oceanview suite for integration testing.',
      }).select('*').single();

      expect(error).toBeNull();
      expect(property).not.toBeNull();
      expect(property!.name).toBe('Oceanview Suite');
      expect(property!.property_type).toBe('apartment');
      expect(Number(property!.price)).toBe(15000);
      expect(Number(property!.deposit_amount)).toBe(5000);
      expect(property!.max_guests).toBe(4);
      expect(property!.bedrooms).toBe(2);
      expect(property!.bathrooms).toBe(1);
      expect(property!.amenities).toContain('wifi');
      expect(property!.is_active).toBe(true);
      expect(property!.business_id).toBe(bizAId);

      propertyAId = property!.id;
    });
  });

  // ── 2. Create Reservation ──────────────────────────────────────

  describe('Reservation creation', () => {
    let reservationId: string;

    it('creates a reservation linked to property with correct default status', async () => {
      const { data: reservation, error } = await db.from('reservations').insert({
        business_id: bizAId,
        user_id: userAId,
        property_id: propertyAId,
        check_in: '2026-09-01',
        check_out: '2026-09-05',
        // nights is a generated column — omit it
        guests: 2,
        nightly_rate: 15000,
        total_amount: 60000,
        deposit_amount: 5000,
        deposit_status: 'pending',
        guest_name: 'Test Guest A',
        guest_phone: '+1234567890',
        guest_email: 'guest-a@test.local',
        special_requests: 'Late check-in please',
        channel: 'whatsapp',
      }).select('*').single();

      expect(error).toBeNull();
      expect(reservation).not.toBeNull();
      expect(reservation!.status).toBe('pending'); // default from enum
      expect(reservation!.property_id).toBe(propertyAId);
      expect(reservation!.business_id).toBe(bizAId);
      expect(reservation!.check_in).toBe('2026-09-01');
      expect(reservation!.check_out).toBe('2026-09-05');
      // nights is a generated column (check_out - check_in)
      expect(reservation!.nights).toBe(4);
      expect(reservation!.guests).toBe(2);
      expect(reservation!.nightly_rate).toBe(15000);
      expect(reservation!.total_amount).toBe(60000);
      expect(reservation!.deposit_amount).toBe(5000);
      expect(reservation!.deposit_status).toBe('pending');
      expect(reservation!.guest_name).toBe('Test Guest A');
      expect(reservation!.special_requests).toBe('Late check-in please');

      reservationId = reservation!.id;
      createdReservationIds.push(reservationId);
    });

    // ── 3. Deposit Status Transitions ────────────────────────────

    it('transitions deposit_status from pending to paid', async () => {
      // Verify current state
      const { data: before } = await db.from('reservations')
        .select('deposit_status')
        .eq('id', reservationId)
        .single();
      expect(before!.deposit_status).toBe('pending');

      // Update to paid
      const { error } = await db.from('reservations')
        .update({ deposit_status: 'paid' })
        .eq('id', reservationId);
      expect(error).toBeNull();

      // Verify transition
      const { data: after } = await db.from('reservations')
        .select('deposit_status')
        .eq('id', reservationId)
        .single();
      expect(after!.deposit_status).toBe('paid');
    });

    // ── 5. Cancel Reservation ────────────────────────────────────

    it('cancels a reservation — status changes to cancelled with timestamp', async () => {
      const cancelledAt = new Date().toISOString();

      const { error } = await db.from('reservations')
        .update({
          status: 'cancelled',
          cancelled_at: cancelledAt,
          cancelled_by: 'guest',
        })
        .eq('id', reservationId);
      expect(error).toBeNull();

      const { data: cancelled } = await db.from('reservations')
        .select('status, cancelled_at, cancelled_by')
        .eq('id', reservationId)
        .single();

      expect(cancelled!.status).toBe('cancelled');
      expect(cancelled!.cancelled_at).not.toBeNull();
      expect(cancelled!.cancelled_by).toBe('guest');
    });
  });

  // ── 4. Blocked Dates ──────────────────────────────────────────

  describe('Blocked dates', () => {
    it('inserts a blocked date range for a property', async () => {
      const { data: blocked, error } = await db.from('property_blocked_dates').insert({
        property_id: propertyAId,
        business_id: bizAId,
        date_from: '2026-10-01',
        date_to: '2026-10-10',
        reason: 'Renovation',
      }).select('*').single();

      expect(error).toBeNull();
      expect(blocked).not.toBeNull();
      expect(blocked!.property_id).toBe(propertyAId);
      expect(blocked!.date_from).toBe('2026-10-01');
      expect(blocked!.date_to).toBe('2026-10-10');
      expect(blocked!.reason).toBe('Renovation');

      createdBlockedDateIds.push(blocked!.id);
    });

    it('detects overlap between reservation dates and blocked dates (app-level check)', async () => {
      // Simulate the app-level check: query blocked dates that overlap with desired check-in/check-out
      const desiredCheckIn = '2026-10-05';
      const desiredCheckOut = '2026-10-08';

      // Overlap condition: blocked.date_from < desired.check_out AND blocked.date_to > desired.check_in
      const { data: overlapping } = await db
        .from('property_blocked_dates')
        .select('id, date_from, date_to, reason')
        .eq('property_id', propertyAId)
        .lt('date_from', desiredCheckOut)
        .gt('date_to', desiredCheckIn);

      expect(overlapping).not.toBeNull();
      expect(overlapping!.length).toBeGreaterThan(0);
      expect(overlapping![0].reason).toBe('Renovation');

      // App would reject reservation based on this query result
    });

    it('allows reservation on non-blocked dates (no overlap)', async () => {
      const desiredCheckIn = '2026-10-15';
      const desiredCheckOut = '2026-10-20';

      const { data: overlapping } = await db
        .from('property_blocked_dates')
        .select('id')
        .eq('property_id', propertyAId)
        .lt('date_from', desiredCheckOut)
        .gt('date_to', desiredCheckIn);

      expect(overlapping).not.toBeNull();
      expect(overlapping!.length).toBe(0);

      // No overlap — reservation would be allowed
      const { data: reservation, error } = await db.from('reservations').insert({
        business_id: bizAId,
        user_id: userAId,
        property_id: propertyAId,
        check_in: desiredCheckIn,
        check_out: desiredCheckOut,
        // nights is a generated column — omit it
        guests: 2,
        nightly_rate: 15000,
        total_amount: 75000,
        deposit_amount: 5000,
        deposit_status: 'none',
        guest_name: 'Unblocked Guest',
        guest_phone: '+1555000010',
        channel: 'whatsapp',
      }).select('id, status').single();

      expect(error).toBeNull();
      expect(reservation).not.toBeNull();
      expect(reservation!.status).toBe('pending');
      createdReservationIds.push(reservation!.id);
    });
  });

  // ── 6. Cross-Business RLS Isolation ───────────────────────────

  describe('Cross-business RLS isolation', () => {
    let propertyBId: string;

    it('user B creates a property in business B', async () => {
      // Use service client to create (since we need it for setup)
      const { data: propB, error } = await db.from('properties').insert({
        business_id: bizBId,
        name: 'Mountain Cabin',
        property_type: 'villa',
        price: 20000,
        deposit_amount: 8000,
        max_guests: 6,
      }).select('id').single();

      expect(error).toBeNull();
      propertyBId = propB!.id;
    });

    it('user A (authenticated) cannot mutate user B properties via RLS', async () => {
      // Get user A email from admin API
      const { data: userAData } = await db.auth.admin.getUserById(userAId);
      const emailA = userAData.user!.email!;

      // Sign in as user A with anon key (RLS-enforced client)
      const clientA = createClient(supabaseUrl, anonKey);
      const { error: signInErr } = await clientA.auth.signInWithPassword({
        email: emailA,
        password: 'test-pass-123',
      });
      expect(signInErr).toBeNull();

      // User A can READ user B's active property (public_read_active_properties policy)
      // but CANNOT UPDATE or DELETE it (owner policies require business.owner_id = auth.uid())

      // Attempt to update user B's property — should affect 0 rows
      const { data: updateResult } = await clientA
        .from('properties')
        .update({ name: 'Hacked Name' })
        .eq('id', propertyBId)
        .select('id');

      // RLS silently filters — update returns empty array (no rows matched)
      expect(updateResult).not.toBeNull();
      expect(updateResult!.length).toBe(0);

      // Verify property name unchanged via service client
      const { data: unchanged } = await db.from('properties')
        .select('name')
        .eq('id', propertyBId)
        .single();
      expect(unchanged!.name).toBe('Mountain Cabin');

      // Attempt to delete user B's property — should affect 0 rows
      const { data: deleteResult } = await clientA
        .from('properties')
        .delete()
        .eq('id', propertyBId)
        .select('id');

      expect(deleteResult).not.toBeNull();
      expect(deleteResult!.length).toBe(0);

      // Verify property still exists
      const { data: stillExists } = await db.from('properties')
        .select('id')
        .eq('id', propertyBId)
        .single();
      expect(stillExists).not.toBeNull();
    });

    it('user B (authenticated) CAN read their own properties via RLS', async () => {
      // Get user B email
      const { data: userData } = await db.auth.admin.getUserById(userBId);
      const emailB = userData.user!.email!;

      const clientB = createClient(supabaseUrl, anonKey);
      const { error: signInErr } = await clientB.auth.signInWithPassword({
        email: emailB,
        password: 'test-pass-456',
      });
      expect(signInErr).toBeNull();

      const { data: myProperties } = await clientB
        .from('properties')
        .select('id, business_id, name')
        .eq('business_id', bizBId);

      expect(myProperties).not.toBeNull();
      expect(myProperties!.length).toBe(1);
      expect(myProperties![0].name).toBe('Mountain Cabin');
      expect(myProperties![0].business_id).toBe(bizBId);
    });
  });
}, 60000);

// Sentinel test — always runs to confirm skip/run status
describe('Property & Reservation Journey DB status', () => {
  it(`tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => {
    expect(true).toBe(true);
  });
});
