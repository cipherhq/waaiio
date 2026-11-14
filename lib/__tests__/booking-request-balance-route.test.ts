import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  ownerLookup: vi.fn(),
  capability: vi.fn(),
  initializePayment: vi.fn(),
  balance: vi.fn(),
  sendText: vi.fn(),
  emit: vi.fn(),
  ownerFilters: vi.fn(),
  entityFilters: vi.fn(),
}));

const business = { id: 'business-1', name: 'Example', country_code: 'NG', payment_gateway: null };
const booking = {
  id: 'booking-1', reference_code: 'WA-BK-1000', total_amount: 20000,
  deposit_amount: 5000, deposit_status: 'paid', guest_phone: '+2348000000000',
  guest_email: null, user_id: 'customer-1',
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: () => {
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { mocks.ownerFilters(key, value); return query; },
        single: mocks.ownerLookup,
      };
      return query;
    },
  }),
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { mocks.entityFilters(table, key, value); return query; },
        single: async () => ({ data: booking }),
        maybeSingle: async () => ({ data: null }),
      };
      return query;
    },
  }),
}));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: mocks.capability }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: mocks.initializePayment }));
vi.mock('@/lib/payments/entity-balance', () => ({ getEntityBalance: mocks.balance }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    async resolveByBusinessId() { return { sender: { sendText: mocks.sendText } }; }
  },
}));
vi.mock('@/lib/payments/proactive-localization', () => ({
  resolveProactiveLocalization: async () => ({ language: 'en' }),
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'test' }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));

import { POST } from '@/app/api/bookings/request-balance/route';

function requestBalance() {
  return POST(new NextRequest('http://localhost/api/bookings/request-balance', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingId: booking.id, businessId: business.id, table: 'bookings', amount: 1 }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'owner-1' } } });
  mocks.ownerLookup.mockResolvedValue({ data: business });
  mocks.capability.mockResolvedValue({ allowed: true });
  mocks.balance.mockResolvedValue({ totalAmount: 20000, netPaid: 5000, balanceDue: 15000 });
  mocks.initializePayment.mockResolvedValue({ reference: 'balance-reference', url: 'https://example.test/checkout' });
  mocks.sendText.mockImplementation(async (message: { messageCategory?: string }) => {
    // Model the existing financial guard at the sender boundary. No provider sends occur.
    if (!message.messageCategory) throw new Error('Financial authorization denied: missing_message_category');
    expect(message.messageCategory).toBe('service');
    mocks.emit(message);
    return { success: true };
  });
});

describe('booking request-balance route', () => {
  it('sends a categorized balance request using server balance and preserving the deposit link', async () => {
    const response = await requestBalance();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, balance: 15000, paymentUrl: 'https://example.test/checkout' });
    expect(mocks.ownerFilters).toHaveBeenCalledWith('owner_id', 'owner-1');
    expect(mocks.entityFilters).toHaveBeenCalledWith('bookings', 'business_id', business.id);
    expect(mocks.initializePayment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      bookingId: booking.id, businessId: business.id, amount: 15000, preserveEntityPaymentLink: true,
    }));
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      to: '2348000000000', messageCategory: 'service', text: expect.stringContaining('https://example.test/checkout'),
    }));
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });

  it('retains a financial authorization denial with no emission', async () => {
    mocks.sendText.mockImplementation(async () => { throw new Error('Financial authorization denied: insufficient_balance'); });
    const response = await requestBalance();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('rejects a non-owner before creating a checkout or sending', async () => {
    mocks.ownerLookup.mockResolvedValue({ data: null });
    const response = await requestBalance();
    expect(response.status).toBe(403);
    expect(mocks.initializePayment).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('rejects a capability denial before creating a checkout or sending', async () => {
    mocks.capability.mockResolvedValue({ allowed: false, status: 403, denial: { error: 'Capability denied' } });
    const response = await requestBalance();
    expect(response.status).toBe(403);
    expect(mocks.initializePayment).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });
});
