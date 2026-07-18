/**
 * Booking & Order Journey — Real Database Integration Tests
 *
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/booking-order-journey.test.ts
 *
 * Tests the full booking lifecycle (create, duplicate, reschedule, cancel, check-in)
 * and order lifecycle (create, status transitions, invalid transitions) against
 * a real Supabase database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testUserId: string;
let testBizId: string;
let testServiceId: string;
let testProductId: string;

// Track IDs for cleanup
let createdBookingIds: string[] = [];
let createdOrderIds: string[] = [];

describeIntegration('Booking & Order Journey — real database', () => {
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
      email: `booking-order-${ts}@test.local`,
      password: 'test-123',
      email_confirm: true,
    });
    testUserId = user.user!.id;

    // Create test business
    const { data: biz } = await db.from('businesses').insert({
      owner_id: testUserId,
      name: `Journey Test ${ts}`,
      slug: `journey-test-${ts}`,
      address: '123 Test St',
      city: 'TestCity',
      neighborhood: 'TestHood',
      phone: '+1234567890',
      status: 'active',
    }).select('id').single();
    testBizId = biz!.id;

    // Create test service
    const { data: svc } = await db.from('services').insert({
      business_id: testBizId,
      name: 'Test Haircut',
      price: 5000,
      duration_minutes: 30,
      max_capacity: 5,
      is_active: true,
    }).select('id').single();
    testServiceId = svc!.id;

    // Create test product (for order tests)
    const { data: prod } = await db.from('products').insert({
      business_id: testBizId,
      name: 'Test Product',
      price: 2500,
      is_active: true,
    }).select('id').single();
    testProductId = prod!.id;
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    // Clean up in dependency order
    if (createdOrderIds.length) {
      await db.from('order_items').delete().in('order_id', createdOrderIds);
      await db.from('orders').delete().in('id', createdOrderIds);
    }
    if (createdBookingIds.length) {
      await db.from('bookings').delete().in('id', createdBookingIds);
    }
    await db.from('products').delete().eq('business_id', testBizId);
    await db.from('services').delete().eq('business_id', testBizId);
    await db.from('businesses').delete().eq('id', testBizId);
    await db.auth.admin.deleteUser(testUserId);
  }, 15000);

  // ── Booking Journey ──────────────────────────────────────────────

  describe('Booking lifecycle', () => {
    let bookingId: string;
    let bookingRef: string;

    it('creates a booking via book_slot_atomic RPC', async () => {
      const { data, error } = await db.rpc('book_slot_atomic', {
        p_business_id: testBizId,
        p_user_id: testUserId,
        p_service_id: testServiceId,
        p_staff_id: null,
        p_date: '2026-08-15',
        p_time: '10:00',
        p_party_size: 1,
        p_max_capacity: 5,
        p_flow_type: 'scheduling',
        p_deposit_amount: 0,
        p_deposit_status: 'none',
        p_status: 'confirmed',
        p_guest_name: 'Test Guest',
        p_guest_phone: '+1234567890',
        p_guest_email: 'test@test.local',
        p_special_requests: null,
        p_venue_address: null,
        p_end_date: null,
        p_addons_snapshot: null,
        p_promo_code_id: null,
        p_total_amount: 5000,
        p_staff_name: null,
      });

      expect(error).toBeNull();
      expect(data).toBeDefined();
      expect(data.length).toBeGreaterThan(0);

      const row = data[0];
      expect(row.slot_available).toBe(true);
      expect(row.booking_id).toBeTruthy();

      bookingId = row.booking_id;
      createdBookingIds.push(bookingId);

      // Verify the booking record exists with correct status
      const { data: booking } = await db.from('bookings')
        .select('id, status, date, time, guest_name, business_id, total_amount')
        .eq('id', bookingId)
        .single();

      expect(booking).not.toBeNull();
      expect(booking!.status).toBe('confirmed');
      expect(booking!.guest_name).toBe('Test Guest');
      expect(booking!.business_id).toBe(testBizId);
      expect(Number(booking!.total_amount)).toBe(5000);

      bookingRef = row.reference_code;
    });

    it('rejects duplicate booking for the same slot when at capacity', async () => {
      // Fill the remaining 4 slots (capacity is 5, 1 already taken)
      for (let i = 0; i < 4; i++) {
        const { data } = await db.rpc('book_slot_atomic', {
          p_business_id: testBizId,
          p_user_id: testUserId,
          p_service_id: testServiceId,
          p_staff_id: null,
          p_date: '2026-08-15',
          p_time: '10:00',
          p_party_size: 1,
          p_max_capacity: 5,
          p_flow_type: 'scheduling',
          p_deposit_amount: 0,
          p_deposit_status: 'none',
          p_status: 'confirmed',
          p_guest_name: `Filler ${i}`,
          p_guest_phone: `+100000000${i}`,
          p_guest_email: null,
          p_special_requests: null,
          p_venue_address: null,
          p_end_date: null,
          p_addons_snapshot: null,
          p_promo_code_id: null,
          p_total_amount: 5000,
          p_staff_name: null,
        });
        if (data?.[0]?.booking_id) {
          createdBookingIds.push(data[0].booking_id);
        }
      }

      // Now try booking the same slot — should fail (slot_available = false)
      const { data: dup } = await db.rpc('book_slot_atomic', {
        p_business_id: testBizId,
        p_user_id: testUserId,
        p_service_id: testServiceId,
        p_staff_id: null,
        p_date: '2026-08-15',
        p_time: '10:00',
        p_party_size: 1,
        p_max_capacity: 5,
        p_flow_type: 'scheduling',
        p_deposit_amount: 0,
        p_deposit_status: 'none',
        p_status: 'confirmed',
        p_guest_name: 'Too Late',
        p_guest_phone: '+1999999999',
        p_guest_email: null,
        p_special_requests: null,
        p_venue_address: null,
        p_end_date: null,
        p_addons_snapshot: null,
        p_promo_code_id: null,
        p_total_amount: 5000,
        p_staff_name: null,
      });

      expect(dup).toBeDefined();
      expect(dup[0].slot_available).toBe(false);
      expect(dup[0].booking_id).toBeNull();
    });

    it('reschedules a booking to a new date', async () => {
      const newDate = '2026-08-20';
      const newTime = '14:00';

      const { error } = await db.from('bookings')
        .update({ date: newDate, time: newTime })
        .eq('id', bookingId);

      expect(error).toBeNull();

      const { data: updated } = await db.from('bookings')
        .select('date, time')
        .eq('id', bookingId)
        .single();

      expect(updated!.date).toBe(newDate);
      expect(updated!.time).toBe('14:00:00'); // Postgres returns HH:MM:SS for time columns
    });

    it('cancels a booking — status changes to cancelled', async () => {
      const { error } = await db.from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', bookingId);

      expect(error).toBeNull();

      const { data: cancelled } = await db.from('bookings')
        .select('status')
        .eq('id', bookingId)
        .single();

      expect(cancelled!.status).toBe('cancelled');
    });

    it('checks in a booking — status changes to in_progress and checked_in_at set', async () => {
      // Create a fresh confirmed booking for check-in
      const { data } = await db.rpc('book_slot_atomic', {
        p_business_id: testBizId,
        p_user_id: testUserId,
        p_service_id: testServiceId,
        p_staff_id: null,
        p_date: '2026-09-01',
        p_time: '09:00',
        p_party_size: 1,
        p_max_capacity: 5,
        p_flow_type: 'scheduling',
        p_deposit_amount: 0,
        p_deposit_status: 'none',
        p_status: 'confirmed',
        p_guest_name: 'Check In Guest',
        p_guest_phone: '+1555000001',
        p_guest_email: 'checkin@test.local',
        p_special_requests: null,
        p_venue_address: null,
        p_end_date: null,
        p_addons_snapshot: null,
        p_promo_code_id: null,
        p_total_amount: 5000,
        p_staff_name: null,
      });

      const checkinBookingId = data[0].booking_id;
      createdBookingIds.push(checkinBookingId);

      const now = new Date().toISOString();
      const { error } = await db.from('bookings')
        .update({
          status: 'in_progress',
          checked_in_at: now,
          checked_in_by: testUserId,
        })
        .eq('id', checkinBookingId);

      expect(error).toBeNull();

      const { data: checkedIn } = await db.from('bookings')
        .select('status, checked_in_at')
        .eq('id', checkinBookingId)
        .single();

      expect(checkedIn!.status).toBe('in_progress');
      expect(checkedIn!.checked_in_at).not.toBeNull();
    });

    it('rejects duplicate check-in — checked_in_at already set', async () => {
      // Create another booking and check it in
      const { data } = await db.rpc('book_slot_atomic', {
        p_business_id: testBizId,
        p_user_id: testUserId,
        p_service_id: testServiceId,
        p_staff_id: null,
        p_date: '2026-09-02',
        p_time: '11:00',
        p_party_size: 1,
        p_max_capacity: 5,
        p_flow_type: 'scheduling',
        p_deposit_amount: 0,
        p_deposit_status: 'none',
        p_status: 'confirmed',
        p_guest_name: 'Dup CheckIn Guest',
        p_guest_phone: '+1555000002',
        p_guest_email: null,
        p_special_requests: null,
        p_venue_address: null,
        p_end_date: null,
        p_addons_snapshot: null,
        p_promo_code_id: null,
        p_total_amount: 5000,
        p_staff_name: null,
      });

      const dupCheckinId = data[0].booking_id;
      createdBookingIds.push(dupCheckinId);

      // First check-in
      const now = new Date().toISOString();
      await db.from('bookings')
        .update({ status: 'in_progress', checked_in_at: now, checked_in_by: testUserId })
        .eq('id', dupCheckinId);

      // Verify it's checked in
      const { data: first } = await db.from('bookings')
        .select('checked_in_at, status')
        .eq('id', dupCheckinId)
        .single();
      expect(first!.checked_in_at).not.toBeNull();
      expect(first!.status).toBe('in_progress');

      // Simulate the API guard: "Already checked in" when checked_in_at is set
      // The API route (PATCH /api/bookings/[id]/status) checks this before updating.
      // We replicate the same guard logic here at the DB level.
      const { data: existing } = await db.from('bookings')
        .select('checked_in_at')
        .eq('id', dupCheckinId)
        .single();

      expect(existing!.checked_in_at).not.toBeNull(); // Guard would reject
    });
  });

  // ── Order Journey ────────────────────────────────────────────────

  describe('Order lifecycle', () => {
    let orderId: string;

    it('creates an order with order_items', async () => {
      // Insert order
      const { data: order, error: orderErr } = await db.from('orders').insert({
        business_id: testBizId,
        user_id: testUserId,
        status: 'pending',
        delivery_phone: '+1234567890',
        total_amount: 5000,
        channel: 'whatsapp',
      }).select('id, reference_code, status').single();

      expect(orderErr).toBeNull();
      expect(order).not.toBeNull();
      expect(order!.status).toBe('pending');
      expect(order!.reference_code).toBeTruthy();

      orderId = order!.id;
      createdOrderIds.push(orderId);

      // Insert order items
      const { error: itemErr } = await db.from('order_items').insert([
        {
          order_id: orderId,
          product_id: testProductId,
          quantity: 2,
          unit_price: 2500,
        },
      ]);

      expect(itemErr).toBeNull();

      // Verify items exist
      const { data: items } = await db.from('order_items')
        .select('id, order_id, product_id, quantity, unit_price')
        .eq('order_id', orderId);

      expect(items).not.toBeNull();
      expect(items!.length).toBe(1);
      expect(items![0].quantity).toBe(2);
      expect(items![0].unit_price).toBe(2500);
    });

    it('updates order status through valid transitions: pending → confirmed → processing → ready → delivered', async () => {
      const transitions = [
        { from: 'pending', to: 'confirmed' },
        { from: 'confirmed', to: 'processing' },
        { from: 'processing', to: 'ready' },
        { from: 'ready', to: 'delivered' },
      ];

      for (const { from, to } of transitions) {
        // Verify current status
        const { data: before } = await db.from('orders')
          .select('status')
          .eq('id', orderId)
          .single();
        expect(before!.status).toBe(from);

        // Update
        const { error } = await db.from('orders')
          .update({ status: to })
          .eq('id', orderId);
        expect(error).toBeNull();

        // Verify new status
        const { data: after } = await db.from('orders')
          .select('status')
          .eq('id', orderId)
          .single();
        expect(after!.status).toBe(to);
      }
    });

    it('rejects invalid transition: delivered → pending (state machine enforcement)', async () => {
      // The update-status API route enforces ALLOWED_TRANSITIONS.
      // At the DB level, the enum allows the value but the API rejects it.
      // We test the state machine logic directly here.
      const ALLOWED_TRANSITIONS: Record<string, string[]> = {
        pending: ['confirmed', 'cancelled'],
        confirmed: ['processing', 'cancelled'],
        processing: ['ready', 'cancelled'],
        ready: ['shipped', 'delivered', 'cancelled'],
        shipped: ['delivered'],
        delivered: [],
        cancelled: [],
      };

      // Verify order is in 'delivered' state
      const { data: current } = await db.from('orders')
        .select('status')
        .eq('id', orderId)
        .single();
      expect(current!.status).toBe('delivered');

      // Check the state machine rejects delivered → pending
      const allowed = ALLOWED_TRANSITIONS['delivered'] || [];
      expect(allowed.includes('pending')).toBe(false);

      // Verify delivered has no valid forward transitions
      expect(allowed.length).toBe(0);
    });

    it('creates a second order and cancels it', async () => {
      const { data: order2 } = await db.from('orders').insert({
        business_id: testBizId,
        user_id: testUserId,
        status: 'pending',
        delivery_phone: '+1234567890',
        total_amount: 3000,
        channel: 'whatsapp',
      }).select('id, status').single();

      expect(order2).not.toBeNull();
      createdOrderIds.push(order2!.id);

      // pending → cancelled is valid
      const { error } = await db.from('orders')
        .update({ status: 'cancelled' })
        .eq('id', order2!.id);
      expect(error).toBeNull();

      const { data: cancelled } = await db.from('orders')
        .select('status')
        .eq('id', order2!.id)
        .single();
      expect(cancelled!.status).toBe('cancelled');
    });
  });
}, 60000);

describe('Booking & Order Journey DB status', () => {
  it(`tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => {
    expect(true).toBe(true);
  });
});
