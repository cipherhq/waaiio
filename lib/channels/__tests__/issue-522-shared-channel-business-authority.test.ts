/**
 * Issue #522 / #266 — shared-channel tenant authority regression tests.
 *
 * A shared WhatsApp channel is transport infrastructure, not tenant authority.
 * Even if a stale shared-channel row carries a non-null business_id, inbound
 * resolution must not pre-resolve or bind that business. Dedicated channels
 * retain their existing authoritative behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFrom = vi.fn();
const boundBusinessIds: string[] = [];

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/channels/message-sender', () => ({
  MetaCloudSender: class {
    bindBusiness(id: string) {
      boundBusinessIds.push(id);
    }
  },
}));

function chain() {
  const c: Record<string, any> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
    c[method] = vi.fn().mockReturnValue(c);
  }
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  return c;
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'channel-1',
    country_code: 'US',
    phone_number: '12404712139',
    channel_type: 'shared',
    business_id: null,
    is_active: true,
    provider: 'meta_cloud',
    waba_id: 'waba-1',
    phone_number_id: '1347202708469075',
    meta_access_token: null,
    meta_token_expires_at: null,
    ...overrides,
  };
}

describe('#522 shared-channel business authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundBusinessIds.length = 0;
  });

  it('strips a stale shared-channel business_id on inbound Meta resolution and keeps cache safe', async () => {
    // Mirrors staging: shared channel row incorrectly carries Waaiio-test business_id.
    const sharedWithDefaultBusiness = makeChannel({
      channel_type: 'shared',
      business_id: 'waaiio-test-business',
    });

    mockFrom.mockImplementation((table: string) => {
      const c = chain();
      if (table === 'whatsapp_channels') {
        c.single = vi.fn().mockResolvedValue({ data: sharedWithDefaultBusiness, error: null });
      }
      return c;
    });

    const { ChannelResolver } = await import('../channel-resolver');
    const resolver = new ChannelResolver({ from: mockFrom } as any);

    const first = await resolver.resolveByPhoneNumberId('1347202708469075');
    expect(first).not.toBeNull();
    expect(first!.channel.channel_type).toBe('shared');
    expect(first!.channel.business_id).toBeNull();
    expect(boundBusinessIds).not.toContain('waaiio-test-business');

    // Second resolution exercises the resolver cache. Stale tenant authority must
    // not reappear after the first request has populated the cache.
    const second = await resolver.resolveByPhoneNumberId('1347202708469075');
    expect(second).not.toBeNull();
    expect(second!.channel.business_id).toBeNull();
    expect(boundBusinessIds).not.toContain('waaiio-test-business');

    // Only the first call should have hit the database; the second came from cache.
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('preserves dedicated-channel business authority', async () => {
    const dedicated = makeChannel({
      channel_type: 'dedicated',
      business_id: 'dedicated-business',
    });

    mockFrom.mockImplementation((table: string) => {
      const c = chain();
      if (table === 'whatsapp_channels') {
        c.single = vi.fn().mockResolvedValue({ data: dedicated, error: null });
      }
      return c;
    });

    const { ChannelResolver } = await import('../channel-resolver');
    const resolver = new ChannelResolver({ from: mockFrom } as any);
    const result = await resolver.resolveByPhoneNumberId('1347202708469075');

    expect(result).not.toBeNull();
    expect(result!.channel.business_id).toBe('dedicated-business');
    expect(boundBusinessIds).toContain('dedicated-business');
  });

  it('still stamps explicitly-authorized business identity onto a shared channel', async () => {
    const sharedWithStaleDefault = makeChannel({
      channel_type: 'shared',
      business_id: 'waaiio-test-business',
    });

    mockFrom.mockImplementation((table: string) => {
      const c = chain();
      if (table === 'whatsapp_channels') {
        c.maybeSingle = vi.fn().mockResolvedValue({ data: sharedWithStaleDefault, error: null });
      }
      return c;
    });

    const { ChannelResolver } = await import('../channel-resolver');
    const resolver = new ChannelResolver({ from: mockFrom } as any);
    const result = await resolver.resolveByChannelIdForBusiness('channel-1', 'testbiz-business');

    expect(result).not.toBeNull();
    // Transport metadata is tenantless for shared channels...
    expect(result!.channel.business_id).toBeNull();
    // ...while the caller's already-authoritative business is deliberately stamped.
    expect(boundBusinessIds).toContain('testbiz-business');
    expect(boundBusinessIds).not.toContain('waaiio-test-business');
  });
});
