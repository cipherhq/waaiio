/**
 * CONFLICT-1: Public slot availability must match booking authority.
 *
 * Tests verify that public slot display uses the same overlap/capacity
 * rules as book_slot_atomic:
 * - Cross-service capacity (no service_id filter)
 * - Bidirectional buffer overlap
 * - Same active booking statuses
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';

// ── Mocks ──

const mockExistingBookings = vi.fn();
const mockBusinessLookup = vi.fn();
const mockServiceLookup = vi.fn();

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'businesses') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: mockBusinessLookup,
        };
      }
      if (table === 'services') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: mockServiceLookup,
        };
      }
      if (table === 'bookings') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue(mockExistingBookings()),
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    }),
  })),
}));

vi.mock('@/lib/constants', () => ({
  generateTimeSlots: vi.fn((open: string, close: string, interval: number) => {
    const slots: string[] = [];
    const [oH, oM] = open.split(':').map(Number);
    const [cH, cM] = close.split(':').map(Number);
    let m = oH * 60 + oM;
    const end = cH * 60 + cM;
    while (m < end) {
      slots.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
      m += interval;
    }
    return slots;
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn(() => 'test'),
}));

const { GET } = await import('@/app/api/bookings/public/slots/route');

function makeReq(params: Record<string, string>) {
  const url = new URL('http://localhost/api/bookings/public/slots');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

const PARAMS = { businessId: 'biz-1', serviceId: 'svc-1', date: '2027-06-15' };

function setupDefaults(opts: {
  bookings?: Array<{ time: string; staff_id?: string | null; services?: { duration_minutes?: number; buffer_minutes?: number } | null }>;
  maxCapacity?: number;
  duration?: number;
  buffer?: number;
} = {}) {
  mockBusinessLookup.mockResolvedValue({
    data: { operating_hours: { sunday: { open: '08:00', close: '18:00' } }, metadata: {} },
    error: null,
  });
  mockServiceLookup.mockResolvedValue({
    data: {
      duration_minutes: opts.duration ?? 30,
      buffer_minutes: opts.buffer ?? 0,
      max_capacity: opts.maxCapacity ?? 1,
      metadata: {},
    },
    error: null,
  });
  mockExistingBookings.mockReturnValue({
    data: (opts.bookings ?? []).map(b => ({
      time: b.time,
      staff_id: b.staff_id ?? null,
      services: b.services ?? { duration_minutes: opts.duration ?? 30, buffer_minutes: opts.buffer ?? 0 },
    })),
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════
// Source verification
// ══════════════════════════════════════════════════════════

describe('CONFLICT-1: source verification', () => {
  const src = readFileSync('app/api/bookings/public/slots/route.ts', 'utf-8');

  it('does NOT filter bookings by service_id (cross-service capacity)', () => {
    // The query should NOT have .eq('service_id', ...) on the bookings select
    const bookingsSection = src.slice(src.indexOf("from('bookings')"));
    const nextFrom = bookingsSection.indexOf('.from(', 1);
    const bookingsQuery = nextFrom > 0 ? bookingsSection.slice(0, nextFrom) : bookingsSection.slice(0, 200);
    expect(bookingsQuery).not.toContain("'service_id'");
  });

  it('uses bidirectional buffer overlap', () => {
    // Must check both directions: candidate < (existing + duration + buffer)
    // AND (candidate + candidateDuration) > (existing - buffer)
    expect(src).toContain('slotMinutes < existingMinutes + existingDuration + candidateBuffer');
    expect(src).toContain('slotMinutes + candidateDuration > existingMinutes - candidateBuffer');
  });

  it('uses same active statuses as book_slot_atomic', () => {
    expect(src).toContain("'confirmed', 'pending', 'in_progress'");
  });
});

// ══════════════════════════════════════════════════════════
// Availability behavior
// ══════════════════════════════════════════════════════════

describe('CONFLICT-1: availability behavior', () => {
  it('no existing bookings => all slots available', async () => {
    setupDefaults({ bookings: [] });
    const res = await GET(makeReq(PARAMS));
    const data = await res.json();
    expect(data.slots.length).toBeGreaterThan(0);
    expect(data.slots.every((s: { available: number }) => s.available > 0)).toBe(true);
  });

  it('exact conflict at same time => slot unavailable (capacity=1)', async () => {
    setupDefaults({ bookings: [{ time: '10:00' }], maxCapacity: 1 });
    const res = await GET(makeReq(PARAMS));
    const data = await res.json();
    const slot10 = data.slots.find((s: { time: string }) => s.time === '10:00');
    expect(slot10).toBeUndefined(); // filtered out
  });

  it('capacity>1: slot remains until exhausted', async () => {
    setupDefaults({
      bookings: [{ time: '10:00' }],
      maxCapacity: 3,
    });
    const res = await GET(makeReq(PARAMS));
    const data = await res.json();
    const slot10 = data.slots.find((s: { time: string }) => s.time === '10:00');
    expect(slot10).toBeDefined();
    expect(slot10.available).toBe(2);
  });

  it('capacity exhausted => slot removed', async () => {
    setupDefaults({
      bookings: [{ time: '10:00' }, { time: '10:00' }, { time: '10:00' }],
      maxCapacity: 3,
    });
    const res = await GET(makeReq(PARAMS));
    const data = await res.json();
    const slot10 = data.slots.find((s: { time: string }) => s.time === '10:00');
    expect(slot10).toBeUndefined();
  });

  it('existing booking buffer blocks earlier candidate (backward overlap)', async () => {
    // Existing booking at 10:00, duration 30, buffer 15
    // Candidate at 09:30 with duration 30 → (09:30+30=10:00) > (10:00-15=09:45) → overlap!
    setupDefaults({
      bookings: [{ time: '10:00', services: { duration_minutes: 30, buffer_minutes: 15 } }],
      duration: 30,
      buffer: 15,
    });
    const res = await GET(makeReq(PARAMS));
    const data = await res.json();
    const slot0930 = data.slots.find((s: { time: string }) => s.time === '09:30');
    expect(slot0930).toBeUndefined(); // blocked by backward buffer overlap
  });

  it('existing booking buffer blocks later candidate (forward overlap)', async () => {
    // Existing at 10:00, duration 30, buffer 15 → blocks until 10:45
    // Candidate at 10:30 → 10:30 < (10:00 + 30 + 15) = 10:45 → blocked
    setupDefaults({
      bookings: [{ time: '10:00', services: { duration_minutes: 30, buffer_minutes: 15 } }],
      duration: 30,
      buffer: 15,
    });
    const res = await GET(makeReq(PARAMS));
    const data = await res.json();
    const slot1030 = data.slots.find((s: { time: string }) => s.time === '10:30');
    expect(slot1030).toBeUndefined(); // blocked by forward buffer overlap
  });

  it('adjacent non-overlapping slot remains available', async () => {
    // Existing at 10:00, duration 30, buffer 15 → blocks [09:45, 10:45)
    // Candidate at 11:00 → 11:00 >= 10:45 → NOT blocked
    setupDefaults({
      bookings: [{ time: '10:00', services: { duration_minutes: 30, buffer_minutes: 15 } }],
      duration: 30,
      buffer: 15,
    });
    const res = await GET(makeReq(PARAMS));
    const data = await res.json();
    const slot1100 = data.slots.find((s: { time: string }) => s.time === '11:00');
    expect(slot1100).toBeDefined();
    expect(slot1100.available).toBeGreaterThan(0);
  });

  it('cancelled bookings do not consume capacity', async () => {
    // Query uses .in('status', ['confirmed', 'pending', 'in_progress'])
    // Cancelled bookings are excluded from the query entirely
    setupDefaults({ bookings: [], maxCapacity: 1 }); // no active bookings
    const res = await GET(makeReq(PARAMS));
    const data = await res.json();
    const slot10 = data.slots.find((s: { time: string }) => s.time === '10:00');
    expect(slot10).toBeDefined();
  });

  it('cross-service booking at same time consumes capacity', async () => {
    // A booking from a DIFFERENT service at 10:00 should still count
    // because book_slot_atomic does NOT filter by service_id
    setupDefaults({
      bookings: [{ time: '10:00', services: { duration_minutes: 60, buffer_minutes: 0 } }],
      maxCapacity: 1,
      duration: 30, // different service duration
    });
    const res = await GET(makeReq(PARAMS));
    const data = await res.json();
    const slot10 = data.slots.find((s: { time: string }) => s.time === '10:00');
    expect(slot10).toBeUndefined(); // blocked by cross-service booking
  });
});
