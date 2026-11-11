import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ resume: vi.fn(), claim: vi.fn(), offer: vi.fn(), retry: vi.fn(), stripe: vi.fn(), eligibility: vi.fn(), resolve: vi.fn() }));
vi.mock('@/lib/bot/transaction-followups', () => ({ resumeTransactionFollowupForPayment: m.resume, claimTransactionCardStep: m.claim }));
vi.mock('../saved-card-offer', () => ({ checkAndOfferSavedCard: m.offer, retryPendingSavedCardOffer: m.retry,
  checkStripeConsentAndOffer: m.stripe, checkSavedCardOfferEligibility: m.eligibility }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { resolveByChannelIdForBusiness = m.resolve; } }));
import { resumePaidTransactionFollowup, finishTransactionCardStep } from '../transaction-followup';

function db(options: { state?: string; finalized?: boolean; delivered?: boolean; offer?: string; gateway?: string; pin?: boolean; errorTable?: string; missing?: boolean } = {}) {
  const queries: Array<{ table: string; filters: unknown[][] }> = [];
  return { queries, from: vi.fn((table: string) => {
    const query = { table, filters: [] as unknown[][] }; queries.push(query);
    const data = table === 'transaction_followups' ? options.missing ? null : { id: 'f1', business_id: 'biz', phone: '+2348012345678', channel_id: 'channel', state: options.state || 'waiting_card' }
      : table === 'payments' ? { status: 'success', gateway: options.gateway || 'paystack', confirmation_sent_at: options.finalized === false ? null : '2026-11-11' }
        : table === 'payment_saved_card_offers' ? options.offer ? { state: options.offer } : null
          : table === 'payment_confirmation_deliveries' ? options.delivered === false ? [] : [{ id: 'delivery' }]
          : table === 'bot_sessions' ? options.pin ? [{ id: 'pin' }] : [] : null;
    const result = { data, error: options.errorTable === table ? { code: 'failed' } : null };
    const chain: Record<string, any> = {};
    for (const name of ['select', 'eq', 'in', 'limit']) chain[name] = (...args: unknown[]) => { query.filters.push([name, ...args]); return chain; };
    chain.maybeSingle = async () => result;
    chain.then = (resolve: (result: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  }) };
}

beforeEach(() => {
  vi.clearAllMocks(); m.claim.mockResolvedValue(true); m.resolve.mockResolvedValue({ sender: {} }); m.eligibility.mockResolvedValue({ eligible: true });
  m.stripe.mockResolvedValue('pending'); m.resume.mockResolvedValue(undefined);
});

describe('paid completion gates', () => {
  it('does not offer a card before fulfillment finalizes', async () => {
    await resumePaidTransactionFollowup(db({ finalized: false }) as any, 'pay');
    expect(m.offer).not.toHaveBeenCalled(); expect(m.resume).not.toHaveBeenCalled();
  });
  it('does not advance past an indeterminate confirmation send', async () => {
    await resumePaidTransactionFollowup(db({ delivered: false }) as any, 'pay');
    expect(m.offer).not.toHaveBeenCalled(); expect(m.resume).not.toHaveBeenCalled();
  });
  it.each(['sent', 'accepted', 'committed', 'ambiguous'])('waits for card %s without prompting opt-in or menu', async offer => {
    await resumePaidTransactionFollowup(db({ offer }) as any, 'pay');
    expect(m.resume).not.toHaveBeenCalled(); expect(m.offer).not.toHaveBeenCalled();
  });
  it.each(['confirmed', 'declined'])('advances after durable card %s', async offer => {
    const client = db({ offer }); await resumePaidTransactionFollowup(client as any, 'pay');
    expect(m.resume).toHaveBeenCalledWith(client, 'pay', { cardResolved: true });
  });
  it('retries only pending card delivery and preserves its gate', async () => {
    const client = db({ offer: 'pending' }); await resumePaidTransactionFollowup(client as any, 'pay');
    expect(m.retry).toHaveBeenCalledWith(client, 'pay'); expect(m.resume).not.toHaveBeenCalled();
  });
  it('does not start a competing card offer when another completion owns the conversation', async () => {
    m.claim.mockResolvedValue(false);
    await resumePaidTransactionFollowup(db() as any, 'pay');
    expect(m.offer).not.toHaveBeenCalled(); expect(m.resume).not.toHaveBeenCalled();
  });
  it('offers on the exact originating channel and leaves opt-in waiting', async () => {
    const client = db(); await resumePaidTransactionFollowup(client as any, 'pay');
    expect(m.resolve).toHaveBeenCalledWith('channel', 'biz');
    expect(m.offer).toHaveBeenCalledWith(client, 'pay', '+2348012345678', 'biz', {}, 'channel');
    expect(m.resume).not.toHaveBeenCalled();
  });
  it.each(['auth_not_eligible', 'same_auth_already_saved', 'not_platform'])('skips proven ineligible card: %s', async reason => {
    m.eligibility.mockResolvedValue({ eligible: false, reason });
    const client = db(); await resumePaidTransactionFollowup(client as any, 'pay');
    expect(m.resume).toHaveBeenCalledWith(client, 'pay', { cardResolved: true });
  });
  it.each(['saved_card_read_error', 'credential_lookup_error', 'customer_unresolved'])('does not skip a failed eligibility lookup: %s', async reason => {
    m.eligibility.mockResolvedValue({ eligible: false, reason });
    await resumePaidTransactionFollowup(db() as any, 'pay'); expect(m.resume).not.toHaveBeenCalled();
  });
  it('does not interrupt another active PIN', async () => {
    await resumePaidTransactionFollowup(db({ pin: true }) as any, 'pay');
    expect(m.offer).not.toHaveBeenCalled(); expect(m.resume).not.toHaveBeenCalled();
  });
  it.each(['transaction_followups', 'payments', 'payment_saved_card_offers', 'payment_confirmation_deliveries', 'bot_sessions'])('lookup failure in %s does not advance', async errorTable => {
    await resumePaidTransactionFollowup(db({ errorTable }) as any, 'pay'); expect(m.resume).not.toHaveBeenCalled();
  });
  it.each(['pending', 'retryable', 'skipped'])('Stripe result %s', async outcome => {
    m.stripe.mockResolvedValue(outcome); await resumePaidTransactionFollowup(db({ gateway: 'stripe' }) as any, 'pay');
    expect(m.resume).toHaveBeenCalledTimes(outcome === 'skipped' ? 1 : 0);
  });
  it('acknowledgment continuation is bound to payment, phone and business', async () => {
    const client = db(); await finishTransactionCardStep(client as any, 'pay', '2348012345678', 'biz');
    expect(client.queries[0].filters).toEqual(expect.arrayContaining([
      ['eq', 'payment_id', 'pay'], ['eq', 'business_id', 'biz'], ['eq', 'phone', '+2348012345678'],
    ]));
    expect(m.resume).toHaveBeenCalledWith(client, 'pay', { cardResolved: true });
  });
  it('does not advance a missing or mismatched completion', async () => {
    await finishTransactionCardStep(db({ missing: true }) as any, 'pay', '2348012345678', 'biz');
    expect(m.resume).not.toHaveBeenCalled();
  });
});
