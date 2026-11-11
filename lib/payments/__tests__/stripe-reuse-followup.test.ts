import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMemoryDb } from '../../__tests__/helpers/memory-db';

const mocks = vi.hoisted(() => ({ send: vi.fn(), resolve: vi.fn(), evidence: vi.fn(), compat: vi.fn(), eligibility: vi.fn() }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { resolveByChannelIdForBusiness = mocks.resolve; } }));
vi.mock('../saved-card-compat', async importOriginal => ({
  ...await importOriginal<typeof import('../saved-card-compat')>(), isCompatibleForSavedCard: mocks.compat,
}));
vi.mock('../stripe-saved-card', () => ({ extractStripeSavedCardEvidence: mocks.evidence }));
vi.mock('@/lib/bot/customer-updates-optin', () => ({
  transactionUpdatesOptInEligibility: mocks.eligibility,
  updatesOptInIncludesWaaiio: () => true,
  recordUpdatesOptIn: vi.fn(),
}));
vi.mock('../recurring-offer', () => ({ prepareRecurringOffer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { checkStripeConsentAndOffer } from '../saved-card-offer';
import { resumePaidTransactionFollowup } from '../transaction-followup';
import { handleTransactionFollowupTap } from '@/lib/bot/transaction-followups';

const id = '10000000-0000-4000-8000-000000000001';
const phone = '+2348012345678';
function fixture(savedMethod: unknown = true, reference = 'pi_saved_reuse') {
  const memory = createMemoryDb({
    transaction_followups: [{ id, completion_key: 'payment:pay', business_id: 'biz', phone,
      channel_id: 'channel', payment_id: 'pay', kind: 'ticketing', lang: 'en', state: 'waiting_card' }],
    payments: [{ id: 'pay', business_id: 'biz', status: 'success', gateway: 'stripe',
      gateway_reference: reference, confirmation_sent_at: new Date().toISOString(), metadata: { saved_method: savedMethod } }],
    payment_confirmation_deliveries: [{ id: 'delivery', payment_id: 'pay', delivery_status: 'sent' }],
    businesses: [{ id: 'biz', name: 'Test business', subscription_tier: 'starter', is_whitelabel: false }],
  });
  const rpc = vi.fn().mockRejectedValue(new Error('Unexpected card-offer RPC'));
  return { memory, rpc, db: { ...memory, rpc } as unknown as SupabaseClient };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockResolvedValue({ messageId: 'wamid.proof' });
  mocks.resolve.mockResolvedValue({ sender: { sendButtons: mocks.send, sendText: mocks.send },
    channel: { id: 'channel', channel_type: 'shared' } });
  mocks.compat.mockResolvedValue({ compatible: true });
  mocks.evidence.mockResolvedValue(null);
  mocks.eligibility.mockResolvedValue('eligible');
});

describe('Stripe saved-method completion through real paid and consent coordinators', () => {
  it('advances saved-method PaymentIntent reuse to opt-in, then business options after No', async () => {
    const { db, memory, rpc } = fixture();
    await resumePaidTransactionFollowup(db, 'pay');
    expect(memory.tables.transaction_followups[0].state).toBe('awaiting_optin');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0].buttons[0].id).toBe(`txupdates_yes:${id}`);
    expect(mocks.compat).not.toHaveBeenCalled();
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(memory.tables.payment_saved_card_offers).toEqual([]);

    await handleTransactionFollowupTap(db, { from: phone, channelId: 'channel',
      text: `txupdates_no:${id}`, messageType: 'button' });
    expect(memory.tables.transaction_followups[0].state).toBe('done');
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[1][0].buttons.some((button: { id: string }) => button.id === 'menu')).toBe(true);
  });

  it.each([undefined, false, 'true'])('keeps real Checkout null evidence retryable for saved_method=%s', async savedMethod => {
    const { db, memory, rpc } = fixture(savedMethod, 'cs_checkout');
    // Explicit undefined must not take the fixture default for this negative case.
    (memory.tables.payments[0].metadata as Record<string, unknown>).saved_method = savedMethod;
    await resumePaidTransactionFollowup(db, 'pay');
    expect(memory.tables.transaction_followups[0].state).toBe('card_active');
    expect(mocks.evidence).toHaveBeenCalledWith('cs_checkout');
    expect(mocks.eligibility).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not bypass tenant identity for a saved-method payment', async () => {
    const { db } = fixture();
    expect(await checkStripeConsentAndOffer(db, 'pay', phone, 'other-business', null)).toBe('retryable');
    expect(mocks.compat).not.toHaveBeenCalled();
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('keeps a payment read failure fenced without provider calls or prompts', async () => {
    const { db, memory } = fixture();
    memory.failReads.add('payments');
    expect(await checkStripeConsentAndOffer(db, 'pay', phone, 'biz', null)).toBe('retryable');
    await resumePaidTransactionFollowup(db, 'pay');
    expect(memory.tables.transaction_followups[0].state).toBe('waiting_card');
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
