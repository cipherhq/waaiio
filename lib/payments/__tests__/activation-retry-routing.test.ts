import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryDb } from '@/lib/__tests__/helpers/memory-db';

const mocks = vi.hoisted(() => ({ db: null as any, fence: vi.fn(), recover: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: () => null }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => mocks.db }));
vi.mock('@/lib/payments/saved-card-delivery', () => ({
  sendWithFencedDelivery: mocks.fence,
  processSavedCardConfirmationRecovery: async () => ({ recovered: 0, errors: 0 }),
}));
vi.mock('@/lib/bot/transaction-followups', () => ({ recoverTransactionFollowups: mocks.recover }));

import { GET } from '@/app/api/cron/saved-card-activation-retry/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fence.mockResolvedValue('delivered');
});

describe('activation retry preserves originating channel for PIN routing', () => {
  it.each(['save', 'replace'])('restores routing provenance for %s activation', async offerType => {
    const memory = createMemoryDb({
      payment_saved_card_offers: [{ id: 'offer', payment_id: 'payment' }],
      transaction_followups: [{ payment_id: 'payment', state: 'card_active' }],
      provider_cleanup_operations: [], bot_sessions: [],
      payments: [{ id: 'payment', metadata: { stripe_pm_id: 'pm_fixture', stripe_customer_id: 'cus_fixture' } }],
    });
    let claimed = false;
    const rpc = vi.fn(async (name: string) => {
      if (name === 'claim_activation_delivery') {
        if (claimed) return { data: null, error: null };
        claimed = true;
        return { data: { offer_id: 'offer', claim_token: 'claim', channel_id: 'origin-channel',
          customer_phone: '+2348012345678', payment_id: 'payment', business_id: 'business',
          card_display: 'VISA ****1234', offer_type: offerType }, error: null };
      }
      return { data: true, error: null };
    });
    mocks.db = { ...memory, rpc };
    const response = await GET(new Request('http://localhost/api/cron/saved-card-activation-retry') as any);
    expect(await response.json()).toMatchObject({ retried: 1, errors: 0 });
    expect(rpc).toHaveBeenCalledWith('establish_saved_card_session', expect.objectContaining({
      p_business_id: 'business', p_current_step: 'save_card_pin',
      p_session_data: expect.objectContaining({
        _inbound_channel_id: 'origin-channel', _saved_card_channel_id: 'origin-channel',
        _save_card_offer_id: 'offer', _save_card_payment_id: 'payment',
      }),
    }));
    expect(mocks.fence).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'origin-channel', businessId: 'business' }));
  });
});
