/**
 * S-1 Catalog-Order Production Path Test (#256)
 *
 * Imports and invokes the actual production handleCatalogOrder()
 * from lib/channels/catalog-order-handler.ts — the same code
 * used by the webhook route via import.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/circuit-breaker', () => ({ isCircuitOpen: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn(), CircuitBreakerOpenError: class extends Error {} }));

let suspendedBizIds = new Set<string>();
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockImplementation(async (bizId: string) => {
    if (!bizId) throw Object.assign(new Error('Messaging suspended for business unknown: missing_business_id'), { name: 'MessagingSuspendedError' });
    if (suspendedBizIds.has(bizId)) throw Object.assign(new Error(`Messaging suspended for business ${bizId}: suspended`), { name: 'MessagingSuspendedError' });
  }),
}));
vi.mock('@/lib/bot/flows/shared/user', () => ({ createWhatsAppUser: vi.fn().mockResolvedValue('user-123') }));
vi.mock('@/lib/payments/factory', () => ({
  getPaymentGateway: vi.fn().mockReturnValue({ name: 'paystack', initializePayment: vi.fn().mockResolvedValue({ url: 'https://pay.test/123' }) }),
  getPaymentGatewayByName: vi.fn().mockReturnValue({ name: 'paystack', initializePayment: vi.fn().mockResolvedValue({ url: 'https://pay.test/123' }) }),
}));

const { MetaCloudSender } = await import('@/lib/channels/message-sender');
const { handleCatalogOrder } = await import('@/lib/channels/catalog-order-handler');
const { logger } = await import('@/lib/logger');

function createMockCloud() {
  return { sendText: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-1' }] }), sendButtons: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-2' }] }) };
}
function makeChain(data: unknown) {
  const c: Record<string, any> = {};
  for (const m of ['select','eq','neq','or','is','in','not','lt','gt','gte','lte','limit','order','head','insert','update','delete','upsert']) c[m] = vi.fn().mockReturnValue(c);
  c.single = vi.fn().mockResolvedValue({ data, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
  c.select = vi.fn().mockReturnValue(c);
  return c;
}

describe('S-1 Catalog-Order — production handleCatalogOrder (#256)', () => {
  beforeEach(() => { suspendedBizIds = new Set(); vi.clearAllMocks(); });
  const sharedChannel = { id: 'ch-shared', business_id: null, channel_type: 'shared', phone_number_id: 'pnid-1', is_active: true } as any;
  const catalogMsg = { order: { catalog_id: 'cat-A', product_items: [{ product_retailer_id: 'prod-1', quantity: 1, item_price: 5000, currency: 'NGN' }] }, id: 'meta-msg-1' };
  const msgLog = logger.withContext({ op: 'test' });

  it('shared channel NULL → active A → expected Meta call', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    expect(sender.boundBusinessId).toBe('');
    const supabase = {
      from: vi.fn().mockImplementation((t: string) => t === 'businesses' ? makeChain({ id: 'biz-A', name: 'Cat Biz', country_code: 'NG', payment_gateway: 'paystack', status: 'active' }) : makeChain(null)),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, order_id: 'ord-1', reference_code: 'WA-ORD-1', total_amount: 5000, items: [{ product_name: 'Widget', quantity: 1, unit_price: 5000 }], out_of_stock: [] }, error: null }),
    };
    await handleCatalogOrder(supabase as any, { channel: sharedChannel, sender } as any, catalogMsg, '+234800', msgLog, sender);
    expect(sender.boundBusinessId).toBe('biz-A');
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
  });

  it('shared channel NULL → suspended A → zero Meta calls', async () => {
    suspendedBizIds.add('biz-A');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    const supabase = {
      from: vi.fn().mockImplementation((t: string) => t === 'businesses' ? makeChain({ id: 'biz-A', name: 'Cat Biz', country_code: 'NG', payment_gateway: 'paystack', status: 'active' }) : makeChain(null)),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, order_id: 'ord-1', reference_code: 'R1', total_amount: 5000, items: [], out_of_stock: [] }, error: null }),
    };
    await handleCatalogOrder(supabase as any, { channel: sharedChannel, sender } as any, catalogMsg, '+234800', msgLog, sender);
    expect(sender.boundBusinessId).toBe('biz-A');
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  it('unavailable catalog → sendPlatformText neutral guidance', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    const supabase = { from: vi.fn().mockReturnValue(makeChain(null)), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
    await handleCatalogOrder(supabase as any, { channel: sharedChannel, sender } as any, catalogMsg, '+234800', msgLog, sender);
    expect(sender.boundBusinessId).toBe('');
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
    expect(cloud.sendText.mock.calls[0][0].text).toContain('unavailable');
  });

  it('shared-channel ownership remains NULL', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    const channelCopy = { ...sharedChannel };
    const supabase = {
      from: vi.fn().mockImplementation((t: string) => t === 'businesses' ? makeChain({ id: 'biz-A', name: 'C', country_code: 'NG', payment_gateway: 'paystack', status: 'active' }) : makeChain(null)),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, order_id: 'o1', reference_code: 'R1', total_amount: 0, items: [], out_of_stock: [] }, error: null }),
    };
    await handleCatalogOrder(supabase as any, { channel: channelCopy, sender } as any, catalogMsg, '+234800', msgLog, sender);
    expect(channelCopy.business_id).toBeNull();
    expect(sender.boundBusinessId).toBe('biz-A');
  });
});
