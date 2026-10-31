import { describe, it, expect, vi } from 'vitest';
import { handleGlobalQuery } from '../handlers/global-queries';
import { getCustomerHistory } from '../customer-intelligence';
import { isSharedConversation, transactionNextSteps, persistDirectoryEntry } from '../flows/shared/navigation';
import { appointmentFlow } from '../flows/appointment.flow';
import { schedulingFlow } from '../flows/scheduling.flow';
import { paymentFlow } from '../flows/payment.flow';
import { createMockContext, getStep } from '../flows/__tests__/helpers';
import { parseDirectoryQuery } from '@/lib/marketplace/query-parser';

function database(rows: Record<string, any>, conflict = false) {
  const queries: Array<{ table: string; filters: any[] }> = [];
  const db = {
    from: vi.fn((table: string) => {
      const q = { table, filters: [] as any[] }; queries.push(q);
      const chain: any = {};
      let writing = false;
      chain.update = vi.fn((data: any) => { writing = true; q.filters.push(['update', data]); return chain; });
      for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit']) {
        chain[m] = vi.fn((...args: any[]) => { q.filters.push([m, ...args]); return chain; });
      }
      const result = () => ({ data: writing && conflict ? null : rows[table] ?? null, error: null });
      chain.maybeSingle = vi.fn(async () => result()); chain.single = chain.maybeSingle;
      chain.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
      return chain;
    }),
    rpc: vi.fn(async () => ({ data: conflict ? { success: false, reason: 'version_conflict' } : { success: true, version: 8 }, error: null })),
  };
  return { db, queries };
}

function reorderFixture(options: { conflict?: boolean; product?: any; item?: any; variant?: any; addons?: any[]; capabilities?: string[] } = {}) {
  const { db, queries } = database({
    orders: { id: 'order-a', reference_code: 'WA-O1' },
    order_items: [{ product_id: 'product-a', product_name: 'Old name', quantity: 2, unit_price: 10, ...options.item }],
    products: { id: 'product-a', name: 'Current name', price: 15, is_active: true, ...options.product },
    product_variants: options.variant,
    product_addons: options.addons || [],
    businesses: { id: 'merchant-a', name: 'A', country_code: 'NG' },
  }, options.conflict);
  const execute = vi.fn(); const sendText = vi.fn();
  const session: any = { id: 'bound-session', version: 7, business_id: 'merchant-a', whatsapp_number: '+2341',
    current_step: 'post_completion', session_data: {
      capabilities: options.capabilities || ['ordering'], _inbound_channel_id: 'shared-a', _conversation_version: 3,
      biz_resolution: 'exact', payment_reference: 'old-payment', order_id: 'old-order', promo_code: 'old-promo',
    } };
  const run = () => handleGlobalQuery({ supabase: db as any, messageSender: {} as any,
    flowExecutor: { execute } as any, sendText, from: '+2341', session,
    text: 'same again', messageType: 'text', getProfile: vi.fn(), handleMessage: vi.fn() });
  return { db, queries, session, execute, sendText, run };
}

describe('merchant-scoped repeat order', () => {
  it('retains the bound session and current prices without copying the old checkout', async () => {
    const f = reorderFixture(); const result = await f.run();
    expect(result.session?.id).toBe('bound-session');
    expect(f.db.rpc).toHaveBeenCalledTimes(1);
    expect(f.db.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({ p_session_id: 'bound-session', p_expected_version: 7 }));
    expect(result.session?.session_data).toMatchObject({ _inbound_channel_id: 'shared-a', _conversation_version: 3,
      cart: [{ product_id: 'product-a', name: 'Current name', quantity: 2, price: 15 }] });
    for (const key of ['payment_reference', 'order_id', 'promo_code']) expect(result.session?.session_data).not.toHaveProperty(key);
    expect(f.queries.find(q => q.table === 'orders')?.filters).toContainEqual(['eq', 'business_id', 'merchant-a']);
    expect(f.queries.find(q => q.table === 'products')?.filters).toContainEqual(['eq', 'business_id', 'merchant-a']);
    expect(f.execute).toHaveBeenCalledWith('+2341', '', result.session, expect.objectContaining({ id: 'merchant-a' }));
    expect(f.sendText.mock.calls[0][1]).toContain('Nothing has been ordered or charged');
  });
  it('preserves exact variant identity and loads its current price', async () => {
    const f = reorderFixture({ product: { has_variants: true }, item: { variant_id: 'red', variant_label: 'Red' },
      variant: { id: 'red', price: 20, is_active: true, stock_quantity: 3 } });
    const result = await f.run();
    expect(result.session?.session_data.cart).toEqual([{ product_id: 'product-a', name: 'Current name', quantity: 2, price: 20, variant_id: 'red', variant_label: 'Red' }]);
    expect(f.queries.find(q => q.table === 'product_variants')?.filters).toContainEqual(['eq', 'product_id', 'product-a']);
  });
  it.each([
    { product: { is_active: false } },
    { product: { deleted_at: '2026-10-01' } },
    { product: { min_order_qty: 3 } },
    { addons: [{ id: 'required-new-option' }] },
    { product: { track_inventory: true, stock_quantity: 1 } },
    { item: { variant_label: 'Deleted red' } },
    { item: { addons: [{ id: 'old-addon' }] } },
    { capabilities: ['appointment'] },
  ])('does not create a draft for unavailable or unreviewable items: %j', async options => {
    const f = reorderFixture(options); await f.run();
    expect(f.db.rpc).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    expect(f.sendText).toHaveBeenCalled();
  });
  it('CAS loser sends no checkout and cannot overwrite the winner', async () => {
    const f = reorderFixture({ conflict: true }); await f.run();
    expect(f.execute).not.toHaveBeenCalled(); expect(f.sendText).not.toHaveBeenCalled();
  });
});

describe('exact booking repeat selection', () => {
  it.each([
    ['appointment', appointmentFlow, 'select_appointment', 'appointments'],
    ['scheduling', schedulingFlow, 'select_service', 'services'],
  ] as const)('%s cannot substitute a sole remaining item for a removed historical item', async (cap, flow, id, table) => {
    const { db } = database({ [table]: null });
    const ctx = createMockContext({ supabase: db as any });
    ctx.session.session_data = { active_capability: cap, _repeat_selection_id: 'removed-a' };
    const step = getStep(flow, id);
    expect(await step.skipIf!(ctx)).toBe(false);
    expect(db.from).not.toHaveBeenCalled(); // singleton/default shortcut is bypassed
    const result = await step.validate!('removed-a', ctx);
    expect(result.valid).toBe(false);
    expect(ctx.session.session_data.service_id).toBeUndefined();
  });
  it('appointment repeat reloads current details under its merchant and advances to date selection', async () => {
    const { db, queries } = database({ appointments: { id: 'appointment-a', name: 'Consultation', price: 0, duration_minutes: 30, auto_approve: false } });
    const ctx = createMockContext({ supabase: db as any });
    ctx.session.session_data = { active_capability: 'appointment', _repeat_selection_id: 'appointment-a' };
    const step = getStep(appointmentFlow, 'select_appointment');
    expect(await step.skipIf!(ctx)).toBe(false);
    const result = await step.validate!('appointment-a', ctx);
    expect(result).toMatchObject({ valid: true, data: { service_price: 0, _is_appointment: true, _auto_approve: false } });
    expect(queries[0].filters).toContainEqual(['eq', 'business_id', ctx.business!.id]);
    Object.assign(ctx.session.session_data, result.data);
    expect(await step.next!(ctx)).toBe('select_date');
  });
  it('giving selection remains on the amount path and rejects inactive historical categories', async () => {
    const { db } = database({ services: { id: 'giving-a', name: 'Giving', price: 0, is_active: true, service_type: 'giving' } });
    const ctx = createMockContext({ supabase: db as any });
    ctx.session.session_data = { active_capability: 'giving', _repeat_selection_id: 'giving-a' };
    const step = getStep(paymentFlow, 'select_category');
    expect((await step.validate!('giving-a', ctx)).valid).toBe(true);
    expect(await step.next!(ctx)).toBe('enter_amount');
    const inactive = database({ services: { id: 'giving-a', is_active: false, service_type: 'giving' } });
    ctx.supabase = inactive.db as any; ctx.session.session_data._repeat_selection_id = 'giving-a';
    expect((await step.validate!('giving-a', ctx)).valid).toBe(false);
  });
});

describe('navigation and latest merchant activity', () => {
  it.each(['shared', 'dedicated'])('uses actual %s channel type', async type => {
    const { db } = database({ whatsapp_channels: { channel_type: type } });
    expect(await isSharedConversation(db as any, { _inbound_channel_id: 'channel' })).toBe(type === 'shared');
  });
  it('unknown channel never advertises directory access', async () => {
    const { db } = database({}); expect(await isSharedConversation(db as any, {})).toBe(false);
  });
  it.each(['ordering', 'appointment', 'table_reservation', 'giving', 'payment'])('%s next actions make no payment claim and distinguish channels', kind => {
    expect(transactionNextSteps(kind, false)).not.toMatch(/paid|payment received|directory/i);
    expect(transactionNextSteps(kind, true)).toContain('*directory*');
  });
  it.each([['restaurants in Ikoyi', 'restaurant', 'Ikoyi'], ['barbers in Lekki', 'barber', 'Lekki']])('advertised search %s parses category and locality', (query, category, place) => {
    const parsed = parseDirectoryQuery(query, 'NG');
    expect(parsed.categories).toContain(category); expect(parsed.locationText).toBe(place);
  });
  it('latest history query uses creation time, not future appointment date, and remains merchant scoped', async () => {
    const { db, queries } = database({ bookings: [{ id: 'b', appointment_id: 'a', date: '2099-01-01', created_at: '2026-10-01', total_amount: 0 }],
      appointments: [{ id: 'a', name: 'Free consultation' }], orders: { id: 'o', reference_code: 'O1', created_at: '2026-10-30' } });
    const result = await getCustomerHistory(db as any, '+2341', 'merchant-a');
    expect(result.lastEntityType).toBe('appointment'); expect(result.lastTransactionAt).toBe('2026-10-01');
    expect(result.lastOrder?.id).toBe('o');
    for (const table of ['bookings', 'orders', 'appointments']) expect(queries.find(q => q.table === table)?.filters).toContainEqual(['eq', 'business_id', 'merchant-a']);
    expect(queries[0].filters).toContainEqual(['order', 'created_at', { ascending: false }]);
  });
  it('order-only customers can receive a repeat suggestion', async () => {
    const { db } = database({ bookings: [], orders: { id: 'o', reference_code: 'O1', created_at: '2026-10-30' } });
    expect(await getCustomerHistory(db as any, '+2341', 'merchant-a')).toMatchObject({ isReturning: true, lastOrder: { id: 'o' } });
  });
});

describe('visible navigation through actual menu builders', () => {
  it.each(['shared', 'dedicated'])('%s completion emits usable transport-sized actions without claiming a payment', async channelType => {
    const { FlowExecutor } = await import('../flows/executor');
    const { db } = database({ whatsapp_channels: { channel_type: channelType } });
    const ctx = createMockContext({ supabase: db as any });
    ctx.session.session_data = { _inbound_channel_id: 'channel-a', active_capability: 'appointment', service_price: 0 };
    const executor = new FlowExecutor(db as any, ctx.sender, ctx.standalone, ctx.intelligence);
    await (executor as any).showPostCompletionMenu(ctx.from, ctx.session, ctx, {});
    if (channelType === 'shared') {
      expect(ctx.sender.sendList).toHaveBeenCalledWith(expect.objectContaining({ items: expect.arrayContaining([
        { title: 'Search directory', postbackText: 'nav_directory' },
      ]) }));
      const message = vi.mocked(ctx.sender.sendList).mock.calls[0][0];
      expect(message.items.length).toBeLessThanOrEqual(10);
      expect(message.body).not.toMatch(/paid|payment received/i);
    } else {
      expect(ctx.sender.sendList).not.toHaveBeenCalled();
      const message = vi.mocked(ctx.sender.sendButtons).mock.calls[0][0];
      expect(message.buttons.length).toBeLessThanOrEqual(3);
      expect(message.buttons.some(b => b.id === 'nav_directory')).toBe(false);
    }
  });
  it('shared single-capability merchant does not skip the directory option', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const { db } = database({ whatsapp_channels: { channel_type: 'shared' } });
    const ctx = createMockContext({ supabase: db as any });
    ctx.session.user_id = null;
    ctx.session.session_data = { _inbound_channel_id: 'channel-a', capabilities: ['chat'] };
    const step = getStep(capabilitySelectionFlow, 'select_capability');
    expect(await step.skipIf!(ctx)).toBe(false);
    const messages = await step.prompt(ctx);
    const items = messages.flatMap(m => m.type === 'buttons' ? m.buttons.map(b => b.id) : m.type === 'list' ? m.items.map(i => i.postbackText) : []);
    expect(items).toContain('cap_chat'); expect(items).toContain('nav_directory');
  });
});

describe('directory persistence before prompting', () => {
  it('does not take over another channel after a uniqueness collision', async () => {
    const { db, queries } = database({ bot_sessions: null });
    const original = db.from.getMockImplementation()!;
    db.from.mockImplementation((table: string) => {
      const chain = original(table);
      chain.insert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: null, error: { code: '23505' } }) }) }));
      return chain;
    });
    expect(await persistDirectoryEntry(db as any, '+2341', { _inbound_channel_id: 'this-channel' })).toBe(false);
    expect(db.rpc).not.toHaveBeenCalled();
    const reads = queries.filter(q => q.filters.some(f => f[0] === 'is' && f[1] === 'business_id'));
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(read.filters).toContainEqual(['eq', 'session_data->>_inbound_channel_id', 'this-channel']);
  });
  it('reuses a same-channel navigation session by CAS, and stops on conflict', async () => {
    const row = { id: 'picker', version: 4, expires_at: '2000-01-01T00:00:00Z', session_data: { _inbound_channel_id: 'this-channel' } };
    const ok = database({ bot_sessions: row });
    expect(await persistDirectoryEntry(ok.db as any, '+2341', row.session_data)).toBe(true);
    const write = ok.queries.find(q => q.filters.some(f => f[0] === 'update'))!;
    expect(write.filters).toContainEqual(['eq', 'version', 4]);
    const values = write.filters.find(f => f[0] === 'update')![1];
    expect(values.version).toBe(5);
    expect(new Date(values.expires_at).getTime()).toBeGreaterThan(Date.now());
    const stale = database({ bot_sessions: row }, true);
    expect(await persistDirectoryEntry(stale.db as any, '+2341', row.session_data)).toBe(false);
  });
});
