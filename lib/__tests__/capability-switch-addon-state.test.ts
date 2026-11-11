/**
 * Add-on choices must not carry across a capability switch.
 *
 * A customer picks an add-on (e.g. "Cake") in one booking, then switches
 * capability (keyword, reroute, menu selection, or the saved-card "Menu"
 * button, which clears active_capability). If the next service has no
 * add-ons, select_addons.skipIf returns early without touching
 * _selected_addons, so the stale add-on was shown in the confirmation and
 * saved in the booking's addons_snapshot.
 *
 * Review finding P2-2 on PR #850 (re-confirmed on PR #853).
 */
import { describe, it, expect, vi } from 'vitest';
import { clearStaleCapabilityState } from '@/lib/bot/flows/shared/capability-transition';
import { createMockContext, createMockSupabase, getStep } from '@/lib/bot/flows/__tests__/helpers';
import { schedulingFlow } from '@/lib/bot/flows/scheduling.flow';

const CAKE = { id: 'a1', name: 'Cake', price: 5000 };

/** Supabase mock whose service_addons query returns no add-ons for the new service. */
function noAddonsSupabase() {
  return createMockSupabase({ from: () => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'or']) c[m] = () => c;
    c.order = async () => ({ data: [], error: null });
    return c;
  } });
}

describe('clearStaleCapabilityState: add-on state', () => {
  it('switching capability clears add-on choices and keeps identity', () => {
    const d: Record<string, unknown> = {
      active_capability: 'scheduling',
      _available_addons: [{ ...CAKE, is_required: false }],
      _selected_addons: [CAKE],
      first_name: 'Ada',
    };
    clearStaleCapabilityState(d, 'scheduling', 'appointment');
    expect(d).not.toHaveProperty('_available_addons');
    expect(d).not.toHaveProperty('_selected_addons');
    expect(d.first_name).toBe('Ada');
  });

  it('no previous capability (e.g. the saved-card Menu button): clears add-ons, keeps pre-filled booking data', () => {
    const d: Record<string, unknown> = {
      service_id: 'svc-prefilled',
      date: '2026-12-05',
      time: '14:00',
      party_size: 2,
      _available_addons: [{ ...CAKE, is_required: false }],
      _selected_addons: [CAKE],
    };
    clearStaleCapabilityState(d, undefined, 'scheduling');
    expect(d).not.toHaveProperty('_available_addons');
    expect(d).not.toHaveProperty('_selected_addons');
    // Fresh-session contract unchanged: smart-prefilled data survives.
    expect(d.service_id).toBe('svc-prefilled');
    expect(d.date).toBe('2026-12-05');
    expect(d.time).toBe('14:00');
    expect(d.party_size).toBe(2);
  });

  it('same capability: unchanged (no cleanup)', () => {
    const d: Record<string, unknown> = { active_capability: 'scheduling', service_id: 'svc-1', _selected_addons: [CAKE] };
    clearStaleCapabilityState(d, 'scheduling', 'scheduling');
    expect(d.service_id).toBe('svc-1');
    expect(d._selected_addons).toEqual([CAKE]);
  });
});

describe('stale add-on after a switch never reaches the confirmation', () => {
  for (const [label, from] of [['keyword/reroute switch', 'scheduling'], ['menu with no previous capability', undefined]] as const) {
    it(`${label}: next service has no add-ons → summary shows none`, async () => {
      const ctx = createMockContext({ supabase: noAddonsSupabase() as any });
      ctx.session.session_data = { active_capability: from, _selected_addons: [CAKE], _available_addons: [{ ...CAKE, is_required: false }] };

      clearStaleCapabilityState(ctx.session.session_data, from, 'appointment');
      ctx.session.session_data.active_capability = 'appointment';
      // Customer then picks a new service and time.
      Object.assign(ctx.session.session_data, { service_id: 'svc-new', service_name: 'Massage', date: '2026-12-05', time: '15:00', party_size: 1 });

      // The real add-ons step skips (no add-ons for svc-new) ...
      expect(await getStep(schedulingFlow, 'select_addons').skipIf!(ctx)).toBe(true);
      // ... and the real confirmation must not list the earlier add-on.
      const summary = JSON.stringify(await getStep(schedulingFlow, 'confirmation').prompt(ctx));
      expect(summary).toContain('Massage');
      expect(summary).not.toContain('Cake');
      expect(ctx.session.session_data._selected_addons).toBeUndefined();
    });
  }
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
