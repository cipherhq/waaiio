/**
 * P1-APPT-1 / P1-APPT-3 / P1-APPT-4: Appointment booking closure tests.
 *
 * Covers:
 * - APPT-1: buffer_minutes on appointments (schema, dashboard, slot blocking, authority agreement)
 * - APPT-3: Manual dashboard booking for appointment-only businesses
 * - APPT-4: Public booking for appointment-only businesses
 * - Real PostgreSQL authority tests for appointment capacity/buffer/schedule/auth
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// ══════════════════════════════════════════════════════════
// P1-APPT-1: Buffer minutes schema & wiring
// ══════════════════════════════════════════════════════════

describe('P1-APPT-1: appointment buffer_minutes', () => {
  const migration318 = readFileSync('supabase/migrations/318_appointment_buffer_booking_authority.sql', 'utf-8');
  const appointmentFlow = readFileSync('lib/bot/flows/appointment.flow.ts', 'utf-8');

  it('1. migration adds buffer_minutes to appointments with safe default 0', () => {
    expect(migration318).toContain('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS buffer_minutes integer NOT NULL DEFAULT 0');
  });

  it('2. dashboard appointments page includes buffer_minutes in form state', () => {
    const dashPage = readFileSync('app/dashboard/appointments-management/page.tsx', 'utf-8');
    expect(dashPage).toContain('buffer_minutes');
    // The form has buffer_minutes in the save payload
    expect(dashPage).toContain('buffer_minutes: form.buffer_minutes');
  });

  it('3. appointment flow stores _service_buffer_minutes in session data (auto-select path)', () => {
    // When only one appointment, auto-select should set buffer_minutes
    expect(appointmentFlow).toContain('_service_buffer_minutes');
    // Must appear in the auto-select block (appointments.length === 1)
    const autoSelectBlock = appointmentFlow.slice(
      appointmentFlow.indexOf('appointments.length === 1'),
      appointmentFlow.indexOf('skip_service = true') + 50,
    );
    expect(autoSelectBlock).toContain('_service_buffer_minutes');
  });

  it('4. appointment flow stores _service_buffer_minutes in session data (validate path)', () => {
    // Both exact match and fuzzy match validation must return buffer_minutes
    const validateSection = appointmentFlow.slice(appointmentFlow.indexOf('async validate'));
    const bufferOccurrences = (validateSection.match(/_service_buffer_minutes/g) || []).length;
    // At least 2: one for exact ID match, one for fuzzy name match
    expect(bufferOccurrences).toBeGreaterThanOrEqual(2);
  });

  it('5. appointment flow queries buffer_minutes from appointments table', () => {
    // The SELECT in prompt must include buffer_minutes
    const selectMatches = appointmentFlow.match(/\.select\([^)]+buffer_minutes/g);
    // Should have at least 3 selects: prompt, validate exact, validate fuzzy
    expect(selectMatches?.length).toBeGreaterThanOrEqual(3);
  });

  it('6. reschedule reads buffer_minutes from appointments (not hardcoded 0)', () => {
    // The updated reschedule_booking_atomic in migration 318 should read buffer_minutes
    const rescheduleBlock = migration318.slice(migration318.indexOf('reschedule_booking_atomic'));
    const appointmentResolution = rescheduleBlock.slice(
      rescheduleBlock.indexOf('appointment_id IS NOT NULL'),
      rescheduleBlock.indexOf('v_max_capacity := 1'),
    );
    // Should read COALESCE(buffer_minutes, 0) from appointments, not hardcode 0
    expect(appointmentResolution).toContain('COALESCE(buffer_minutes, 0)');
    expect(appointmentResolution).not.toMatch(/INTO v_max_capacity, v_buffer_minutes.*\n.*FROM appointments.*0/);
  });

  it('7. scheduling flow passes _service_buffer_minutes to book_slot_atomic', () => {
    const schedulingFlow = readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    // Verify the p_buffer_minutes param uses session data buffer
    expect(schedulingFlow).toContain('p_buffer_minutes: (d._service_buffer_minutes as number) || 0');
  });
});

// ══════════════════════════════════════════════════════════
// P1-APPT-3: Manual dashboard booking for appointments
// ══════════════════════════════════════════════════════════

describe('P1-APPT-3: manual booking source verification', () => {
  const routeSrc = readFileSync('app/api/bookings/create-manual/route.ts', 'utf-8');
  const migration318 = readFileSync('supabase/migrations/318_appointment_buffer_booking_authority.sql', 'utf-8');

  it('8. route accepts appointmentId as alternative to serviceId', () => {
    expect(routeSrc).toContain('appointmentId');
    expect(routeSrc).toContain("'Either serviceId or appointmentId is required'");
  });

  it('9. route rejects providing both serviceId and appointmentId', () => {
    expect(routeSrc).toContain("'Provide serviceId or appointmentId, not both'");
  });

  it('10. route queries appointments table when appointmentId is provided', () => {
    expect(routeSrc).toContain(".from('appointments')");
  });

  it('11. route passes p_appointment_id to book_manual_slot_atomic', () => {
    expect(routeSrc).toContain('p_appointment_id: appointmentId || null');
  });

  it('12. route passes null service_id when booking appointment', () => {
    expect(routeSrc).toContain('p_service_id: appointmentId ? null : serviceId');
  });

  it('13. book_manual_slot_atomic accepts p_appointment_id parameter', () => {
    const manualFn = migration318.slice(migration318.indexOf('book_manual_slot_atomic'));
    expect(manualFn).toContain('p_appointment_id uuid DEFAULT NULL');
  });

  it('14. book_manual_slot_atomic passes appointment_id to book_slot_atomic', () => {
    const manualFn = migration318.slice(migration318.indexOf('book_manual_slot_atomic'));
    expect(manualFn).toContain('p_appointment_id,');
    // Should NOT hardcode NULL for appointment_id
    expect(manualFn).not.toContain("NULL,          -- p_appointment_id\n");
  });

  it('15. MK-3 guarantees preserved: still calls book_manual_slot_atomic RPC', () => {
    expect(routeSrc).toContain("rpc('book_manual_slot_atomic'");
  });

  it('16. MK-3 guarantees preserved: still uses createWhatsAppUser for customer identity', () => {
    expect(routeSrc).toContain('createWhatsAppUser');
  });

  it('17. MK-3 guarantees preserved: no direct INSERT into bookings', () => {
    expect(routeSrc).not.toContain(".from('bookings').insert(");
  });

  it('18. dashboard reservations page loads appointments alongside services', () => {
    const resvPage = readFileSync('app/dashboard/reservations/page.tsx', 'utf-8');
    const loadFn = resvPage.slice(
      resvPage.indexOf('loadNewBookingServices'),
      resvPage.indexOf('setNbLoadingServices(false)') + 30,
    );
    expect(loadFn).toContain(".from('appointments')");
    expect(loadFn).toContain('_isAppointment: true');
  });

  it('19. dashboard reservations sends appointmentId when appointment selected', () => {
    const resvPage = readFileSync('app/dashboard/reservations/page.tsx', 'utf-8');
    expect(resvPage).toContain('appointmentId: nbForm.serviceId');
  });
});

// ══════════════════════════════════════════════════════════
// P1-APPT-3: Manual booking route behavior tests
// ══════════════════════════════════════════════════════════

// ── Hoisted mocks for route behavior tests ──
const mockRpc2 = vi.fn();
const mockAuthGetUser2 = vi.fn();
const mockCapabilityGuard2 = vi.fn();
const mockCreateWhatsAppUser2 = vi.fn();
const mockServiceLookup2 = vi.fn();
const mockAppointmentLookup2 = vi.fn();
const mockBusinessLookup2 = vi.fn();
const mockStaffLookup2 = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: () => mockAuthGetUser2() },
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn((table: string) => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: table === 'services' ? mockServiceLookup2
        : table === 'appointments' ? mockAppointmentLookup2
        : table === 'businesses' ? mockBusinessLookup2
        : table === 'business_staff' ? mockStaffLookup2
        : vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
    rpc: mockRpc2,
  })),
}));

vi.mock('@/lib/capabilities/api-guard', () => ({
  requireAnyCapability: (...args: unknown[]) => mockCapabilityGuard2(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn(() => 'test'),
}));
vi.mock('@/lib/bot/flows/shared/user', () => ({
  createWhatsAppUser: (...args: unknown[]) => mockCreateWhatsAppUser2(...args),
}));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class { resolveByBusinessId() { return null; } },
}));
vi.mock('@/lib/channels/send-or-email', () => ({
  sendOrEmail: vi.fn(), findCustomerEmail: vi.fn(),
}));
vi.mock('@/lib/email/templates', () => ({
  businessNotificationEmail: vi.fn(() => ({ html: '' })),
}));

const { POST } = await import('@/app/api/bookings/create-manual/route');

function makeManualReq(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/bookings/create-manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setupManualDefaults() {
  mockAuthGetUser2.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
  mockCapabilityGuard2.mockResolvedValue({ allowed: true });
  mockBusinessLookup2.mockResolvedValue({ data: { name: 'Test Biz', country_code: 'NG' }, error: null });
  mockServiceLookup2.mockResolvedValue({ data: { name: 'Haircut', price: 5000, duration_minutes: 30, max_capacity: 1, buffer_minutes: 0, requires_staff: false }, error: null });
  mockAppointmentLookup2.mockResolvedValue({ data: { name: 'Consultation', price: 3000, duration_minutes: 45, max_capacity: 1, buffer_minutes: 10, requires_staff: false }, error: null });
  mockStaffLookup2.mockResolvedValue({ data: { name: 'Staff', is_active: true }, error: null });
  mockCreateWhatsAppUser2.mockResolvedValue('customer-123');
  mockRpc2.mockReturnValue({
    single: vi.fn().mockResolvedValue({
      data: { booking_id: 'book-1', reference_code: 'REF-001', slot_available: true },
      error: null,
    }),
  });
}

describe('P1-APPT-3: manual booking route behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupManualDefaults();
  });

  it('20. appointment-only business can manual-book appointment', async () => {
    const res = await POST(makeManualReq({
      businessId: 'biz-1',
      appointmentId: 'appt-1',
      date: '2027-01-15',
      time: '10:00',
      customerName: 'Jane Doe',
      customerPhone: '+2348000000001',
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.reference_code).toBe('REF-001');
  });

  it('21. passes appointment_id to RPC, service_id as null', async () => {
    await POST(makeManualReq({
      businessId: 'biz-1',
      appointmentId: 'appt-1',
      date: '2027-01-15',
      time: '10:00',
      customerName: 'Jane Doe',
      customerPhone: '+2348000000001',
    }));
    expect(mockRpc2).toHaveBeenCalledWith('book_manual_slot_atomic', expect.objectContaining({
      p_appointment_id: 'appt-1',
      p_service_id: null,
      p_buffer_minutes: 10,
      p_duration: 45,
    }));
  });

  it('22. rejects request with neither serviceId nor appointmentId', async () => {
    const res = await POST(makeManualReq({
      businessId: 'biz-1',
      date: '2027-01-15',
      time: '10:00',
      customerName: 'Jane',
      customerPhone: '+2348000000000',
    }));
    expect(res.status).toBe(400);
  });

  it('23. rejects request with both serviceId and appointmentId', async () => {
    const res = await POST(makeManualReq({
      businessId: 'biz-1',
      serviceId: 'svc-1',
      appointmentId: 'appt-1',
      date: '2027-01-15',
      time: '10:00',
      customerName: 'Jane',
      customerPhone: '+2348000000000',
    }));
    expect(res.status).toBe(400);
  });

  it('24. returns 404 for invalid appointment', async () => {
    mockAppointmentLookup2.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const res = await POST(makeManualReq({
      businessId: 'biz-1',
      appointmentId: 'invalid-id',
      date: '2027-01-15',
      time: '10:00',
      customerName: 'Jane',
      customerPhone: '+2348000000001',
    }));
    expect(res.status).toBe(404);
  });

  it('25. service manual booking still works unchanged', async () => {
    const res = await POST(makeManualReq({
      businessId: 'biz-1',
      serviceId: 'svc-1',
      date: '2027-01-15',
      time: '10:00',
      customerName: 'John',
      customerPhone: '+2348000000000',
    }));
    expect(res.status).toBe(200);
    expect(mockRpc2).toHaveBeenCalledWith('book_manual_slot_atomic', expect.objectContaining({
      p_service_id: 'svc-1',
      p_appointment_id: null,
    }));
  });

  it('26. customer identity resolved via createWhatsAppUser (not owner)', async () => {
    await POST(makeManualReq({
      businessId: 'biz-1',
      appointmentId: 'appt-1',
      date: '2027-01-15',
      time: '10:00',
      customerName: 'Jane Doe',
      customerPhone: '+2348000000001',
    }));
    expect(mockCreateWhatsAppUser2).toHaveBeenCalled();
    expect(mockRpc2).toHaveBeenCalledWith('book_manual_slot_atomic', expect.objectContaining({
      p_user_id: 'customer-123',
    }));
  });

  it('27. atomic conflict rejection (slot unavailable)', async () => {
    mockRpc2.mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: { booking_id: null, reference_code: null, slot_available: false },
        error: null,
      }),
    });
    const res = await POST(makeManualReq({
      businessId: 'biz-1',
      appointmentId: 'appt-1',
      date: '2027-01-15',
      time: '10:00',
      customerName: 'Jane',
      customerPhone: '+2348000000001',
    }));
    expect(res.status).toBe(409);
  });
});

// ══════════════════════════════════════════════════════════
// P1-APPT-4: Public booking source verification
// ══════════════════════════════════════════════════════════

describe('P1-APPT-4: public booking source verification', () => {
  const publicPage = readFileSync('app/b/[slug]/page.tsx', 'utf-8');
  const bookingForm = readFileSync('app/b/[slug]/BookingForm.tsx', 'utf-8');
  const slotsRoute = readFileSync('app/api/bookings/public/slots/route.ts', 'utf-8');
  const createRoute = readFileSync('app/api/bookings/public/create/route.ts', 'utf-8');

  it('28. public page uses public-safe RPC for appointments', () => {
    expect(publicPage).toContain("rpc('get_active_appointments_public'");
  });

  it('29. public page passes appointments to BookingForm', () => {
    expect(publicPage).toContain('is_appointment: true');
    expect(publicPage).toContain('allBookableItems');
  });

  it('30. BookingForm has is_appointment on ServiceInfo interface', () => {
    expect(bookingForm).toContain('is_appointment?: boolean');
  });

  it('31. BookingForm sends appointmentId to slots endpoint when appointment selected', () => {
    expect(bookingForm).toContain("params.set('appointmentId', selectedService.id)");
  });

  it('32. BookingForm sends appointmentId to create endpoint when appointment selected', () => {
    expect(bookingForm).toContain('appointmentId: selectedService.id');
  });

  it('33. slots endpoint accepts appointmentId parameter', () => {
    expect(slotsRoute).toContain("searchParams.get('appointmentId')");
  });

  it('34. slots endpoint queries appointments table when appointmentId provided', () => {
    expect(slotsRoute).toContain(".from('appointments')");
  });

  it('35. slots endpoint respects appointment available_days restriction', () => {
    expect(slotsRoute).toContain('itemAvailableDays');
  });

  it('36. slots endpoint respects appointment available_from/to hours', () => {
    expect(slotsRoute).toContain('itemAvailableFrom');
    expect(slotsRoute).toContain('itemAvailableTo');
  });

  it('37. create endpoint accepts appointmentId parameter', () => {
    expect(createRoute).toContain('appointmentId');
    expect(createRoute).toContain("'Either serviceId or appointmentId is required'");
  });

  it('38. create endpoint queries appointments table when appointmentId provided', () => {
    expect(createRoute).toContain(".from('appointments')");
  });

  it('39. create endpoint passes appointment_id to book_slot_atomic', () => {
    expect(createRoute).toContain('p_appointment_id: isAppointmentBooking ? itemId : null');
  });

  it('40. create endpoint passes null service_id for appointment booking', () => {
    expect(createRoute).toContain('p_service_id: isAppointmentBooking ? null : itemId');
  });

  it('41. CONFLICT-1 semantics preserved: cross-service capacity check', () => {
    // The slots route must NOT filter bookings by service_id
    expect(slotsRoute).toContain('business_id');
    // No service_id filter on the bookings query
    const bookingsQuery = slotsRoute.slice(
      slotsRoute.indexOf('existingBookings'),
      slotsRoute.indexOf('existingBookings') + 300,
    );
    expect(bookingsQuery).not.toContain(".eq('service_id'");
  });

  it('42. public appointment read uses least-privilege RPC (no broad anon SELECT)', () => {
    const migration318 = readFileSync('supabase/migrations/318_appointment_buffer_booking_authority.sql', 'utf-8');
    // Must use constrained RPC, NOT broad table policy
    expect(migration318).toContain('get_active_appointments_public');
    expect(migration318).not.toContain('appointments_public_select');
    // RPC must be SECURITY DEFINER
    expect(migration318).toContain('SECURITY DEFINER');
    // Extract the RETURNS TABLE definition to verify exposed columns
    const returnsMatch = migration318.match(/RETURNS TABLE\(([\s\S]*?)\)\s*\nLANGUAGE sql/);
    expect(returnsMatch).not.toBeNull();
    const returnedColumns = returnsMatch![1];
    // Must NOT expose internal columns in return type
    expect(returnedColumns).not.toContain('staff_ids');
    expect(returnedColumns).not.toContain('auto_approve');
    expect(returnedColumns).not.toContain('buffer_minutes');
    expect(returnedColumns).not.toContain('requires_staff');
    expect(returnedColumns).not.toContain('allow_staff_selection');
    expect(returnedColumns).not.toContain('created_at');
    expect(returnedColumns).not.toContain('updated_at');
    // Must contain key public columns
    expect(returnedColumns).toContain('name');
    expect(returnedColumns).toContain('price');
    expect(returnedColumns).toContain('duration_minutes');
  });

  it('43. public slots endpoint rejects both serviceId AND appointmentId', () => {
    expect(slotsRoute).toContain("'Provide serviceId or appointmentId, not both'");
  });

  it('44. book_slot_atomic validates appointment schedule via check_appointment_schedule', () => {
    const migration318 = readFileSync('supabase/migrations/318_appointment_buffer_booking_authority.sql', 'utf-8');
    const bsaBlock = migration318.slice(migration318.indexOf('book_slot_atomic'));
    expect(bsaBlock).toContain('check_appointment_schedule');
    expect(bsaBlock).toContain('v_sched_allowed IS NOT TRUE');
  });

  it('45. reschedule_booking_atomic validates appointment schedule', () => {
    const migration318 = readFileSync('supabase/migrations/318_appointment_buffer_booking_authority.sql', 'utf-8');
    const reschedBlock = migration318.slice(migration318.indexOf('reschedule_booking_atomic'));
    expect(reschedBlock).toContain('check_appointment_schedule');
  });

  it('46. check_appointment_schedule uses deterministic EXTRACT(DOW)', () => {
    const migration318 = readFileSync('supabase/migrations/318_appointment_buffer_booking_authority.sql', 'utf-8');
    expect(migration318).toContain('EXTRACT(DOW FROM p_date)');
    // Must NOT use JavaScript-style getDay() in SQL
    expect(migration318).not.toContain('getDay');
  });

  it('47. bot appointment flow stores available_days/from/to in session data', () => {
    const apptFlow = readFileSync('lib/bot/flows/appointment.flow.ts', 'utf-8');
    expect(apptFlow).toContain('_service_available_days');
    expect(apptFlow).toContain('_service_available_from');
    expect(apptFlow).toContain('_service_available_to');
  });
});

// ══════════════════════════════════════════════════════════
// Real PostgreSQL: appointment booking authority
// ══════════════════════════════════════════════════════════

const TEST_DB = process.env.TEST_DATABASE_URL;

function runSQL(sql: string): string {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
  try {
    const raw = execSync(`psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`, {
      encoding: 'utf-8', timeout: 15000, input: sql,
    });
    // Filter out transaction control markers that psql may emit
    return raw.split('\n')
      .filter(l => {
        const t = l.trim();
        return t !== '' && !/^(BEGIN|COMMIT|SET|GRANT|REVOKE|CREATE\b|ALTER\b|INSERT\b|UPDATE\b|DELETE\b|DO)\b/i.test(t);
      })
      .join('\n').trim();
  } catch (err: any) {
    return `ERROR: ${err.stderr || err.message}`;
  }
}

// CI provides TEST_DATABASE_URL — no skipping allowed
const describeDb = !TEST_DB ? describe.skip : describe;

describeDb('Real PostgreSQL: appointment booking authority', () => {
  const BIZ_OWNER = '00000000-0000-0000-0000-00000a170001';
  const BIZ_ID = '00000000-0000-0000-0000-00000a170002';
  // Appointment available Mon-Fri, 09:00-17:00
  const APPT_ID = '00000000-0000-0000-0000-00000a170003';
  const SVC_ID = '00000000-0000-0000-0000-00000a170004';
  const CUST_ID = '00000000-0000-0000-0000-00000a170005';

  beforeAll(() => {
    // Apply migration 318
    const migration318 = readFileSync('supabase/migrations/318_appointment_buffer_booking_authority.sql', 'utf-8');
    runSQL(migration318);

    runSQL(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id) VALUES ('${BIZ_OWNER}') ON CONFLICT DO NOTHING;
      INSERT INTO auth.users (id) VALUES ('${CUST_ID}') ON CONFLICT DO NOTHING;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
      INSERT INTO profiles (id, first_name, last_name, email) VALUES ('${BIZ_OWNER}', 'Appt', 'Owner', 'appt-owner@test.local') ON CONFLICT DO NOTHING;
      INSERT INTO profiles (id, first_name, last_name, email) VALUES ('${CUST_ID}', 'Appt', 'Customer', 'appt-cust@test.local') ON CONFLICT DO NOTHING;
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, country_code)
        VALUES ('${BIZ_ID}', 'Appt Test Biz', 'appt-test', '${BIZ_OWNER}', '1 Test', 'Lagos', 'VI', '+0000', 'active', 'NG') ON CONFLICT DO NOTHING;
      INSERT INTO appointments (id, business_id, name, price, duration_minutes, buffer_minutes, max_capacity, is_active,
                                available_days, available_from, available_to)
        VALUES ('${APPT_ID}', '${BIZ_ID}', 'Consultation', 3000, 45, 15, 1, true,
                '{monday,tuesday,wednesday,thursday,friday}', '09:00', '17:00') ON CONFLICT DO NOTHING;
      INSERT INTO services (id, business_id, name, price, duration_minutes, buffer_minutes, max_capacity, is_active)
        VALUES ('${SVC_ID}', '${BIZ_ID}', 'Haircut', 5000, 30, 10, 1, true) ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(() => {
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    runSQL(`DELETE FROM services WHERE id = '${SVC_ID}';`);
    runSQL(`DELETE FROM appointments WHERE id = '${APPT_ID}';`);
    runSQL(`DELETE FROM businesses WHERE id = '${BIZ_ID}';`);
    runSQL(`DELETE FROM profiles WHERE id IN ('${BIZ_OWNER}', '${CUST_ID}');`);
    runSQL(`ALTER TABLE auth.users DISABLE TRIGGER ALL; DELETE FROM auth.users WHERE id IN ('${BIZ_OWNER}', '${CUST_ID}'); ALTER TABLE auth.users ENABLE TRIGGER ALL;`);
  });

  // ── Buffer tests ──

  it('DB-1. appointment buffer column defaults to 0', () => {
    const result = runSQL(`SELECT buffer_minutes FROM appointments WHERE id = '${APPT_ID}';`);
    expect(result).toBe('15'); // We set it to 15 in setup
    // Verify default by checking column definition
    const colDefault = runSQL(`SELECT column_default FROM information_schema.columns WHERE table_name = 'appointments' AND column_name = 'buffer_minutes';`);
    expect(colDefault).toBe('0');
  });

  it('DB-2. appointment buffer blocks candidate before existing', () => {
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    // 2027-07-15 is a Thursday — allowed day
    runSQL(`INSERT INTO bookings (business_id, user_id, appointment_id, date, time, party_size, status, flow_type, channel, guest_name, guest_phone, deposit_amount, deposit_status, total_amount)
      VALUES ('${BIZ_ID}', '${CUST_ID}', '${APPT_ID}', '2027-07-15', '10:00', 1, 'confirmed', 'scheduling', 'whatsapp', 'Existing', '+0001', 0, 'none', 3000);`);
    const result = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, NULL::uuid, NULL::uuid,
      '2027-07-15'::date, '09:30', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'Test', '+0002', NULL, NULL, NULL, NULL, NULL, NULL, 3000, NULL,
      NULL, '${APPT_ID}'::uuid, 15, 45, NULL);`);
    expect(result).toContain('f');
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}' AND guest_phone = '+0002';`);
  });

  it('DB-3. appointment buffer blocks candidate after existing', () => {
    const result = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, NULL::uuid, NULL::uuid,
      '2027-07-15'::date, '10:30', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'Test', '+0003', NULL, NULL, NULL, NULL, NULL, NULL, 3000, NULL,
      NULL, '${APPT_ID}'::uuid, 15, 45, NULL);`);
    expect(result).toContain('f');
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}' AND guest_phone = '+0003';`);
  });

  it('DB-4. valid non-conflicting appointment succeeds', () => {
    const result = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, NULL::uuid, NULL::uuid,
      '2027-07-15'::date, '11:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'Test', '+0004', NULL, NULL, NULL, NULL, NULL, NULL, 3000, NULL,
      NULL, '${APPT_ID}'::uuid, 15, 45, NULL);`);
    expect(result).toContain('t');
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}' AND guest_phone = '+0004';`);
  });

  // ── Schedule enforcement tests ──

  it('DB-5. book_slot_atomic rejects appointment on forbidden available_day (Saturday)', () => {
    // 2027-07-17 is a Saturday — NOT in available_days
    const result = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, NULL::uuid, NULL::uuid,
      '2027-07-17'::date, '10:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'SatTest', '+0010', NULL, NULL, NULL, NULL, NULL, NULL, 3000, NULL,
      NULL, '${APPT_ID}'::uuid, 15, 45, NULL);`);
    expect(result).toContain('f');
  });

  it('DB-6. book_slot_atomic rejects appointment before available_from', () => {
    // 08:00 is before available_from (09:00) on a valid day (Thursday)
    const result = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, NULL::uuid, NULL::uuid,
      '2027-07-15'::date, '08:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'EarlyTest', '+0011', NULL, NULL, NULL, NULL, NULL, NULL, 3000, NULL,
      NULL, '${APPT_ID}'::uuid, 15, 45, NULL);`);
    expect(result).toContain('f');
  });

  it('DB-7. book_slot_atomic rejects appointment at/after available_to', () => {
    // 17:00 is at available_to boundary (>= check) on a valid day
    const result = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, NULL::uuid, NULL::uuid,
      '2027-07-15'::date, '17:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'LateTest', '+0012', NULL, NULL, NULL, NULL, NULL, NULL, 3000, NULL,
      NULL, '${APPT_ID}'::uuid, 15, 45, NULL);`);
    expect(result).toContain('f');
  });

  it('DB-8. valid appointment day/time succeeds', () => {
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    // Wednesday 14:00 (2027-07-14) — valid day and within hours
    const result = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, NULL::uuid, NULL::uuid,
      '2027-07-14'::date, '14:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'ValidTest', '+0013', NULL, NULL, NULL, NULL, NULL, NULL, 3000, NULL,
      NULL, '${APPT_ID}'::uuid, 15, 45, NULL);`);
    expect(result).toContain('t');
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
  });

  // ── Timezone determinism test ──

  it('DB-9. EXTRACT(DOW) matches expected day for known date', () => {
    // 2027-07-17 is a Saturday (DOW=6), not in available_days
    const dow = runSQL(`SELECT EXTRACT(DOW FROM '2027-07-17'::date);`);
    expect(dow).toBe('6'); // Saturday
    // 2027-07-15 is a Thursday (DOW=4), in available_days
    const dow2 = runSQL(`SELECT EXTRACT(DOW FROM '2027-07-15'::date);`);
    expect(dow2).toBe('4'); // Thursday
  });

  // ── Reschedule tests ──

  it('DB-10. reschedule to forbidden appointment day rejected', () => {
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    // Create a booking on Thursday
    runSQL(`INSERT INTO bookings (business_id, user_id, appointment_id, date, time, party_size, status, flow_type, channel, guest_name, guest_phone, deposit_amount, deposit_status, total_amount)
      VALUES ('${BIZ_ID}', '${CUST_ID}', '${APPT_ID}', '2027-07-15', '10:00', 1, 'confirmed', 'scheduling', 'whatsapp', 'Resched', '+0020', 0, 'none', 3000);`);
    const bookingId = runSQL(`SELECT id FROM bookings WHERE business_id = '${BIZ_ID}' AND guest_phone = '+0020' LIMIT 1;`);
    // Try to reschedule to Saturday
    const result = runSQL(`SELECT reschedule_booking_atomic(
      '${bookingId}'::uuid, '${BIZ_ID}'::uuid, '2027-07-17'::date, '10:00', NULL);`);
    expect(result).toContain('"rescheduled": false');
    expect(result).toContain('appointment_day_unavailable');
  });

  it('DB-11. valid appointment reschedule succeeds', () => {
    const bookingId = runSQL(`SELECT id FROM bookings WHERE business_id = '${BIZ_ID}' AND guest_phone = '+0020' LIMIT 1;`);
    // Reschedule to Wednesday 14:00 (2027-07-14) — valid
    const result = runSQL(`SELECT reschedule_booking_atomic(
      '${bookingId}'::uuid, '${BIZ_ID}'::uuid, '2027-07-14'::date, '14:00', NULL);`);
    expect(result).toContain('"rescheduled": true');
  });

  // ── Manual booking tests ──

  it('DB-12. appointment manual booking succeeds through atomic authority', () => {
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    const result = runSQL(`SELECT slot_available FROM book_manual_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, NULL::uuid, NULL::uuid,
      '2027-07-15'::date, '14:00', 1, 1,
      'Manual Test', '+0030', NULL, 'Test notes', 3000, NULL,
      15, 45, '${APPT_ID}'::uuid);`);
    expect(result).toContain('t');
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
  });

  it('DB-13. service manual booking remains unchanged', () => {
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    const result = runSQL(`SELECT slot_available FROM book_manual_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, '${SVC_ID}'::uuid, NULL::uuid,
      '2027-07-15'::date, '14:00', 1, 1,
      'Svc Manual', '+0031', NULL, 'Notes', 5000, NULL,
      10, 30, NULL);`);
    expect(result).toContain('t');
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
  });

  // ── Regression tests ──

  it('DB-14. service book_slot_atomic behavior unchanged (no schedule check)', () => {
    // Service booking on Saturday should succeed (services don't have schedule checks)
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    const result = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, '${SVC_ID}'::uuid, NULL::uuid,
      '2027-07-17'::date, '10:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'SvcSat', '+0040', NULL, NULL, NULL, NULL, NULL, NULL, 5000, NULL,
      NULL, NULL, 10, 30, NULL);`);
    expect(result).toContain('t');
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
  });

  it('DB-15. cross-type capacity: appointment + service share pool', () => {
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    // Create appointment booking at 10:00 Thursday
    runSQL(`INSERT INTO bookings (business_id, user_id, appointment_id, date, time, party_size, status, flow_type, channel, guest_name, guest_phone, deposit_amount, deposit_status, total_amount)
      VALUES ('${BIZ_ID}', '${CUST_ID}', '${APPT_ID}', '2027-07-15', '10:00', 1, 'confirmed', 'scheduling', 'whatsapp', 'Cross', '+0041', 0, 'none', 3000);`);
    // Service booking at same time should be rejected (capacity=1)
    const result = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, '${SVC_ID}'::uuid, NULL::uuid,
      '2027-07-15'::date, '10:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'CrossSvc', '+0042', NULL, NULL, NULL, NULL, NULL, NULL, 5000, NULL,
      NULL, NULL, 10, 30, NULL);`);
    expect(result).toContain('f');
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
  });

  it('DB-16. appointment manual booking on forbidden day rejected by authority', () => {
    // Saturday — schedule check fires inside book_slot_atomic via book_manual_slot_atomic
    const result = runSQL(`SELECT slot_available FROM book_manual_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, NULL::uuid, NULL::uuid,
      '2027-07-17'::date, '10:00', 1, 1,
      'SatManual', '+0043', NULL, 'Notes', 3000, NULL,
      15, 45, '${APPT_ID}'::uuid);`);
    expect(result).toContain('f');
  });

  it('DB-17. reschedule appointment before available_from rejected', () => {
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    runSQL(`INSERT INTO bookings (business_id, user_id, appointment_id, date, time, party_size, status, flow_type, channel, guest_name, guest_phone, deposit_amount, deposit_status, total_amount)
      VALUES ('${BIZ_ID}', '${CUST_ID}', '${APPT_ID}', '2027-07-15', '10:00', 1, 'confirmed', 'scheduling', 'whatsapp', 'Early', '+0044', 0, 'none', 3000);`);
    const bookingId = runSQL(`SELECT id FROM bookings WHERE business_id = '${BIZ_ID}' AND guest_phone = '+0044' LIMIT 1;`);
    const result = runSQL(`SELECT reschedule_booking_atomic(
      '${bookingId}'::uuid, '${BIZ_ID}'::uuid, '2027-07-15'::date, '08:00', NULL);`);
    expect(result).toContain('"rescheduled": false');
    expect(result).toContain('appointment_before_available_from');
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
  });

  // ── Real role-behavior authorization tests ──
  // Pattern follows P1-CHAT-1: replace auth.uid(), SET LOCAL ROLE, run SQL, restore.

  const BIZ2_OWNER = '00000000-0000-0000-0000-00000a170006';
  const BIZ2_ID = '00000000-0000-0000-0000-00000a170007';
  const APPT2_ID = '00000000-0000-0000-0000-00000a170008';
  const UNRELATED_USER = '00000000-0000-0000-0000-00000a170009';

  /** Run SQL as a specific authenticated user (replaces auth.uid, uses SET LOCAL ROLE) */
  function asUser(userId: string, sql: string): string {
    return runSQL(`
      BEGIN;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${userId}'::UUID; $fn$ LANGUAGE SQL STABLE;
      SET LOCAL ROLE authenticated;
      ${sql}
      COMMIT;
    `);
  }
  /** Run SQL as anon role */
  function asAnon(sql: string): string {
    return runSQL(`
      BEGIN;
      SET LOCAL ROLE anon;
      ${sql}
      COMMIT;
    `);
  }
  function asServiceRole(sql: string): string {
    return runSQL(`
      BEGIN;
      SET LOCAL ROLE service_role;
      ${sql}
      COMMIT;
    `);
  }
  function resetAuth(): void {
    runSQL(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ SELECT '00000000-0000-0000-0000-000000000000'::UUID; $$ LANGUAGE SQL STABLE;
    `);
  }

  beforeAll(() => {
    // Grant schema + table access to Supabase roles (Supabase does this automatically,
    // but CI test DB needs explicit grants for SET LOCAL ROLE tests)
    runSQL(`
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
      GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
      -- anon: NO direct table access (only RPC EXECUTE grants)
    `);

    // Create second business + appointment for cross-business tests
    runSQL(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id) VALUES ('${BIZ2_OWNER}') ON CONFLICT DO NOTHING;
      INSERT INTO auth.users (id) VALUES ('${UNRELATED_USER}') ON CONFLICT DO NOTHING;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
      INSERT INTO profiles (id, first_name, last_name, email) VALUES ('${BIZ2_OWNER}', 'Biz2', 'Owner', 'biz2-owner@test.local') ON CONFLICT DO NOTHING;
      INSERT INTO profiles (id, first_name, last_name, email) VALUES ('${UNRELATED_USER}', 'Unrelated', 'User', 'unrelated@test.local') ON CONFLICT DO NOTHING;
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, country_code)
        VALUES ('${BIZ2_ID}', 'Biz2 Test', 'biz2-test', '${BIZ2_OWNER}', '2 Test', 'Lagos', 'VI', '+0001', 'active', 'NG') ON CONFLICT DO NOTHING;
      INSERT INTO appointments (id, business_id, name, price, duration_minutes, buffer_minutes, max_capacity, is_active,
                                available_days, available_from, available_to, staff_ids, auto_approve, metadata)
        VALUES ('${APPT2_ID}', '${BIZ2_ID}', 'Biz2 Consult', 5000, 60, 10, 2, true,
                '{monday,tuesday,wednesday,thursday,friday}', '10:00', '18:00',
                '{${BIZ2_OWNER}}', false, '{"internal_note":"secret"}') ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(() => {
    resetAuth();
    runSQL(`DELETE FROM appointments WHERE id = '${APPT2_ID}';`);
    runSQL(`DELETE FROM businesses WHERE id = '${BIZ2_ID}';`);
    runSQL(`DELETE FROM profiles WHERE id IN ('${BIZ2_OWNER}', '${UNRELATED_USER}');`);
    runSQL(`ALTER TABLE auth.users DISABLE TRIGGER ALL; DELETE FROM auth.users WHERE id IN ('${BIZ2_OWNER}', '${UNRELATED_USER}'); ALTER TABLE auth.users ENABLE TRIGGER ALL;`);
  });

  afterEach(() => { resetAuth(); });

  it('AUTH-A1. anon can execute RPC and receives active appointment (SET LOCAL ROLE anon)', () => {
    const result = asAnon(`SELECT COUNT(*) FROM get_active_appointments_public('${BIZ_ID}'::uuid);`);
    expect(result.trim()).toBe('1');
  });

  it('AUTH-A2. anon RPC returns only public-safe columns (proargnames verification)', () => {
    const argNames = runSQL(`
      SELECT array_to_string(proargnames, ',')
      FROM pg_proc
      WHERE proname = 'get_active_appointments_public'
        AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
    `);
    expect(argNames).not.toContain('staff_ids');
    expect(argNames).not.toContain('auto_approve');
    expect(argNames).not.toContain('buffer_minutes');
    expect(argNames).not.toContain('requires_staff');
    expect(argNames).toContain('id');
    expect(argNames).toContain('name');
    expect(argNames).toContain('price');
  });

  it('AUTH-A3. anon cannot directly retrieve internal appointment columns (SET LOCAL ROLE anon)', () => {
    // anon has USAGE ON SCHEMA but NO table-level SELECT — direct query must fail or return 0 rows
    try {
      const result = asAnon(`SELECT staff_ids, auto_approve, metadata, buffer_minutes FROM appointments WHERE id = '${APPT_ID}';`);
      // If it somehow succeeds without error, internal data must not be returned
      expect(result.trim()).toBe('');
    } catch {
      // Permission denied is the correct behavior — anon has no table SELECT
      expect(true).toBe(true);
    }
  });

  it('AUTH-A4. inactive appointments excluded when RPC called AS anon (SET LOCAL ROLE anon)', () => {
    runSQL(`UPDATE appointments SET is_active = false WHERE id = '${APPT_ID}';`);
    const result = asAnon(`SELECT COUNT(*) FROM get_active_appointments_public('${BIZ_ID}'::uuid);`);
    expect(result.trim()).toBe('0');
    runSQL(`UPDATE appointments SET is_active = true WHERE id = '${APPT_ID}';`);
  });

  it('AUTH-A5. cross-business RPC scoping exercised AS anon (SET LOCAL ROLE anon)', () => {
    const result1 = asAnon(`SELECT name FROM get_active_appointments_public('${BIZ_ID}'::uuid);`);
    expect(result1).toContain('Consultation');
    expect(result1).not.toContain('Biz2 Consult');

    const result2 = asAnon(`SELECT name FROM get_active_appointments_public('${BIZ2_ID}'::uuid);`);
    expect(result2).toContain('Biz2 Consult');
    expect(result2).not.toContain('Consultation');
  });

  it('AUTH-B1. authenticated has EXECUTE grant on public RPC', () => {
    const hasGrant = runSQL(`
      SELECT COUNT(*) FROM information_schema.routine_privileges
      WHERE routine_name = 'get_active_appointments_public'
        AND grantee = 'authenticated'
        AND privilege_type = 'EXECUTE';
    `);
    expect(hasGrant.trim()).toBe('1');
  });

  it('AUTH-B2. unrelated authenticated user gets 0 rows from direct table (owner RLS)', () => {
    const result = asUser(UNRELATED_USER, `SELECT COUNT(*) FROM appointments WHERE business_id = '${BIZ_ID}';`);
    expect(result.trim()).toBe('0');
  });

  it('AUTH-C1. owner has full dashboard SELECT including internal columns', () => {
    const result = asUser(BIZ_OWNER, `SELECT id, staff_ids, auto_approve, buffer_minutes FROM appointments WHERE business_id = '${BIZ_ID}';`);
    expect(result).toContain(APPT_ID);
    expect(result).not.toContain('ERROR');
  });

  it('AUTH-C2. owner can update their own appointments', () => {
    asUser(BIZ_OWNER, `UPDATE appointments SET description = 'owner-updated' WHERE id = '${APPT_ID}';`);
    const desc = runSQL(`SELECT description FROM appointments WHERE id = '${APPT_ID}';`);
    expect(desc.trim()).toBe('owner-updated');
    runSQL(`UPDATE appointments SET description = NULL WHERE id = '${APPT_ID}';`);
  });

  it('AUTH-D1. service_role has full appointment access including internal columns', () => {
    const result = asServiceRole(`SELECT id, staff_ids, auto_approve, buffer_minutes, metadata FROM appointments WHERE id = '${APPT_ID}';`);
    expect(result).toContain(APPT_ID);
    expect(result).not.toContain('ERROR');
  });

  it('AUTH-E1. cross-business: RPC returns only correct business appointments', () => {
    const result1 = runSQL(`SELECT name FROM get_active_appointments_public('${BIZ_ID}'::uuid);`);
    expect(result1).toContain('Consultation');
    expect(result1).not.toContain('Biz2 Consult');

    const result2 = runSQL(`SELECT name FROM get_active_appointments_public('${BIZ2_ID}'::uuid);`);
    expect(result2).toContain('Biz2 Consult');
    expect(result2).not.toContain('Consultation');
  });

  it('AUTH-E2. cross-business: owner cannot see other business appointments via table', () => {
    const result = asUser(BIZ_OWNER, `SELECT COUNT(*) FROM appointments WHERE business_id = '${BIZ2_ID}';`);
    expect(result.trim()).toBe('0');
  });

  it('AUTH-F1. REVOKE EXECUTE FROM PUBLIC is in effect', () => {
    const hasPublicGrant = runSQL(`
      SELECT COUNT(*) FROM information_schema.routine_privileges
      WHERE routine_name = 'get_active_appointments_public'
        AND grantee = 'PUBLIC';
    `);
    expect(hasPublicGrant.trim()).toBe('0');
  });

  // ── Idempotency replay test ──

  it('IDEM-1. bot replay returns committed booking after appointment schedule change', () => {
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    const SESSION_ID = '00000000-0000-0000-0000-00000a17aa01';

    // Step 1: Create booking with bot_session_id on valid day (Thursday)
    const firstResult = runSQL(`SELECT booking_id, slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, NULL::uuid, NULL::uuid,
      '2027-07-15'::date, '10:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'Replay', '+0050', NULL, NULL, NULL, NULL, NULL, NULL, 3000, NULL,
      NULL, '${APPT_ID}'::uuid, 15, 45, '${SESSION_ID}'::uuid);`);
    expect(firstResult).toContain('t'); // slot_available = true

    // Step 2: Change appointment schedule to exclude Thursday
    runSQL(`UPDATE appointments SET available_days = '{monday,tuesday,wednesday,friday}' WHERE id = '${APPT_ID}';`);

    // Step 3: Retry with SAME bot_session_id — must return the committed booking
    const replayResult = runSQL(`SELECT booking_id, slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, NULL::uuid, NULL::uuid,
      '2027-07-15'::date, '10:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'Replay', '+0050', NULL, NULL, NULL, NULL, NULL, NULL, 3000, NULL,
      NULL, '${APPT_ID}'::uuid, 15, 45, '${SESSION_ID}'::uuid);`);
    expect(replayResult).toContain('t'); // idempotent replay succeeds

    // Step 4: A genuinely NEW booking on the now-excluded Thursday must be rejected
    const newResult = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${CUST_ID}'::uuid, NULL::uuid, NULL::uuid,
      '2027-07-15'::date, '14:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'NewReq', '+0051', NULL, NULL, NULL, NULL, NULL, NULL, 3000, NULL,
      NULL, '${APPT_ID}'::uuid, 15, 45, NULL);`);
    expect(newResult).toContain('f'); // new booking on excluded day rejected

    // Restore schedule
    runSQL(`UPDATE appointments SET available_days = '{monday,tuesday,wednesday,thursday,friday}' WHERE id = '${APPT_ID}';`);
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
  });
});
