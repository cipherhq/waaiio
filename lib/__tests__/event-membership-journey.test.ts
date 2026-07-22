/**
 * Event Ticketing & Membership/Package Journey — Real Database Integration Tests
 *
 * Run:
 *   eval "$(supabase status -o env 2>/dev/null)"
 *   SUPABASE_INTEGRATION=true NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *     npx vitest run lib/__tests__/event-membership-journey.test.ts --reporter=verbose
 *
 * Tests:
 *   - Event ticketing lifecycle (create, verify, check-in, duplicate rejection, isolation)
 *   - Membership/package lifecycle (enroll, deduct, replay protection, expiry)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testUserId: string;
let testBizId: string;
let testServiceId: string;
let testEventId: string;
let testEvent2Id: string;
let testBookingId: string;
let testBooking2Id: string;
let testBooking3Id: string;

// IDs for cleanup
const cleanupTicketIds: string[] = [];
const cleanupTicketTypeIds: string[] = [];
const cleanupEnrollmentIds: string[] = [];
const cleanupPackageIds: string[] = [];

describeIntegration('Event Ticketing & Membership/Package Journey — real database', () => {
  beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    let key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!key) {
      const { execSync } = await import('child_process');
      const env = execSync('supabase status -o env 2>/dev/null', { encoding: 'utf-8' });
      const keyLine = env.split('\n').find(l => l.startsWith('SERVICE_ROLE_KEY='));
      key = keyLine ? keyLine.split('=')[1].replace(/"/g, '').trim() : '';
    }
    db = createClient(url, key);

    const ts = Date.now();

    // Create test user
    const { data: user } = await db.auth.admin.createUser({
      email: `evt-pkg-${ts}@test.local`,
      password: 'test-123',
      email_confirm: true,
    });
    testUserId = user.user!.id;

    // Create test business
    const { data: biz } = await db.from('businesses').insert({
      owner_id: testUserId,
      name: `EvtPkg Test ${ts}`,
      slug: `evtpkg-test-${ts}`,
      address: '456 Test Ave',
      city: 'TestCity',
      neighborhood: 'TestHood',
      phone: '+1234567890',
      status: 'active',
    }).select('id').single();
    testBizId = biz!.id;

    // Create test service (for package tests)
    const { data: svc } = await db.from('services').insert({
      business_id: testBizId,
      name: 'Test Massage',
      price: 8000,
      duration_minutes: 60,
      max_capacity: 3,
      is_active: true,
    }).select('id').single();
    testServiceId = svc!.id;

    // Create two events (for isolation test)
    const { data: evt1 } = await db.from('events').insert({
      business_id: testBizId,
      name: `Concert ${ts}`,
      date: '2026-12-01',
      time: '19:00',
      venue: 'Test Arena',
      total_tickets: 500,
      price: 10000,
      status: 'published',
    }).select('id').single();
    testEventId = evt1!.id;

    const { data: evt2 } = await db.from('events').insert({
      business_id: testBizId,
      name: `Workshop ${ts}`,
      date: '2026-12-15',
      time: '10:00',
      venue: 'Test Hall',
      total_tickets: 50,
      price: 5000,
      status: 'published',
    }).select('id').single();
    testEvent2Id = evt2!.id;

    // Create bookings (event_tickets FK requires a booking)
    const makeBooking = async (suffix: string) => {
      const { data, error } = await db.from('bookings').insert({
        business_id: testBizId,
        user_id: testUserId,
        service_id: testServiceId,
        reference_code: `BK${suffix}${String(ts).slice(-6)}`,
        date: '2026-12-01',
        time: '10:00',
        party_size: 1,
        status: 'confirmed',
        guest_name: `Guest ${suffix}`,
        guest_phone: `+1000000${suffix}`,
      }).select('id').single();
      if (error) throw new Error(`Failed to create booking: ${error.message}`);
      return data!.id;
    };

    testBookingId = await makeBooking('001');
    testBooking2Id = await makeBooking('002');
    testBooking3Id = await makeBooking('003');
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    // Clean up in dependency order
    await db.from('package_session_log').delete().in('enrollment_id', cleanupEnrollmentIds);
    await db.from('package_enrollments').delete().in('id', cleanupEnrollmentIds);
    await db.from('service_packages').delete().in('id', cleanupPackageIds);
    await db.from('event_tickets').delete().in('id', cleanupTicketIds);
    await db.from('event_ticket_types').delete().in('id', cleanupTicketTypeIds);
    await db.from('bookings').delete().eq('business_id', testBizId);
    await db.from('events').delete().eq('business_id', testBizId);
    await db.from('services').delete().eq('business_id', testBizId);
    await db.from('businesses').delete().eq('id', testBizId);
    await db.auth.admin.deleteUser(testUserId);
  }, 15000);

  // ── Event Ticketing Lifecycle ───────────────────────────────────────

  describe('Event ticketing lifecycle', () => {
    let ticketTypeId: string;
    const ticketCode = `TK${String(Date.now()).slice(-8)}`;
    let ticketId: string;

    it('1. creates event + ticket_type and verifies both exist', async () => {
      // Event already created in beforeAll — create a ticket type for it
      const { data: tt, error } = await db.from('event_ticket_types').insert({
        event_id: testEventId,
        name: 'VIP',
        price: 25000,
        total_tickets: 50,
        tickets_sold: 0,
      }).select().single();

      expect(error).toBeNull();
      expect(tt).toBeDefined();
      expect(tt!.name).toBe('VIP');
      expect(tt!.price).toBe(25000);
      expect(tt!.total_tickets).toBe(50);
      ticketTypeId = tt!.id;
      cleanupTicketTypeIds.push(ticketTypeId);

      // Verify the event exists
      const { data: evt } = await db.from('events')
        .select('id, name')
        .eq('id', testEventId)
        .single();
      expect(evt).toBeDefined();
      expect(evt!.id).toBe(testEventId);
    });

    it('2. creates event_ticket with unique ticket_code', async () => {
      const { data: ticket, error } = await db.from('event_tickets').insert({
        business_id: testBizId,
        booking_id: testBookingId,
        event_id: testEventId,
        ticket_code: ticketCode,
        ticket_number: 1,
        guest_name: 'Alice Test',
        guest_phone: '+1555000001',
        status: 'valid',
        ticket_type_id: ticketTypeId,
        ticket_type_name: 'VIP',
      }).select().single();

      expect(error).toBeNull();
      expect(ticket).toBeDefined();
      expect(ticket!.ticket_code).toBe(ticketCode);
      expect(ticket!.status).toBe('valid');
      expect(ticket!.ticket_type_name).toBe('VIP');
      ticketId = ticket!.id;
      cleanupTicketIds.push(ticketId);
    });

    it('3. verifies ticket by ticket_code (lookup)', async () => {
      const { data: tickets, error } = await db.from('event_tickets')
        .select('id, ticket_code, status, guest_name, event_id, ticket_type_name')
        .eq('ticket_code', ticketCode);

      expect(error).toBeNull();
      expect(tickets).toHaveLength(1);
      expect(tickets![0].ticket_code).toBe(ticketCode);
      expect(tickets![0].status).toBe('valid');
      expect(tickets![0].guest_name).toBe('Alice Test');
      expect(tickets![0].event_id).toBe(testEventId);
      expect(tickets![0].ticket_type_name).toBe('VIP');
    });

    it('4. checks in ticket (update status to used, set scanned_at)', async () => {
      const now = new Date().toISOString();
      const { data: updated, error } = await db.from('event_tickets')
        .update({ status: 'used', scanned_at: now, scanned_by: 'Staff-A' })
        .eq('ticket_code', ticketCode)
        .select('status, scanned_at, scanned_by')
        .single();

      expect(error).toBeNull();
      expect(updated!.status).toBe('used');
      expect(updated!.scanned_at).toBeTruthy();
      expect(updated!.scanned_by).toBe('Staff-A');
    });

    it('5. duplicate check-in rejected (status already used)', async () => {
      // Read back the ticket — it should already be 'used'
      const { data: ticket } = await db.from('event_tickets')
        .select('status')
        .eq('ticket_code', ticketCode)
        .single();

      expect(ticket!.status).toBe('used');

      // A real check-in flow would reject if status !== 'valid'
      // Simulate: only update if status is 'valid' (conditional update returns 0 rows)
      const { data: result } = await db.from('event_tickets')
        .update({ status: 'used', scanned_at: new Date().toISOString() })
        .eq('ticket_code', ticketCode)
        .eq('status', 'valid')  // guard: only check in 'valid' tickets
        .select('id');

      // No rows matched because status is already 'used'
      expect(result).toHaveLength(0);
    });

    it('6. ticket_code isolation: one event ticket not found under another event', async () => {
      // Query the ticket_code but filter by event2 — should return nothing
      const { data: crossEvent } = await db.from('event_tickets')
        .select('id, ticket_code')
        .eq('ticket_code', ticketCode)
        .eq('event_id', testEvent2Id);

      expect(crossEvent).toHaveLength(0);

      // Same code with correct event should still return 1
      const { data: sameEvent } = await db.from('event_tickets')
        .select('id')
        .eq('ticket_code', ticketCode)
        .eq('event_id', testEventId);

      expect(sameEvent).toHaveLength(1);
    });
  });

  // ── Membership / Package Lifecycle ──────────────────────────────────

  describe('Membership/package lifecycle', () => {
    let packageId: string;
    let enrollmentId: string;
    const customerPhone = `+1PKG${Date.now()}`;

    it('1. creates service_package + package_enrollment with sessions_used=0', async () => {
      // Create a 5-session package for our test service
      const { data: pkg, error: pkgErr } = await db.from('service_packages').insert({
        business_id: testBizId,
        name: '5-Session Massage Pack',
        description: 'Five massage sessions',
        price: 30000,
        num_sessions: 5,
        service_ids: [testServiceId],
        valid_days: 365,
        is_active: true,
      }).select().single();

      expect(pkgErr).toBeNull();
      expect(pkg).toBeDefined();
      expect(pkg!.num_sessions).toBe(5);
      packageId = pkg!.id;
      cleanupPackageIds.push(packageId);

      // Enroll a customer
      const expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);

      const { data: enrollment, error: enrErr } = await db.from('package_enrollments').insert({
        business_id: testBizId,
        customer_phone: customerPhone,
        customer_name: 'Package Tester',
        package_id: packageId,
        sessions_total: 5,
        sessions_used: 0,
        expires_at: expiresAt.toISOString(),
        is_active: true,
      }).select().single();

      expect(enrErr).toBeNull();
      expect(enrollment).toBeDefined();
      expect(enrollment!.sessions_total).toBe(5);
      expect(enrollment!.sessions_used).toBe(0);
      expect(enrollment!.is_active).toBe(true);
      enrollmentId = enrollment!.id;
      cleanupEnrollmentIds.push(enrollmentId);
    });

    it('2. deduct_package_session RPC increments sessions_used', async () => {
      const { data: result, error } = await db.rpc('deduct_package_session', {
        p_business_id: testBizId,
        p_customer_phone: customerPhone,
        p_service_id: testServiceId,
        p_booking_id: testBookingId,
      });

      expect(error).toBeNull();
      expect(result).toBe(true);

      // Verify sessions_used incremented to 1
      const { data: enrollment } = await db.from('package_enrollments')
        .select('sessions_used')
        .eq('id', enrollmentId)
        .single();
      expect(enrollment!.sessions_used).toBe(1);
    });

    it('3. replay protection: same booking_id rejected (UNIQUE on package_session_log)', async () => {
      const { data: result, error } = await db.rpc('deduct_package_session', {
        p_business_id: testBizId,
        p_customer_phone: customerPhone,
        p_service_id: testServiceId,
        p_booking_id: testBookingId,  // same booking_id as test 2
      });

      expect(error).toBeNull();
      expect(result).toBe(false);  // rejected by unique constraint

      // sessions_used should still be 1 (RPC rolls back the increment on duplicate)
      const { data: enrollment } = await db.from('package_enrollments')
        .select('sessions_used')
        .eq('id', enrollmentId)
        .single();
      expect(enrollment!.sessions_used).toBe(1);
    });

    it('4. different booking_id succeeds, sessions_used increments again', async () => {
      const { data: result, error } = await db.rpc('deduct_package_session', {
        p_business_id: testBizId,
        p_customer_phone: customerPhone,
        p_service_id: testServiceId,
        p_booking_id: testBooking2Id,  // different booking
      });

      expect(error).toBeNull();
      expect(result).toBe(true);

      // sessions_used should now be 2
      const { data: enrollment } = await db.from('package_enrollments')
        .select('sessions_used')
        .eq('id', enrollmentId)
        .single();
      expect(enrollment!.sessions_used).toBe(2);
    });

    it('5. expired enrollment rejects deduction', async () => {
      // Create an expired enrollment
      const pastDate = new Date('2025-01-01T00:00:00Z');

      const { data: expiredEnrollment } = await db.from('package_enrollments').insert({
        business_id: testBizId,
        customer_phone: `+1EXP${Date.now()}`,
        customer_name: 'Expired Tester',
        package_id: packageId,
        sessions_total: 5,
        sessions_used: 0,
        expires_at: pastDate.toISOString(),
        is_active: true,
      }).select().single();
      cleanupEnrollmentIds.push(expiredEnrollment!.id);

      // Attempt deduction with a fresh booking
      const { data: result, error } = await db.rpc('deduct_package_session', {
        p_business_id: testBizId,
        p_customer_phone: expiredEnrollment!.customer_phone,
        p_service_id: testServiceId,
        p_booking_id: testBooking3Id,
      });

      expect(error).toBeNull();
      expect(result).toBe(false);  // rejected: enrollment expired

      // sessions_used should remain 0
      const { data: enrollment } = await db.from('package_enrollments')
        .select('sessions_used')
        .eq('id', expiredEnrollment!.id)
        .single();
      expect(enrollment!.sessions_used).toBe(0);
    });
  });
});
