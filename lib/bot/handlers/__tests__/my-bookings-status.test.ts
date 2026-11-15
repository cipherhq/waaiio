import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMockContext } from '../../flows/__tests__/helpers';
const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'merchant' } } }) } }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireAnyCapability: async () => ({ allowed: true }) }));
vi.mock('@/lib/payments/proactive-localization', () => ({ resolveProactiveLocalization: async () => ({ language: 'en' }) }));
vi.mock('@/lib/waitlist/auto-notify', () => ({ notifyWaitlistOnSlotOpen: vi.fn() }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { async resolveByBusinessId() { return { sender: { sendText: vi.fn() } }; } } }));
import { PATCH } from '@/app/api/bookings/[id]/status/route';
import { handleMyBookings, handleModifyBooking, handleViewReservation } from '../my-bookings';
import { capabilitySelectionFlow } from '../../flows/capability-selection.flow';

type Row = Record<string, any>;
let rows: Record<string, Row[]>;
let reads: Array<{ table: string; filters: Array<[string, unknown]>; limit: number | undefined }>;
let writes: Array<{ table: string; patch: Row }>;
const phone = '+2348012345678';
const booking = (id: string, status = 'confirmed', date = '2026-11-20') => ({ id, status, date, time: '14:00', party_size: 1, reference_code: id, user_id: 'customer', business_id: 'business', guest_phone: phone, flow_type: 'appointment', businesses: { name: 'Demo business', country_code: 'NG', owner_id: 'merchant', metadata: { waitlist_auto_notify: false } } });
class Query {
  filters: Array<[string, unknown]> = [];
  predicates: Array<(row: Row) => boolean> = [];
  max?: number; ordering?: string; patch?: Row;
  constructor(private table: string) {}
  select() { return this; }
  eq(key: string, value: unknown) { this.filters.push([key, value]); this.predicates.push(row => row[key] === value); return this; }
  in(key: string, values: unknown[]) { this.filters.push([key, values]); this.predicates.push(row => values.includes(row[key])); return this; }
  gte(key: string, value: string) { this.filters.push([key, value]); this.predicates.push(row => row[key] >= value); return this; }
  or(expression: string) { const values = expression.split(',').map(part => part.split('.eq.')[1]); this.filters.push(['phone', values]); this.predicates.push(row => values.includes(row.guest_phone)); return this; }
  order(key: string) { this.ordering = key; return this; }
  limit(max: number) { this.max = max; return this; }
  update(patch: Row) { this.patch = patch; return this; }
  execute(single = false) {
    reads.push({ table: this.table, filters: this.filters, limit: this.max });
    let selected = (rows[this.table] ?? []).filter(row => this.predicates.every(predicate => predicate(row)));
    if (this.ordering) selected = [...selected].sort((a, b) => String(a[this.ordering!]).localeCompare(String(b[this.ordering!])));
    if (this.max !== undefined) selected = selected.slice(0, this.max);
    if (this.patch) { writes.push({ table: this.table, patch: this.patch }); selected.forEach(row => Object.assign(row, this.patch)); }
    return { data: structuredClone(single ? selected[0] ?? null : selected), error: null };
  }
  single() { return Promise.resolve(this.execute(true)); }
  maybeSingle() { return this.single(); }
  then(resolve: (result: ReturnType<Query['execute']>) => unknown) { return Promise.resolve(this.execute()).then(resolve); }
}
const sender = { sendList: vi.fn(), sendButtons: vi.fn() };
const sendText = vi.fn();
const executor = { advanceToStep: vi.fn(), executeStep: vi.fn(), startFlow: vi.fn(), execute: vi.fn() };
const session = () => ({ id: 'session', business_id: 'business', user_id: 'customer', current_step: 'my_bookings', session_data: { selected_booking_id: 'one' }, version: 0 } as any);
type HistoryItem = { description: string; postbackText: string };
async function pages(path: 'handler' | 'prompt'): Promise<HistoryItem[][]> {
  if (path === 'handler') {
    const before = sender.sendList.mock.calls.length;
    await handleMyBookings(state.db, sender as any, sendText, executor as any, session(), phone, '');
    return sender.sendList.mock.calls.slice(before).map(call => call[0].items);
  }
  const step = capabilitySelectionFlow.steps.find(step => step.id === 'my_bookings')!;
  const result = await step.prompt(createMockContext({ supabase: state.db, session: session(), from: phone }));
  return result.filter(message => message.type === 'list').map(message => (message as any).items);
}
async function list(path: 'handler' | 'prompt') { return (await pages(path)).flat(); }

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T15:00:00Z'));
  rows = { bookings: [booking('one'), booking('two', 'cancelled')], reservations: [], event_tickets: [], bot_sessions: [{ id: 'session' }] }; reads = []; writes = [];
  state.db = { from: (table: string) => new Query(table), rpc: vi.fn(async (name: string, args: Row) => {
    if (name === 'cancel_booking_with_release') {
      const row = rows.bookings.find(row => row.id === args.p_booking_id && row.user_id === args.p_expected_user_id);
      if (!row) return { data: { cancelled: false }, error: null };
      row.status = 'cancelled'; return { data: { cancelled: true }, error: null };
    }
    return { data: { success: true }, error: null };
  }) } as unknown as SupabaseClient;
});
afterEach(() => vi.useRealTimers());
describe('current customer booking history status', () => {
  it.each(['handler', 'prompt'] as const)('%s list labels current statuses and preserves date, customer and limit boundaries', async path => {
    rows.bookings.push(booking('old', 'cancelled', '2026-11-14'), { ...booking('foreign'), user_id: 'other' }, ...Array.from({ length: 5 }, (_, i) => booking(`extra-${i}`, 'confirmed', `2026-11-${21 + i}`)));
    rows.reservations = [{ id: 'stay', status: 'cancelled', guest_phone: phone, check_in: '2026-11-20', check_out: '2026-11-21', reference_code: 'stay', businesses: { name: 'Stay' } }, { id: 'other-stay', status: 'confirmed', guest_phone: '+15550001111', check_in: '2026-11-20', check_out: '2026-11-21' }];
    const items = await list(path);
    expect(items.find(item => item.postbackText === 'booking_one')?.description).toMatch(/^Confirmed •/);
    expect(items.find(item => item.postbackText === 'booking_two')?.description).toMatch(/^Cancelled •/);
    expect(items.find(item => item.postbackText === 'reservation_stay')?.description).toMatch(/^Cancelled •/);
    expect(items.filter(item => item.postbackText.startsWith('booking_'))).toHaveLength(6);
    expect(items.filter(item => item.postbackText.startsWith('booking_') && item.description.startsWith('Confirmed'))).toHaveLength(5);
    expect(items.some(item => /old|foreign|other-stay/.test(item.postbackText))).toBe(false);
    expect(reads.find(read => read.table === 'bookings')).toMatchObject({ limit: 5, filters: expect.arrayContaining([['user_id', 'customer'], ['date', '2026-11-15']]) });
    expect(reads.find(read => read.table === 'reservations')).toMatchObject({ limit: 5, filters: expect.arrayContaining([['check_out', '2026-11-15']]) });
  });
  describe.each(['handler', 'prompt'] as const)('%s bounded history pages', path => {
    it.each([0, 1, 9, 10, 11, 15, 25])('keeps all %i records exactly once within ten-row messages', async count => {
      rows.bookings = Array.from({ length: count === 25 ? 10 : Math.min(5, count) }, (_, index) => booking(`b${index}`, index < 5 ? 'confirmed' : 'cancelled', `2026-12-${String(index + 1).padStart(2, '0')}`));
      rows.event_tickets = Array.from({ length: Math.min(5, Math.max(0, count - 5)) }, (_, index) => ({ id: `t${index}`, guest_phone: phone, status: 'valid', ticket_code: `T${index}`, created_at: '2026-11-15', event: { name: 'Event', date: '2026-11-20' } }));
      rows.reservations = Array.from({ length: count === 25 ? 10 : Math.max(0, count - 10) }, (_, index) => ({ id: `r${index}`, guest_phone: phone, status: index < 5 ? 'checked_in' : 'cancelled', check_in: `2026-12-${String(index + 1).padStart(2, '0')}`, check_out: '2026-12-20', reference_code: `R${index}`, businesses: { name: 'Stay' } }));
      const output = await pages(path);
      expect(output.every(page => page.length <= 10)).toBe(true);
      const items = output.flat();
      const actual = items.filter(item => item.postbackText !== 'back_to_account').map(item => item.postbackText);
      const expected = [...rows.bookings.map(row => `booking_${row.id}`), ...rows.event_tickets.map(row => `ticket_${row.id}`), ...rows.reservations.map(row => `reservation_${row.id}`)];
      expect(actual).toEqual(expected); expect(new Set(actual).size).toBe(count);
      expect(items.filter(item => item.postbackText === 'back_to_account')).toHaveLength(path === 'handler' && count > 0 ? 1 : 0);
      if (path === 'handler' && count > 0) expect(output.at(-1)!.at(-1)!.postbackText).toBe('back_to_account');
      expect(reads).toHaveLength(5);
      expect(reads.every(read => read.limit === 5)).toBe(true);
      expect(reads.filter(read => read.table === 'bookings')).toHaveLength(2);
      expect(reads.filter(read => read.table === 'reservations')).toHaveLength(2);
    });
  });
  it.each(['handler', 'prompt'] as const)('%s does not let earlier cancellations crowd out active bookings or checked-in stays', async path => {
    rows.bookings = [...Array.from({ length: 5 }, (_, index) => booking(`cancelled-${index}`, 'cancelled', `2026-11-${16 + index}`)), booking('active-later', 'confirmed', '2026-11-25')];
    rows.reservations = [...Array.from({ length: 5 }, (_, index) => ({ id: `cancelled-stay-${index}`, status: 'cancelled', guest_phone: phone, check_in: `2026-11-${16 + index}`, check_out: '2026-11-26', reference_code: `S${index}`, businesses: { name: 'Stay' } })), { id: 'checked-in-later', status: 'checked_in', guest_phone: phone, check_in: '2026-11-25', check_out: '2026-11-26', reference_code: 'ACTIVE', businesses: { name: 'Stay' } }];
    const items = await list(path);
    expect(items.find(item => item.postbackText === 'booking_active-later')?.description).toMatch(/^Confirmed •/);
    expect(items.find(item => item.postbackText === 'reservation_checked-in-later')?.description).toMatch(/^Checked in •/);
    expect(items.filter(item => item.postbackText.startsWith('booking_'))).toHaveLength(6);
    expect(items.filter(item => item.postbackText.startsWith('reservation_'))).toHaveLength(6);
    const cancelledReads = reads.filter(read => read.filters.some(([key, value]) => key === 'status' && value === 'cancelled'));
    expect(cancelledReads).toHaveLength(2);
    expect(cancelledReads.every(read => read.limit === 5)).toBe(true);
    expect(cancelledReads.find(read => read.table === 'bookings')?.filters).toEqual(expect.arrayContaining([['user_id', 'customer'], ['date', '2026-11-15']]));
    expect(cancelledReads.find(read => read.table === 'reservations')?.filters).toEqual(expect.arrayContaining([['check_out', '2026-11-15'], ['phone', [phone, phone.slice(1)]]]));
  });
  it.each(['handler', 'prompt'] as const)('%s collapses an active/cancelled read race to one current cancelled record', async path => {
    // Two query snapshots represent a cancellation committed between reads.
    rows.bookings = [booking('same', 'confirmed'), booking('same', 'cancelled')];
    rows.reservations = ['confirmed', 'cancelled'].map(status => ({ id: 'same-stay', status, guest_phone: phone, check_in: '2026-11-20', check_out: '2026-11-21', reference_code: 'SAME', businesses: { name: 'Stay' } }));
    const items = await list(path);
    expect(items.filter(item => item.postbackText === 'booking_same')).toHaveLength(1);
    expect(items.find(item => item.postbackText === 'booking_same')?.description).toMatch(/^Cancelled •/);
    expect(items.filter(item => item.postbackText === 'reservation_same-stay')).toHaveLength(1);
    expect(items.find(item => item.postbackText === 'reservation_same-stay')?.description).toMatch(/^Cancelled •/);
  });
  it('rejects stale cancellation and non-owner rescheduling without modifying a booking', async () => {
    rows.bookings[0].status = 'cancelled';
    await handleModifyBooking(state.db, sender as any, sendText, executor as any, session(), phone, 'cancel_booking');
    expect(sendText.mock.calls.at(-1)![1]).toBe('This booking can no longer be cancelled.');
    expect(state.db.rpc).not.toHaveBeenCalledWith('cancel_booking_with_release', expect.anything());
    await handleModifyBooking(state.db, sender as any, sendText, executor as any, { ...session(), user_id: 'other' }, phone, 'reschedule_booking');
    expect(sendText.mock.calls.at(-1)![1]).toContain('Could not load booking details');
    expect(writes).toEqual([]); expect(executor.execute).not.toHaveBeenCalled();
  });
  it('preserves confirmed table-reservation reschedule restriction', async () => {
    rows.bookings[0].flow_type = 'table_reservation';
    await handleModifyBooking(state.db, sender as any, sendText, executor as any, session(), phone, '');
    expect(sender.sendButtons.mock.calls.at(-1)![0].buttons.map((button: any) => button.id)).toEqual(['cancel_booking', 'back_bookings']);
    await handleModifyBooking(state.db, sender as any, sendText, executor as any, session(), phone, 'reschedule_booking');
    expect(sendText.mock.calls.at(-1)![1]).toContain('Table reservations cannot be rescheduled yet');
    expect(writes).toEqual([]); expect(executor.execute).not.toHaveBeenCalled();
  });
  it('merchant cancellation updates the shared fixture then both real lists and detail show cancellation without modification actions', async () => {
    const response = await PATCH(new NextRequest('http://localhost/api/bookings/one/status', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel', notify_customer: false }) }), { params: Promise.resolve({ id: 'one' }) });
    expect(response.status).toBe(200);
    expect(state.db.rpc).toHaveBeenCalledWith('cancel_booking_with_release', { p_booking_id: 'one', p_cancelled_by: 'business', p_expected_user_id: 'customer' });
    for (const path of ['handler', 'prompt'] as const) expect((await list(path)).find(item => item.postbackText === 'booking_one')?.description).toMatch(/^Cancelled •/);
    await handleModifyBooking(state.db, sender as any, sendText, executor as any, session(), phone, '');
    expect(sendText.mock.calls.at(-1)![1]).toContain('Status: Cancelled');
    expect(sender.sendButtons.mock.calls.at(-1)![0].buttons.map((button: any) => button.id)).toEqual(['back_bookings']);
    await handleModifyBooking(state.db, sender as any, sendText, executor as any, session(), phone, 'reschedule_booking');
    expect(sendText.mock.calls.at(-1)![1]).toBe('This booking can no longer be rescheduled.');
    expect(writes).toEqual([]); expect(executor.advanceToStep).not.toHaveBeenCalled(); expect(executor.execute).not.toHaveBeenCalled();
  });
  it('keeps cancelled stays readable without offering cancellation', async () => {
    rows.reservations = [{ id: 'stay', status: 'cancelled', guest_phone: phone, check_in: '2026-11-20', check_out: '2026-11-21', reference_code: 'STAY', businesses: { name: 'Stay' } }];
    await handleViewReservation(state.db, sender as any, sendText, session(), phone, 'stay');
    expect(sendText.mock.calls.at(-1)![1]).toContain('Cancelled');
    expect(sender.sendButtons.mock.calls.at(-1)![0].buttons.map((button: any) => button.id)).toEqual(['back_bookings', 'back_to_account']);
  });
  it('retains confirmed booking controls and rejects another customer detail', async () => {
    await handleModifyBooking(state.db, sender as any, sendText, executor as any, session(), phone, '');
    expect(sender.sendButtons.mock.calls.at(-1)![0].buttons.map((button: any) => button.id)).toEqual(['reschedule_booking', 'cancel_booking', 'back_bookings']);
    sender.sendButtons.mockClear();
    await handleModifyBooking(state.db, sender as any, sendText, executor as any, { ...session(), user_id: 'other' }, phone, '');
    expect(sender.sendButtons).not.toHaveBeenCalled();
    expect(sendText.mock.calls.at(-1)![1]).toContain('Booking not found');
  });
});
