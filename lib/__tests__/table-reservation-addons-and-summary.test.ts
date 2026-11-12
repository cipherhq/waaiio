/**
 * Table reservations: add-ons are never offered (they would not be saved or
 * charged by book_table_atomic), and the confirmation summary names the table.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockContext, createMockSupabase, getStep } from '@/lib/bot/flows/__tests__/helpers';
import { schedulingFlow } from '@/lib/bot/flows/scheduling.flow';

const textOf = (msgs: unknown) => JSON.stringify(msgs);

describe('table reservation: add-ons step', () => {
  it('is skipped for tables, without querying add-ons, and clears carried-over add-on state', async () => {
    const supabase = createMockSupabase();
    const ctx = createMockContext({ supabase: supabase as any });
    ctx.session.session_data = { _is_table_reservation: true, _available_addons: [{ id: 'a1' }], _selected_addons: [{ id: 'a1', name: 'Cake', price: 5000 }] };
    expect(await getStep(schedulingFlow, 'select_addons').skipIf!(ctx)).toBe(true);
    expect(ctx.session.session_data).not.toHaveProperty('_available_addons');
    expect(ctx.session.session_data).not.toHaveProperty('_selected_addons');
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('is still offered for ordinary bookings that have optional add-ons', async () => {
    const addons = [{ id: 'a1', name: 'Cake', price: 5000, is_required: false }];
    const supabase = createMockSupabase({ from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'or']) c[m] = () => c;
      c.order = async () => ({ data: addons, error: null });
      return c;
    } });
    const ctx = createMockContext({ supabase: supabase as any });
    ctx.session.session_data = { service_id: 'svc-1' };
    expect(await getStep(schedulingFlow, 'select_addons').skipIf!(ctx)).toBe(false);
    expect(ctx.session.session_data._available_addons).toEqual(addons);
  });
});

describe('table reservation: confirmation summary', () => {
  const base = { date: '2026-12-05', time: '19:00', party_size: 4 };
  it('shows the chosen table, not a stale service name', async () => {
    const ctx = createMockContext();
    ctx.session.session_data = { ...base, _is_table_reservation: true, seating_resource_name: 'Patio Table 3', service_name: 'Haircut' };
    const out = textOf(await getStep(schedulingFlow, 'confirmation').prompt(ctx));
    expect(out).toContain('🪑 Patio Table 3');
    expect(out).not.toContain('Haircut');
  });
  it('keeps the service line for ordinary bookings', async () => {
    const ctx = createMockContext();
    ctx.session.session_data = { ...base, service_name: 'Haircut' };
    const out = textOf(await getStep(schedulingFlow, 'confirmation').prompt(ctx));
    expect(out).toContain('📌 Haircut');
  });
});


// This suite exercises confirmation UX with an untaxed authoritative quote.
// RPC validation and quote failures are covered by the merchant-tax suites.
vi.mock('@/lib/tax/server-quote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tax/server-quote')>()),
  quoteBookingTax: vi.fn(async (_db, input) => ({
    total: Math.max(Number(input.expectedTerms.price || 0) * input.partySize, Number(input.expectedTerms.deposit || 0)),
    deposit: Number(input.expectedTerms.deposit || 0), tax_snapshot: null,
  })),
}));
