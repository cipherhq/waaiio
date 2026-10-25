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
});
