// @vitest-environment jsdom
/**
 * #461 — Behavioral/component-level proof for event creation,
 * partial tier-failure recovery, and duplication fail-closed.
 *
 * Renders the real EventsPage with mocked Supabase and drives
 * actual user flows through React state transitions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act, cleanup, fireEvent } from '@testing-library/react';

// ── Track Supabase calls ──
type MockCall = { table: string; op: string; args?: unknown };
let supabaseCalls: MockCall[] = [];

// Controllable mock responses
let eventInsertResponse: { data: unknown; error: unknown } = { data: { id: 'evt-new-123' }, error: null };
let tierInsertResponse: { data: unknown; error: unknown } = { data: null, error: null };
let tierSelectResponse: { data: unknown; error: unknown } = { data: [], error: null };
let eventsSelectResponse: { data: unknown; error: unknown } = { data: [], error: null };

function buildChain(table: string) {
  const self: Record<string, any> = {};
  const makeChainable = () => self;
  self.select = vi.fn((..._a: unknown[]) => { supabaseCalls.push({ table, op: 'select' }); return self; });
  self.insert = vi.fn((payload: unknown) => {
    supabaseCalls.push({ table, op: 'insert', args: payload });
    if (table === 'events') Object.assign(self, { _insertData: eventInsertResponse.data, _insertError: eventInsertResponse.error });
    if (table === 'event_ticket_types') Object.assign(self, { _insertData: tierInsertResponse.data, _insertError: tierInsertResponse.error });
    return self;
  });
  self.update = vi.fn(() => { supabaseCalls.push({ table, op: 'update' }); return self; });
  self.delete = vi.fn(() => { supabaseCalls.push({ table, op: 'delete' }); return self; });
  self.eq = vi.fn(makeChainable);
  self.is = vi.fn(makeChainable);
  self.order = vi.fn(() => {
    if (table === 'events') return { data: eventsSelectResponse.data, error: eventsSelectResponse.error };
    if (table === 'event_ticket_types') return { data: tierSelectResponse.data, error: tierSelectResponse.error };
    return self;
  });
  self.single = vi.fn(() => {
    // Used after .insert().select().single() for event creation
    return { data: self._insertData ?? null, error: self._insertError ?? null };
  });
  self.maybeSingle = vi.fn(() => ({ data: null, error: null }));
  // For tier insert (no .select().single() chain), destructure directly
  self.data = undefined;
  Object.defineProperty(self, 'error', {
    get() {
      if (table === 'event_ticket_types' && self._insertError !== undefined) return self._insertError;
      return null;
    },
    configurable: true,
  });
  // Make thenable so `await` works on insert result when not chained further
  self.then = undefined; // Not a promise — await resolves immediately
  return self;
}

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: vi.fn((table: string) => buildChain(table)),
  }),
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({ id: 'biz-1', country_code: 'NG', name: 'Test Biz' }),
}));

vi.mock('@/lib/constants', () => ({
  formatCurrency: (amount: number) => `₦${amount}`,
}));

vi.mock('next/link', () => ({ default: ({ children, ...p }: any) => React.createElement('a', p, children) }));
vi.mock('next/image', () => ({ default: (p: any) => React.createElement('img', p) }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => React.createElement('div', null, 'QR') }));
vi.mock('@/components/dashboard/EmptyState', () => ({ default: (p: any) => React.createElement('div', { 'data-testid': 'empty-state' }, p.title) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/ui/PlacesAutocomplete', () => ({
  default: (p: any) => React.createElement('input', {
    'data-testid': 'venue-input',
    value: p.value || '',
    onChange: (e: any) => p.onChange?.(e.target.value),
  }),
}));

const mockAlert = vi.fn();
globalThis.alert = mockAlert;
globalThis.confirm = vi.fn(() => true);

const { default: EventsPage } = await import('@/app/dashboard/events/page');

beforeEach(() => {
  supabaseCalls = [];
  mockAlert.mockClear();
  eventInsertResponse = { data: { id: 'evt-new-123' }, error: null };
  tierInsertResponse = { data: null, error: null };
  tierSelectResponse = { data: [], error: null };
  eventsSelectResponse = { data: [], error: null };
});
afterEach(() => cleanup());

async function openCreateForm() {
  let container: HTMLElement;
  await act(async () => {
    const result = render(React.createElement(EventsPage));
    container = result.container;
  });
  const newBtn = Array.from(container!.querySelectorAll('button')).find(b => b.textContent?.includes('New Event'));
  expect(newBtn, 'New Event button must exist').toBeTruthy();
  await act(async () => { newBtn!.click(); });
  return container!;
}

async function fillForm(container: HTMLElement) {
  const inputs = container.querySelectorAll('input');
  const nameInput = Array.from(inputs).find(i => i.placeholder?.includes('Gospel') || (i.type === 'text' && !i.placeholder?.includes('VIP') && !i.placeholder?.includes('Price') && !i.placeholder?.includes('Qty')));
  const dateInput = Array.from(inputs).find(i => i.type === 'date');
  const timeInput = Array.from(inputs).find(i => i.type === 'time');
  await act(async () => {
    if (nameInput) fireEvent.change(nameInput, { target: { value: 'Test Concert' } });
    if (dateInput) fireEvent.change(dateInput, { target: { value: '2027-06-15' } });
    if (timeInput) fireEvent.change(timeInput, { target: { value: '19:00' } });
  });
}

async function addPendingTier(container: HTMLElement, name: string, price: number, qty: number) {
  await act(async () => {
    const inputs = container.querySelectorAll('input');
    const tierNameInput = Array.from(inputs).find(i => i.placeholder === 'e.g. VIP');
    const tierPriceInput = Array.from(inputs).find(i => i.placeholder === 'Price');
    const tierQtyInput = Array.from(inputs).find(i => i.placeholder === 'Qty');
    if (tierNameInput) fireEvent.change(tierNameInput, { target: { value: name } });
    if (tierPriceInput) fireEvent.change(tierPriceInput, { target: { value: String(price) } });
    if (tierQtyInput) fireEvent.change(tierQtyInput, { target: { value: String(qty) } });
  });
  await act(async () => {
    const addBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent === 'Add' && !b.textContent?.includes('New')
    );
    if (addBtn) addBtn.click();
  });
}

async function createEventWithTierFailure(container: HTMLElement) {
  tierInsertResponse = { data: null, error: { message: 'tier insert failed' } };
  await fillForm(container);
  await addPendingTier(container, 'VIP', 5000, 50);
  expect(container.textContent).toContain('VIP');

  const saveBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Create Event'));
  expect(saveBtn, 'Create Event button must exist').toBeTruthy();
  await act(async () => { saveBtn!.click(); });
  // Flush any remaining state updates
  await act(async () => {});
}

describe('#461 behavioral: partial tier-failure recovery', () => {
  it('event insert succeeds → tier fails → recovery UI with pending tiers and retry button', async () => {
    const container = await openCreateForm();
    await createEventWithTierFailure(container);

    // Event was inserted
    expect(supabaseCalls.filter(c => c.table === 'events' && c.op === 'insert').length).toBe(1);
    // Tier insert was attempted
    expect(supabaseCalls.filter(c => c.table === 'event_ticket_types' && c.op === 'insert').length).toBe(1);
    // Alert shown
    expect(mockAlert).toHaveBeenCalledWith(expect.stringContaining('ticket tier setup failed'));

    // Recovery UI: pending tier visible, banner visible, retry button visible
    expect(container.textContent).toContain('VIP');
    expect(container.textContent).toContain('Ticket tiers failed to save');
    const retryBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Retry Ticket Tiers'));
    expect(retryBtn, 'Retry Ticket Tiers button must appear').toBeTruthy();
  });

  it('retry uses existing event ID — no second events.insert', async () => {
    const container = await openCreateForm();
    await createEventWithTierFailure(container);
    supabaseCalls = [];
    mockAlert.mockClear();

    // Make tier insert succeed for retry
    tierInsertResponse = { data: null, error: null };

    const retryBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Retry Ticket Tiers'));
    expect(retryBtn, 'Retry button must exist').toBeTruthy();
    await act(async () => { retryBtn!.click(); });
    await act(async () => {});

    // NO events.insert during retry
    expect(supabaseCalls.filter(c => c.table === 'events' && c.op === 'insert').length).toBe(0);
    // event_ticket_types.insert WAS called
    const tierInserts = supabaseCalls.filter(c => c.table === 'event_ticket_types' && c.op === 'insert');
    expect(tierInserts.length).toBe(1);
    // Used the existing event ID
    const payload = tierInserts[0].args as any[];
    expect(payload[0].event_id).toBe('evt-new-123');
  });

  it('retry success clears pending state and removes recovery UI', async () => {
    const container = await openCreateForm();
    await createEventWithTierFailure(container);

    // Recovery UI present
    expect(container.textContent).toContain('Retry Ticket Tiers');

    // Make retry succeed
    tierInsertResponse = { data: null, error: null };
    const retryBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Retry Ticket Tiers'));
    await act(async () => { retryBtn!.click(); });
    await act(async () => {});

    // Recovery UI gone
    expect(container.textContent).not.toContain('Ticket tiers failed to save');
    expect(Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Retry Ticket Tiers'))).toBeUndefined();
  });

  it('retry failure preserves pending definitions for another attempt', async () => {
    const container = await openCreateForm();
    await createEventWithTierFailure(container);
    mockAlert.mockClear();

    // Retry — still fails
    tierInsertResponse = { data: null, error: { message: 'still broken' } };
    const retryBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Retry Ticket Tiers'));
    await act(async () => { retryBtn!.click(); });
    await act(async () => {});

    // Alert shows retry failure
    expect(mockAlert).toHaveBeenCalledWith(expect.stringContaining('failed again'));
    // Pending tier still visible
    expect(container.textContent).toContain('VIP');
    // Retry button still available
    expect(Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Retry Ticket Tiers'))).toBeTruthy();
  });
});

describe('#461 behavioral: duplication fail-closed', () => {
  it('source-tier load failure does not enter duplicate creation state', async () => {
    // Render with one past event in the list
    eventsSelectResponse = { data: [{
      id: 'evt-source', name: 'Past Event', slug: 'past', description: null,
      date: '2024-01-01', time: '18:00', venue: 'Lagos', price: 1000,
      total_tickets: 100, tickets_sold: 50, max_per_order: 5,
      status: 'published', image_url: null, self_checkin_enabled: false, created_at: '2024-01-01',
    }], error: null };
    tierSelectResponse = { data: null, error: { message: 'connection timeout' } };

    let container: HTMLElement;
    await act(async () => {
      const result = render(React.createElement(EventsPage));
      container = result.container;
    });

    // Click into the event (opens edit view)
    const card = container!.querySelector('[class*="cursor-pointer"]');
    if (card) await act(async () => { fireEvent.click(card); });

    // Click "Duplicate Event"
    const dupBtn = Array.from(container!.querySelectorAll('button')).find(b => b.textContent?.includes('Duplicate'));
    if (dupBtn) await act(async () => { dupBtn.click(); });

    // Alert shown about tier load failure
    expect(mockAlert).toHaveBeenCalledWith(expect.stringContaining('Failed to load ticket tiers'));
    expect(mockAlert).toHaveBeenCalledWith(expect.stringContaining('Cannot duplicate'));

    // Must NOT enter add mode — "Create Event" button should not exist
    const createBtn = Array.from(container!.querySelectorAll('button')).find(b => b.textContent === 'Create Event');
    expect(createBtn).toBeUndefined();
  });
});
