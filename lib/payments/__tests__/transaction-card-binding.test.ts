import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryDb } from '@/lib/__tests__/helpers/memory-db';

const mocks = vi.hoisted(() => ({ finish: vi.fn(), fence: vi.fn(), verifyPin: vi.fn(), evidence: vi.fn(), downgrade: vi.fn() }));
vi.mock('@/lib/payments/stripe-saved-card', () => ({ extractStripeSavedCardEvidence: mocks.evidence, downgradeAllowRedisplay: mocks.downgrade }));
vi.mock('@/lib/payments/transaction-followup', () => ({ finishTransactionCardStep: mocks.finish }));
vi.mock('@/lib/payments/saved-card-delivery', () => ({ sendWithFencedDelivery: mocks.fence }));
vi.mock('@/lib/payments/saved-payment-adapter', () => ({ savedPaymentAdapter: { verifyPin: mocks.verifyPin } }));
vi.mock('@/lib/payments/saved-card-compat', () => ({
  canonicalSavedCardPhone: (phone: string) => phone.startsWith('+') ? phone : `+${phone}`,
  isSharedPlatformPaystackCompatible: vi.fn().mockResolvedValue({ compatible: true }),
  isCompatibleForSavedCard: vi.fn().mockResolvedValue({ compatible: true }),
}));
vi.mock('@/lib/payments/proactive-localization', () => ({
  resolveProactiveLocalization: vi.fn().mockResolvedValue({ language: 'en', translate: async (text: string) => text }),
}));

import { checkStripeConsentAndOffer, startSavedCardFromPaymentId } from '../saved-card-offer';
import { handleReplacementPinStep } from '@/lib/bot/handlers/saved-cards';

const phone = '+2348012345678';
const business = 'business-1';
const paymentId = 'payment-1';
const offerId = 'offer-1';
const channel = 'channel-1';
const oldMethod = {
  id: 'method-1', customer_phone: phone, gateway: 'paystack', is_active: true,
  authorization_code: 'fixture-old-auth', customer_code: 'fixture-customer',
  card_last4: '1234', card_brand: 'visa', credential_version: 3,
};
const payment = {
  id: paymentId, business_id: business, status: 'success', gateway: 'paystack', booking_id: 'booking-1',
  metadata: { payment_origin: 'platform', _card_authorization: {
    reusable: true, authorization_code: 'fixture-new-auth', customer_code: 'fixture-customer',
    email: 'fixture@example.test', last4: '5678', brand: 'visa',
  } },
};
const offer = { id: offerId, payment_id: paymentId, business_id: business, customer_phone: phone, channel_id: channel, state: 'accepted' };

function database(options: { replacement?: boolean; offers?: Record<string, unknown>[]; offerReadError?: boolean; commitFails?: boolean; claimFails?: boolean } = {}) {
  const memory = createMemoryDb({
    payments: [payment], bookings: [{ id: 'booking-1', guest_phone: phone }],
    saved_payment_methods: options.replacement ? [oldMethod] : [],
    payment_saved_card_offers: options.offers ?? [offer],
  });
  if (options.offerReadError) memory.failReads.add('payment_saved_card_offers');
  const rpc = vi.fn(async (name: string) => {
    if (name === 'commit_saved_card_offer') return { data: options.commitFails ? null : true, error: null };
    if (name === 'claim_confirmation_delivery') return options.claimFails
      ? { data: null, error: { message: 'claim failed' } }
      : { data: { claim_token: 'delivery-token', channel_id: channel, customer_phone: phone, business_id: business, committed_card_display: 'VISA ****5678' }, error: null };
    return { data: { success: true, version: 2 }, error: null };
  });
  return { ...memory, rpc };
}

function session(data: Record<string, unknown> = {}) {
  return { id: 'session-1', business_id: business, whatsapp_number: phone.slice(1), version: 1,
    current_step: 'replace_card_pin', session_data: data } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.finish.mockResolvedValue(undefined);
  mocks.fence.mockResolvedValue('delivered');
  mocks.verifyPin.mockResolvedValue({ valid: true });
});

describe('Exact accepted-offer binding at PIN entry', () => {
  it.each([false, true])('binds the exact accepted offer and channel for replacement=%s', async replacement => {
    const db = database({ replacement });
    const send = vi.fn().mockResolvedValue(undefined);
    await startSavedCardFromPaymentId(db as any, send, phone, session({ keep: 'existing-context' }), paymentId);
    const call = db.rpc.mock.calls.find(([name]) => name === 'update_session_cas') as any;
    expect(call[1]).toMatchObject({ p_business_id: business,
      p_current_step: replacement ? 'replace_card_pin' : 'save_card_pin',
      p_session_data: replacement
        ? { keep: 'existing-context', _replace_payment_id: paymentId, _replace_offer_id: offerId, _saved_card_channel_id: channel }
        : { keep: 'existing-context', _save_card_payment_id: paymentId, _save_card_offer_id: offerId, _saved_card_channel_id: channel },
    });
    expect(send).toHaveBeenCalledOnce();
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it('uses the same binding for a newly established PIN session', async () => {
    const db = database();
    await startSavedCardFromPaymentId(db as any, vi.fn(), phone, null, paymentId);
    expect(db.rpc).toHaveBeenCalledWith('establish_saved_card_session', expect.objectContaining({
      p_business_id: business, p_canon_phone: phone,
      p_session_data: expect.objectContaining({ _save_card_offer_id: offerId, _saved_card_channel_id: channel }),
    }));
  });

  it.each([
    { payment_id: 'other-payment' }, { business_id: 'other-business' },
    { customer_phone: '+2348099999999' }, { state: 'declined' },
  ])('does not bind an offer outside exact accepted authority: %o', async wrong => {
    const db = database({ offers: [{ ...offer, ...wrong }] });
    await startSavedCardFromPaymentId(db as any, vi.fn(), phone, session(), paymentId);
    const call = db.rpc.mock.calls.find(([name]) => name === 'update_session_cas') as any;
    expect(call[1].p_session_data._save_card_offer_id).toBeNull();
    expect(call[1].p_session_data._saved_card_channel_id).toBeNull();
    expect(call[1].p_session_data._inbound_channel_id).toBeUndefined();
  });

  it.each([false, true])('removes a previous offer binding when current exact offer is absent, replacement=%s', async replacement => {
    const db = database({ replacement, offers: [] });
    await startSavedCardFromPaymentId(db as any, vi.fn(), phone, session({
      _save_card_offer_id: 'old-save-offer', _replace_offer_id: 'old-replace-offer', _saved_card_channel_id: 'old-channel',
    }), paymentId);
    const call = db.rpc.mock.calls.find(([name]) => name === 'update_session_cas') as any;
    expect(call[1].p_session_data._save_card_offer_id).toBeNull();
    expect(call[1].p_session_data._replace_offer_id).toBeNull();
    expect(call[1].p_session_data._saved_card_channel_id).toBeNull();
  });

  it.each([false, true])('persists accepted-offer inbound provenance with and without a session, replacement=%s', async replacement => {
    for (const current of [null, session({ _inbound_channel_id: 'stale-channel', keep: true })]) {
      const db = database({ replacement });
      await startSavedCardFromPaymentId(db as any, vi.fn(), phone, current, paymentId);
      const call = db.rpc.mock.calls.find(([name]) => name === (current ? 'update_session_cas' : 'establish_saved_card_session')) as any;
      expect(call[1].p_session_data._inbound_channel_id).toBe(channel);
      expect(call[1].p_session_data._saved_card_channel_id).toBe(channel);
      if (current) expect(call[1].p_session_data.keep).toBe(true);
      expect(db.rpc.mock.calls.some(([name]) => name === 'select_shared_conversation')).toBe(false);
    }
  });

  it.each([false, true])('uses verified payment provenance for manual save/replacement=%s', async replacement => {
    const db = database({ replacement, offers: [] });
    db.tables.payments[0].metadata = { ...payment.metadata, _inbound_channel_id: 'payment-channel' };
    await startSavedCardFromPaymentId(db as any, vi.fn(), phone, null, paymentId);
    const call = db.rpc.mock.calls.find(([name]) => name === 'establish_saved_card_session') as any;
    expect(call[1].p_session_data._inbound_channel_id).toBe('payment-channel');
    expect(call[1].p_session_data._saved_card_channel_id).toBeNull();
  });

  it('preserves existing manual-session provenance and does not invent absent provenance', async () => {
    for (const current of [null, session({ _inbound_channel_id: 'session-channel' })]) {
      const db = database({ offers: [] });
      await startSavedCardFromPaymentId(db as any, vi.fn(), phone, current, paymentId);
      const call = db.rpc.mock.calls.find(([name]) => name === (current ? 'update_session_cas' : 'establish_saved_card_session')) as any;
      expect(call[1].p_session_data._inbound_channel_id).toBe(current ? 'session-channel' : undefined);
    }
  });

  it.each([false, true])('preserves the exact channel in provider-consented Stripe activation, replacement=%s', async replacement => {
    const db = database();
    db.tables.payments[0] = { ...payment, gateway: 'stripe', metadata: { _inbound_channel_id: channel } };
    db.tables.saved_payment_methods = replacement ? [{ ...oldMethod, gateway: 'stripe', stripe_payment_method_id: 'pm_old' }] : [];
    mocks.evidence.mockResolvedValue({ consented: true, paymentMethodId: 'pm_new', customerId: 'cus_fixture', cardLast4: '4242', cardBrand: 'visa' });
    mocks.downgrade.mockResolvedValue(true);
    db.rpc.mockImplementation(async (name: string) => {
      if (name === 'create_provider_consented_offer') return { data: { offer_id: offerId } as any, error: null };
      if (name === 'claim_exact_activation_delivery') return { data: { claim_token: 'token' } as any, error: null };
      return { data: { success: true } as any, error: null };
    });
    expect(await checkStripeConsentAndOffer(db as any, paymentId, phone, business, null)).toBe('pending');
    expect(db.rpc).toHaveBeenCalledWith('establish_saved_card_session', expect.objectContaining({
      p_session_data: expect.objectContaining({ _inbound_channel_id: channel, _saved_card_channel_id: channel }),
    }));
    expect(mocks.fence).toHaveBeenCalledWith(expect.objectContaining({ channelId: channel }));
  });

  it('fails closed on the offer read error instead of creating an unfenced PIN session', async () => {
    const db = database({ offerReadError: true });
    const send = vi.fn().mockResolvedValue(undefined);
    await startSavedCardFromPaymentId(db as any, send, phone, session(), paymentId);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(phone, 'Could not check card setup. Please try again.');
    expect(mocks.finish).not.toHaveBeenCalled();
  });
});

describe('Replacement acknowledgment gates transaction follow-ups', () => {
  function replacementSession() {
    return session({ _replace_method_id: oldMethod.id, _replace_payment_id: paymentId, _replace_offer_id: offerId,
      _saved_card_channel_id: channel, _replace_expected_state_hash: createHash('sha256')
        .update(`${oldMethod.id}:${oldMethod.authorization_code}:${oldMethod.customer_code}`).digest('hex') });
  }

  it.each(['delivered', 'ambiguous', 'pre_emission_failure', 'completion_failed'])('advances only after delivered; fence outcome=%s', async outcome => {
    const db = database({ replacement: true });
    const send = vi.fn().mockResolvedValue(undefined);
    mocks.fence.mockResolvedValue(outcome);
    await handleReplacementPinStep(db as any, send, phone, replacementSession(), '2468');
    expect(db.rpc).toHaveBeenCalledWith('commit_saved_card_offer', expect.objectContaining({
      p_offer_id: offerId, p_customer_phone: phone, p_method_id: oldMethod.id,
    }));
    expect(mocks.fence).toHaveBeenCalledWith(expect.objectContaining({
      offerId, claimToken: 'delivery-token', customerPhone: phone, businessId: business, channelId: channel,
      messageText: expect.stringContaining('VISA ****5678'),
      markStarted: expect.any(Function), complete: expect.any(Function), releasePreEmission: expect.any(Function),
    }));
    // The durable path never falls back to an unfenced direct success message.
    expect(send).not.toHaveBeenCalled();
    if (outcome === 'delivered') expect(mocks.finish).toHaveBeenCalledWith(db, paymentId, phone, business);
    else expect(mocks.finish).not.toHaveBeenCalled();
  });

  it.each([{ commitFails: true }, { claimFails: true }])('does not acknowledge or advance without commit/delivery claim: %o', async options => {
    const db = database({ replacement: true, ...options });
    const send = vi.fn().mockResolvedValue(undefined);
    await handleReplacementPinStep(db as any, send, phone, replacementSession(), '2468');
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not release opt-in while durable acknowledgment delivery is still pending', async () => {
    const db = database({ replacement: true });
    let resolveDelivery!: (outcome: string) => void;
    mocks.fence.mockImplementation(() => new Promise<string>(resolve => { resolveDelivery = resolve; }));
    const pending = handleReplacementPinStep(db as any, vi.fn(), phone, replacementSession(), '2468');
    await vi.waitFor(() => expect(mocks.fence).toHaveBeenCalledOnce());
    expect(mocks.finish).not.toHaveBeenCalled();
    resolveDelivery('delivered');
    await pending;
    expect(mocks.finish).toHaveBeenCalledOnce();
  });

  it('wrong PIN neither replaces credentials nor releases the completion', async () => {
    const db = database({ replacement: true });
    mocks.verifyPin.mockResolvedValue({ valid: false, attemptsRemaining: 2 });
    await handleReplacementPinStep(db as any, vi.fn(), phone, replacementSession(), '0000');
    expect(db.tables.saved_payment_methods[0].authorization_code).toBe(oldMethod.authorization_code);
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });
});
