import { describe, it, expect, vi } from 'vitest';
import { buildPaymentNextStepsButtons, paymentNextStepsMenuSent } from '../next-steps-menu';

describe('buildPaymentNextStepsButtons', () => {
  it.each([
    ['ordering', 'my orders'],
    ['giving', 'my giving'],
    ['crowdfunding', 'my giving'],
    ['payment', 'history'],
    ['invoice', 'history'],
    ['scheduling', 'my bookings'],
    ['reservation', 'my bookings'],
  ])('%s → history button %s, then the business menu', (kind, historyId) => {
    const buttons = buildPaymentNextStepsButtons(kind, false);
    expect(buttons.map(b => b.id)).toEqual([historyId, 'menu']);
  });

  it('shared number adds the directory button and stays within 3 buttons', () => {
    const buttons = buildPaymentNextStepsButtons('ordering', true);
    expect(buttons.map(b => b.id)).toEqual(['my orders', 'menu', 'directory']);
    expect(buttons.length).toBeLessThanOrEqual(3);
  });

  it('IDs never change with language; titles use the bot copy and fit WhatsApp', () => {
    for (const lang of ['en', 'pcm', 'fr', 'xx']) {
      const buttons = buildPaymentNextStepsButtons('scheduling', true, lang);
      expect(buttons.map(b => b.id)).toEqual(['my bookings', 'menu', 'directory']);
      for (const b of buttons) expect(b.title.length).toBeGreaterThan(0);
    }
    expect(buildPaymentNextStepsButtons('scheduling', false, 'en').map(b => b.title)).toEqual(['My Bookings', 'View Options']);
  });
});

function db(opts: { payment?: unknown; paymentError?: unknown; deliveries?: unknown; deliveryError?: unknown; throws?: boolean } = {}) {
  const calls: Array<{ table: string; filters: unknown[][] }> = [];
  const from = vi.fn((table: string) => {
    if (opts.throws) throw new Error('boom');
    const call = { table, filters: [] as unknown[][] };
    calls.push(call);
    const c: Record<string, any> = {};
    for (const m of ['select', 'eq', 'in']) c[m] = vi.fn((...a: unknown[]) => { call.filters.push([m, ...a]); return c; });
    c.maybeSingle = vi.fn(async () => ({ data: opts.payment ?? null, error: opts.paymentError ?? null }));
    c.limit = vi.fn(async () => ({ data: opts.deliveries ?? [], error: opts.deliveryError ?? null }));
    return c;
  });
  return { client: { from } as any, calls };
}

describe('paymentNextStepsMenuSent', () => {
  it('saved-card payment with an accepted confirmation → true, without a reference lookup', async () => {
    const { client, calls } = db({ deliveries: [{ id: 'd1' }] });
    expect(await paymentNextStepsMenuSent(client, 'biz-1', { _saved_card_payment_id: 'pay-1' })).toBe(true);
    expect(calls.map(c => c.table)).toEqual(['payment_confirmation_deliveries']);
    expect(calls[0].filters).toContainEqual(['eq', 'payment_id', 'pay-1']);
    expect(calls[0].filters).toContainEqual(['in', 'delivery_status', ['accepted', 'sent', 'delivered', 'read']]);
  });

  it('payment reference lookup is scoped to the business', async () => {
    const { client, calls } = db({ payment: { id: 'pay-2' }, deliveries: [{ id: 'd1' }] });
    expect(await paymentNextStepsMenuSent(client, 'biz-1', { payment_reference: 'ref-9' })).toBe(true);
    expect(calls[0].table).toBe('payments');
    expect(calls[0].filters).toContainEqual(['eq', 'business_id', 'biz-1']);
    expect(calls[0].filters).toContainEqual(['eq', 'gateway_reference', 'ref-9']);
    expect(calls[1].filters).toContainEqual(['eq', 'payment_id', 'pay-2']);
  });

  it.each([
    ['no delivery handed to Meta', { payment: { id: 'p' }, deliveries: [] }, { payment_reference: 'r' }],
    ['payment not found', { payment: null }, { payment_reference: 'r' }],
    ['no payment reference at all', {}, {}],
    ['payment lookup error', { paymentError: { code: 'x' } }, { payment_reference: 'r' }],
    ['delivery lookup error', { payment: { id: 'p' }, deliveryError: { code: 'x' } }, { payment_reference: 'r' }],
    ['client throws', { throws: true }, { payment_reference: 'r' }],
  ])('%s → false, so the chat still shows its menu', async (_label, opts, sessionData) => {
    const { client } = db(opts as any);
    expect(await paymentNextStepsMenuSent(client, 'biz-1', sessionData)).toBe(false);
  });
});
