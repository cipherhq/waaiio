/**
 * Shared-channel business authority tests.
 *
 * Proves resolveByChannelIdForBusiness enforces the authorization model:
 * - Shared channel: any business authorized
 * - Dedicated channel owned by business: authorized
 * - Dedicated channel owned by another business: rejected (unless assigned)
 * - Assigned channel: authorized regardless of type
 * - Returned sender always stamped with authoritative businessId
 *
 * Implementation-Agent: Claude Code
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom } as unknown;

function chain() {
  const c: Record<string, unknown> = {};
  ['select', 'eq', 'in', 'order', 'limit'].forEach(m => { (c as Record<string, unknown>)[m] = vi.fn().mockReturnValue(c); });
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  return c;
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ch-1',
    country_code: 'NG',
    phone_number: '+2341234567890',
    channel_type: 'shared',
    business_id: null,
    is_active: true,
    provider: 'meta_cloud',
    waba_id: 'waba-1',
    phone_number_id: 'pn-1',
    meta_access_token: 'tok',
    meta_token_expires_at: null,
    ...overrides,
  };
}

// Mock MetaCloudService constructor
vi.mock('@/lib/channels/meta-cloud-service', () => ({
  MetaCloudService: class {
    constructor() {}
  },
}));

// Track bindBusiness calls
const boundBusinessIds: string[] = [];
vi.mock('@/lib/channels/message-sender', () => ({
  MetaCloudSender: class {
    _businessId = '';
    bindBusiness(id: string) { if (id) { this._businessId = id; boundBusinessIds.push(id); } }
  },
}));

describe('resolveByChannelIdForBusiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundBusinessIds.length = 0;
  });

  it('shared channel + any business → authorized + business stamped', async () => {
    const sharedChannel = makeChannel({ channel_type: 'shared', business_id: null });
    mockFrom.mockImplementation((table: string) => {
      const c = chain();
      if (table === 'whatsapp_channels') c.maybeSingle = vi.fn().mockResolvedValue({ data: sharedChannel, error: null });
      return c;
    });

    const { ChannelResolver } = await import('../channel-resolver');
    const resolver = new ChannelResolver(mockSupabase as any);
    const result = await resolver.resolveByChannelIdForBusiness('ch-1', 'biz-A');

    expect(result).not.toBeNull();
    // Business was stamped onto the sender
    expect(boundBusinessIds).toContain('biz-A');
  });

  it('dedicated channel owned by the business → authorized', async () => {
    const dedicatedChannel = makeChannel({ channel_type: 'dedicated', business_id: 'biz-A' });
    mockFrom.mockImplementation((table: string) => {
      const c = chain();
      if (table === 'whatsapp_channels') c.maybeSingle = vi.fn().mockResolvedValue({ data: dedicatedChannel, error: null });
      return c;
    });

    const { ChannelResolver } = await import('../channel-resolver');
    const resolver = new ChannelResolver(mockSupabase as any);
    const result = await resolver.resolveByChannelIdForBusiness('ch-1', 'biz-A');

    expect(result).not.toBeNull();
    expect(boundBusinessIds).toContain('biz-A');
  });

  it('dedicated channel owned by ANOTHER business → rejected (returns null)', async () => {
    const otherBizChannel = makeChannel({ channel_type: 'dedicated', business_id: 'biz-OTHER' });
    mockFrom.mockImplementation((table: string) => {
      const c = chain();
      if (table === 'whatsapp_channels') c.maybeSingle = vi.fn().mockResolvedValue({ data: otherBizChannel, error: null });
      if (table === 'businesses') c.single = vi.fn().mockResolvedValue({
        data: { assigned_channel_id: null, whatsapp_channel_id: null }, error: null,
      });
      return c;
    });

    const { ChannelResolver } = await import('../channel-resolver');
    const resolver = new ChannelResolver(mockSupabase as any);
    const result = await resolver.resolveByChannelIdForBusiness('ch-1', 'biz-A');

    // Rejected — not authorized
    expect(result).toBeNull();
    // No business was stamped
    expect(boundBusinessIds).not.toContain('biz-A');
  });

  it('dedicated channel owned by another but assigned to requesting business → authorized', async () => {
    const otherBizChannel = makeChannel({ id: 'ch-assigned', channel_type: 'dedicated', business_id: 'biz-OTHER' });
    mockFrom.mockImplementation((table: string) => {
      const c = chain();
      if (table === 'whatsapp_channels') c.maybeSingle = vi.fn().mockResolvedValue({ data: otherBizChannel, error: null });
      if (table === 'businesses') c.single = vi.fn().mockResolvedValue({
        data: { assigned_channel_id: 'ch-assigned', whatsapp_channel_id: null }, error: null,
      });
      return c;
    });

    const { ChannelResolver } = await import('../channel-resolver');
    const resolver = new ChannelResolver(mockSupabase as any);
    const result = await resolver.resolveByChannelIdForBusiness('ch-assigned', 'biz-A');

    expect(result).not.toBeNull();
    expect(boundBusinessIds).toContain('biz-A');
  });

  it('nonexistent channel → returns null', async () => {
    mockFrom.mockImplementation(() => {
      const c = chain();
      c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      return c;
    });

    const { ChannelResolver } = await import('../channel-resolver');
    const resolver = new ChannelResolver(mockSupabase as any);
    const result = await resolver.resolveByChannelIdForBusiness('ch-nonexistent', 'biz-A');

    expect(result).toBeNull();
  });

  it('empty channelId → returns null', async () => {
    const { ChannelResolver } = await import('../channel-resolver');
    const resolver = new ChannelResolver(mockSupabase as any);
    const result = await resolver.resolveByChannelIdForBusiness('', 'biz-A');
    expect(result).toBeNull();
  });
});
