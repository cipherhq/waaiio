/**
 * S-1 Catalog-Order Production Path Test (#256)
 *
 * Invokes the actual exported handleCatalogOrder() from the webhook route
 * with mocked Supabase/Meta to prove catalog-resolved business binding,
 * suspension enforcement, and shared-channel ownership invariants.
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

// Mock createWhatsAppUser (called inside handleCatalogOrder)
vi.mock('@/lib/bot/flows/shared/user', () => ({
  createWhatsAppUser: vi.fn().mockResolvedValue('user-123'),
}));

const { MetaCloudSender } = await import('@/lib/channels/message-sender');
const { handleCatalogOrder } = await import('@/app/api/webhook/meta-cloud/route');
const { logger } = await import('@/lib/logger');

function createMockCloud() {
  return {
    sendText: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-1' }] }),
    sendButtons: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-2' }] }),
  };
}

function makeChain(data: unknown) {
  const chain: Record<string, any> = {};
  for (const m of ['select', 'eq', 'neq', 'or', 'is', 'in', 'not', 'lt', 'gt', 'gte', 'lte', 'limit', 'order', 'head', 'insert', 'update', 'delete', 'upsert']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
  chain.select = vi.fn().mockReturnValue(chain);
  return chain;
}

describe('S-1 Catalog-Order Production handleCatalogOrder (#256)', () => {
  beforeEach(() => {
    suspendedBizIds = new Set();
    vi.clearAllMocks();
  });

  const sharedChannel = { id: 'ch-shared', business_id: null, channel_type: 'shared', phone_number_id: 'pnid-1', is_active: true } as any;
  const catalogMsg = { order: { catalog_id: 'cat-A', product_items: [{ product_retailer_id: 'prod-1', quantity: 1, item_price: 5000, currency: 'NGN' }] }, id: 'meta-msg-1' };
  const msgLog = logger.withContext({ op: 'test' });

  it('shared channel NULL → catalog resolves active A → response reaches Meta', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    expect(sender.boundBusinessId).toBe(''); // tenantless

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'businesses') return makeChain({ id: 'biz-A', name: 'Catalog Biz', country_code: 'NG', payment_gateway: 'paystack', status: 'active' });
        return makeChain(null);
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, order_id: 'ord-1', reference_code: 'WA-ORD-1', total_amount: 5000, items_with_prices: [{ product_id: 'prod-1', quantity: 1, unit_price: 5000, line_total: 5000 }], out_of_stock: [] }, error: null }),
    };

    await handleCatalogOrder(supabase as any, { channel: sharedChannel, sender } as any, catalogMsg, '+234800', msgLog, sender);

    // Production code bound biz-A
    expect(sender.boundBusinessId).toBe('biz-A');
    // Business-attributable catalog response reached Meta
    expect(cloud.sendText).toHaveBeenCalled();
  });

  it('shared channel NULL → catalog resolves suspended A → zero Meta calls', async () => {
    suspendedBizIds.add('biz-A');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    expect(sender.boundBusinessId).toBe('');

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'businesses') return makeChain({ id: 'biz-A', name: 'Catalog Biz', country_code: 'NG', payment_gateway: 'paystack', status: 'active' });
        return makeChain(null);
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, order_id: 'ord-1', reference_code: 'WA-ORD-1', total_amount: 5000, items_with_prices: [{ product_id: 'prod-1', quantity: 1, unit_price: 5000, line_total: 5000 }], out_of_stock: [] }, error: null }),
    };

    await handleCatalogOrder(supabase as any, { channel: sharedChannel, sender } as any, catalogMsg, '+234800', msgLog, sender);

    // Production code bound biz-A (before attempting sends)
    expect(sender.boundBusinessId).toBe('biz-A');
    // Suspended A: business-attributable sends blocked — zero Meta calls
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  it('unavailable catalog: sendPlatformText neutral guidance', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);

    const supabase = {
      from: vi.fn().mockReturnValue(makeChain(null)), // No business found
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    await handleCatalogOrder(supabase as any, { channel: sharedChannel, sender } as any, catalogMsg, '+234800', msgLog, sender);

    // No business resolved — stays tenantless
    expect(sender.boundBusinessId).toBe('');
    // Platform-scoped guidance sent
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
    expect(cloud.sendText.mock.calls[0][0].text).toContain('unavailable');
  });

  it('shared-channel ownership remains NULL after catalog binding', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    const channelCopy = { ...sharedChannel };

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'businesses') return makeChain({ id: 'biz-A', name: 'Cat Biz', country_code: 'NG', payment_gateway: 'paystack', status: 'active' });
        return makeChain(null);
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, order_id: 'ord-1', reference_code: 'WA-ORD-1', total_amount: 5000, items_with_prices: [], out_of_stock: [] }, error: null }),
    };

    await handleCatalogOrder(supabase as any, { channel: channelCopy, sender } as any, catalogMsg, '+234800', msgLog, sender);

    // Channel ownership unchanged
    expect(channelCopy.business_id).toBeNull();
    // Sender bound to A
    expect(sender.boundBusinessId).toBe('biz-A');
  });
});
