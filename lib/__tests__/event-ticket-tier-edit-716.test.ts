import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateTicketTierEdit, type TicketTierEditable } from '@/lib/events/ticket-tier-edit';

const base: TicketTierEditable = {
  name: 'Regular', price: 5000, total_tickets: 100, sort_order: 0, is_active: true,
};
const original = { total_tickets: 100, tickets_sold: 28 };
const check = (patch: Partial<TicketTierEditable>, saved = true) =>
  validateTicketTierEdit({ ...base, ...patch }, saved ? original : undefined);

describe('Issue #716 — saved event ticket-tier edit validation', () => {
  it('preserves Unicode names, apostrophes, ampersands, and emojis', () => {
    expect(check({ name: "VIP — Òré's 🎟️ & Friends" })).toMatchObject({
      ok: true, value: { name: "VIP — Òré's 🎟️ & Friends" },
    });
  });
  it('trims whitespace but does not modify valid ticket labels', () => {
    expect(check({ name: '  VVIP  ' })).toMatchObject({ ok: true, value: { name: 'VVIP' } });
  });
  it('rejects empty names, excessive length, and control characters', () => {
    for (const name of ['', '   ', 'a'.repeat(101), 'Hello\u0000World', 'New\nLine']) {
      expect(check({ name }).ok).toBe(false);
    }
  });
  it('rejects negative, fractional, NaN, infinite and unsafe prices', () => {
    for (const price of [-1, 0.1, NaN, Infinity, 2147483648]) expect(check({ price }).ok).toBe(false);
    expect(check({ price: 0 }).ok).toBe(true);
  });
  it('rejects invalid capacities and sort order', () => {
    for (const total_tickets of [0, -5, 3.2, Number.MAX_SAFE_INTEGER]) {
      expect(check({ total_tickets }).ok).toBe(false);
    }
    for (const sort_order of [-1, 1.1, 10001]) expect(check({ sort_order }).ok).toBe(false);
  });
  it('prevents reducing capacity below sold inventory', () => {
    expect(check({ total_tickets: 27 }).ok).toBe(false);
  });
  it('also blocks otherwise-valid saved capacity decreases because pending WhatsApp reservations may not be counted', () => {
    const result = check({ total_tickets: 80 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('pending reservations');
  });
  it('allows growing inventory while leaving existing sold count untouched', () => {
    expect(check({ total_tickets: 150 })).toMatchObject({
      ok: true, value: { total_tickets: 150, price: 5000 },
    });
  });
  it('allows pausing or reactivating a tier without changing its identity', () => {
    expect(check({ is_active: false })).toMatchObject({ ok: true, value: { is_active: false } });
    expect(check({ is_active: true })).toMatchObject({ ok: true, value: { is_active: true } });
  });
  it('allows adjusting quantity downward before the new event is saved', () => {
    expect(check({ total_tickets: 40 }, false).ok).toBe(true);
  });
  it('rejects invalid active-state values', () => {
    expect(check({ is_active: 'yes' as unknown as boolean }).ok).toBe(false);
  });
});

describe('Issue #716 — integration boundaries', () => {
  const page = readFileSync('app/dashboard/events/page.tsx', 'utf-8');
  const purchase = readFileSync('app/api/events/purchase/route.ts', 'utf-8');
  const botFlow = readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
  it('saves through an ID/event-scoped conditional update and never touches tickets_sold', () => {
    expect(page).toContain(".update(validation.value)");
    expect(page).toContain(".eq('event_id', form.id)");
    expect(page).toContain(".eq('tickets_sold', original!.tickets_sold)");
    expect(page).not.toContain('.update({ tickets_sold:');
  });
  it('retains tier IDs rather than deleting sold or pending tiers', () => {
    expect(page).toContain(".update({ is_active: false })");
    expect(page).not.toContain(".from('event_ticket_types').delete()");
  });
  it('exposes edit for persisted and buffered tiers', () => {
    expect(page).toContain('beginSavedTierEdit(tt)');
    expect(page).toContain('beginPendingTierEdit(idx)');
    expect(page).toContain('saveTicketTierEdit');
  });
  it('passes the quoted unit price into the atomic DB purchase and distinguishes stale-price failure', () => {
    expect(purchase).toContain('p_expected_price: unitPrice');
    expect(purchase).toContain("rpcError.message?.includes('price_changed')");
  });
  it('web purchase route handles tier_paused RPC error with 409', () => {
    expect(purchase).toContain("rpcError.message?.includes('tier_paused')");
  });
  it('WhatsApp bot only shows active ticket types to customers', () => {
    expect(botFlow).toContain(".eq('is_active', true)");
    // The filter must be on the select_ticket_type step's skipIf query
    const skipIfIdx = botFlow.indexOf("id: 'select_ticket_type'");
    const filterIdx = botFlow.indexOf(".eq('is_active', true)", skipIfIdx);
    expect(skipIfIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeGreaterThan(skipIfIdx);
  });
  it('WhatsApp bot re-checks is_active in select_quantity to catch stale sessions', () => {
    // select_quantity.validate must query is_active and reject paused tiers
    const qtyStep = botFlow.indexOf("id: 'select_quantity'");
    expect(qtyStep).toBeGreaterThan(-1);
    const isActiveQuery = botFlow.indexOf("'total_tickets, tickets_sold, is_active'", qtyStep);
    expect(isActiveQuery).toBeGreaterThan(qtyStep);
    expect(botFlow).toContain('tt && !tt.is_active');
    expect(botFlow).toContain('this ticket type is no longer available');
  });
  it('WhatsApp bot uses atomic create_ticket_booking_checked RPC in process_tickets', () => {
    const processStep = botFlow.indexOf("id: 'process_tickets'");
    expect(processStep).toBeGreaterThan(-1);
    // Must call the atomic RPC, not a direct INSERT
    expect(botFlow).toContain("rpc('create_ticket_booking_checked'");
    // Must handle tier_paused and all_tiers_paused from the RPC
    expect(botFlow).toContain("rpcErr.message?.includes('tier_paused')");
    expect(botFlow).toContain("rpcErr.message?.includes('all_tiers_paused')");
  });
  it('WhatsApp bot clears stale tier state on event change', () => {
    // select_ticket_type.skipIf must clear _all_tiers_paused and _ticket_types
    expect(botFlow).toContain("delete ctx.session.session_data._all_tiers_paused");
    expect(botFlow).toContain("delete ctx.session.session_data._ticket_types");
  });
  it('WhatsApp bot treats tier lookup errors as errors (fail closed)', () => {
    // Query errors should not be interpreted as "no tiers"
    expect(botFlow).toContain('tierErr');
    expect(botFlow).toContain('activeErr');
  });
});
