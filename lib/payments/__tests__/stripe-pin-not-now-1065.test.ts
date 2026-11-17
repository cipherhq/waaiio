/**
 * #1065 Owner Option A: one translated "Not now" reply button on the Stripe
 * provider-checkout PIN-activation prompt (and its PIN re-prompt). Tapping it
 * is exactly the existing typed `cancel` (cancel_transaction_card_setup, M534),
 * then the existing follow-up resume. Consent capture, charging, offer RPCs and
 * states, the Paystack flow and the follow-up order are unchanged.
 *
 * Behavioural: real checkStripeConsentAndOffer, real sendWithFencedDelivery and
 * the real PIN-step handler run against in-memory stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryDb } from '@/lib/__tests__/helpers/memory-db';

const m = vi.hoisted(() => ({
  finish: vi.fn(), evidence: vi.fn(), downgrade: vi.fn(), resolve: vi.fn(),
  l10n: { language: 'en', translate: vi.fn(async (text: string) => text) },
}));
vi.mock('@/lib/payments/stripe-saved-card', () => ({ extractStripeSavedCardEvidence: m.evidence, downgradeAllowRedisplay: m.downgrade }));
vi.mock('@/lib/payments/transaction-followup', () => ({ finishTransactionCardStep: m.finish }));
vi.mock('@/lib/payments/saved-payment-adapter', () => ({ savedPaymentAdapter: { verifyPin: vi.fn() } }));
vi.mock('@/lib/payments/saved-card-compat', () => ({
  canonicalSavedCardPhone: (phone: string) => phone.startsWith('+') ? phone : `+${phone}`,
  isCompatibleForSavedCard: vi.fn().mockResolvedValue({ compatible: true }),
  isSharedPlatformPaystackCompatible: vi.fn().mockResolvedValue({ compatible: true }),
}));
vi.mock('@/lib/payments/proactive-localization', () => ({ resolveProactiveLocalization: vi.fn(async () => m.l10n) }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { resolveByChannelIdForBusiness = m.resolve; } }));

import { checkStripeConsentAndOffer } from '../saved-card-offer';
import { sendWithFencedDelivery } from '../saved-card-delivery';
import { handleCardPinStep } from '@/lib/bot/handlers/saved-cards';

const phone = '+2348012345678';
const business = 'biz-A';
const paymentId = 'pay-stripe-1';
const channel = 'channel-1';
const SPANISH = { language: 'es', translate: vi.fn(async (text: string) => text === 'Not now' ? 'Ahora no' : `[es] ${text}`) };

beforeEach(() => {
  vi.clearAllMocks();
  m.l10n = { language: 'en', translate: vi.fn(async (text: string) => text) };
  m.finish.mockResolvedValue(undefined);
});

// ─── Activation prompt: button sent and localized ───

function stripeDb(metadata: Record<string, unknown> = { payment_origin: 'platform', _inbound_channel_id: channel }) {
  const memory = createMemoryDb({
    payments: [{ id: paymentId, business_id: business, status: 'success', gateway: 'stripe', gateway_reference: 'cs_fixture', metadata }],
    saved_payment_methods: [], payment_saved_card_offers: [],
  });
  const rpc = vi.fn(async (name: string) => {
    if (name === 'create_provider_consented_offer') return { data: { offer_id: 'offer-1', already_exists: false }, error: null };
    if (name === 'establish_saved_card_session') return { data: { session_id: 's1' }, error: null };
    if (name === 'claim_exact_activation_delivery') return { data: { claim_token: 'tok' }, error: null };
    return { data: true, error: null };
  });
  return { ...memory, rpc };
}

function capturingSender() {
  return {
    sendText: vi.fn(async () => ({ messageId: 'wamid.text' })),
    sendButtons: vi.fn(async () => ({ messageId: 'wamid.buttons' })),
  };
}

describe('Stripe PIN-activation prompt carries a localized Not now button', () => {
  beforeEach(() => {
    m.evidence.mockResolvedValue({ consented: true, paymentMethodId: 'pm_new', customerId: 'cus_1', paymentIntentId: 'pi_1', cardLast4: '4242', cardBrand: 'visa' });
    m.downgrade.mockResolvedValue(true);
  });

  it('sends the activation as a button message with the exact payment-scoped postback id (English)', async () => {
    const sender = capturingSender(); m.resolve.mockResolvedValue({ sender });
    const db = stripeDb();
    expect(await checkStripeConsentAndOffer(db as any, paymentId, phone, business, null)).toBe('pending');
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendButtons).toHaveBeenCalledWith({
      to: phone.slice(1),
      body: '🔒 You chose to save VISA ****4242 for faster checkout. Create your 4-digit *Waaiio PIN* to activate it.',
      buttons: [{ id: `stripe_pin_not_now:${paymentId}`, title: 'Not now' }],
      messageCategory: 'service',
    });
    expect(db.rpc).toHaveBeenCalledWith('complete_activation_delivery', { p_offer_id: 'offer-1', p_claim_token: 'tok' });
  });

  it('localizes body (card label protected) and button title; the id stays exact', async () => {
    m.l10n = SPANISH; const sender = capturingSender(); m.resolve.mockResolvedValue({ sender });
    await checkStripeConsentAndOffer(stripeDb() as any, paymentId, phone, business, null);
    expect(SPANISH.translate).toHaveBeenCalledWith(expect.stringContaining('You chose to save VISA ****4242'), ['VISA ****4242']);
    expect(sender.sendButtons).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/^\[es\] 🔒 You chose to save VISA \*\*\*\*4242/),
      buttons: [{ id: `stripe_pin_not_now:${paymentId}`, title: 'Ahora no' }],
    }));
  });

  it('falls back to English when localization fails', async () => {
    m.l10n = { language: 'es', translate: vi.fn(async () => { throw new Error('translator down'); }) };
    const sender = capturingSender(); m.resolve.mockResolvedValue({ sender });
    await checkStripeConsentAndOffer(stripeDb() as any, paymentId, phone, business, null);
    expect(sender.sendButtons).toHaveBeenCalledWith(expect.objectContaining({
      buttons: [{ id: `stripe_pin_not_now:${paymentId}`, title: 'Not now' }],
    }));
  });

  it.each(['byo', 'connect'])('merchant-connected Stripe (%s) is still skipped with no offer, session or message', async origin => {
    const sender = capturingSender(); m.resolve.mockResolvedValue({ sender });
    const db = stripeDb({ payment_origin: origin, _inbound_channel_id: channel });
    expect(await checkStripeConsentAndOffer(db as any, paymentId, phone, business, null)).toBe('skipped');
    expect(db.rpc).not.toHaveBeenCalled();
    expect(sender.sendButtons).not.toHaveBeenCalled(); expect(sender.sendText).not.toHaveBeenCalled();
  });
});

describe('Fenced delivery keeps its lifecycle with buttons', () => {
  const base = () => ({
    supabase: {} as any, offerId: 'o', claimToken: 't', customerPhone: phone, businessId: business, channelId: channel,
    messageText: 'body',
    markStarted: vi.fn(async () => ({ data: true, error: null })),
    complete: vi.fn(async () => ({ data: true, error: null })),
    releasePreEmission: vi.fn(async () => ({ data: true, error: null })),
  });

  it('without buttons it still sends plain text (Paystack/confirmation callers unchanged)', async () => {
    const sender = capturingSender(); m.resolve.mockResolvedValue({ sender });
    expect(await sendWithFencedDelivery(base())).toBe('delivered');
    expect(sender.sendText).toHaveBeenCalledWith({ to: phone.slice(1), text: 'body', messageCategory: 'service' });
    expect(sender.sendButtons).not.toHaveBeenCalled();
  });

  it('an ambiguous button send leaves the fence set (no release, no completion)', async () => {
    const sender = capturingSender(); sender.sendButtons.mockRejectedValue(new Error('socket hang up'));
    m.resolve.mockResolvedValue({ sender });
    const params = { ...base(), buttons: [{ id: 'stripe_pin_not_now:x', title: 'Not now' }] };
    expect(await sendWithFencedDelivery(params)).toBe('ambiguous');
    expect(params.releasePreEmission).not.toHaveBeenCalled(); expect(params.complete).not.toHaveBeenCalled();
  });
});

// ─── PIN step: tap == typed cancel, scoped and idempotent ───

function pinSession(overrides: { data?: Record<string, unknown>; business_id?: string; current_step?: string } = {}) {
  return {
    id: 'session-1', whatsapp_number: phone.slice(1), business_id: overrides.business_id ?? business, version: 4,
    current_step: overrides.current_step ?? 'save_card_pin',
    session_data: {
      _inbound_channel_id: channel, _save_card_pending: true, _save_card_business_id: business,
      _save_card_gateway: 'stripe', _save_card_payment_id: paymentId, _save_card_offer_id: 'offer-1',
      _saved_card_channel_id: channel, _save_card_auth: { stripe_payment_method_id: 'pm_new' },
      ...overrides.data,
    },
  } as any;
}

function pinDb(cancelResult: unknown = { success: true, version: 5 }) {
  const memory = createMemoryDb({ payments: [] });
  const rpc = vi.fn(async () => ({ data: cancelResult, error: null }));
  return { ...memory, rpc };
}

async function run(text: string, session = pinSession(), db = pinDb()) {
  const sendText = vi.fn(async () => undefined);
  const sendButtons = vi.fn(async () => undefined);
  await handleCardPinStep(db as any, sendText, phone, session, text, sendButtons);
  return { db, sendText, sendButtons, session };
}

describe('Not now tap on the Stripe PIN step', () => {
  it('produces exactly the typed-cancel outcome: same RPC call, messages and follow-up resume', async () => {
    const typed = await run('cancel');
    const finishAfterTyped = m.finish.mock.calls.slice();
    m.finish.mockClear();
    const tapped = await run(`stripe_pin_not_now:${paymentId}`);

    expect(tapped.db.rpc.mock.calls).toEqual(typed.db.rpc.mock.calls);
    expect(tapped.db.rpc).toHaveBeenCalledWith('cancel_transaction_card_setup', expect.objectContaining({
      p_session_id: 'session-1', p_expected_version: 4, p_payment_id: paymentId,
      p_customer_phone: phone, p_business_id: business,
    }));
    expect(tapped.sendText.mock.calls).toEqual(typed.sendText.mock.calls);
    expect(tapped.sendText).toHaveBeenCalledWith(phone, 'Card save cancelled.');
    // Same follow-up resume arguments (the client differs per run by construction).
    expect(m.finish.mock.calls.map(c => c.slice(1))).toEqual(finishAfterTyped.map(c => c.slice(1)));
    expect(m.finish).toHaveBeenCalledWith(tapped.db, paymentId, phone, business);
    expect(tapped.session.version).toBe(5);
  });

  it('a duplicate tap that loses the CAS race changes nothing and does not resume twice', async () => {
    const result = await run(`stripe_pin_not_now:${paymentId}`, pinSession(), pinDb({ success: false, reason: 'version_conflict' }));
    expect(result.sendText).toHaveBeenCalledWith(phone, 'Card setup is still processing. Please try again shortly.');
    expect(m.finish).not.toHaveBeenCalled();
  });

  it('activation still processing (M534 provider_checkout guard) behaves like typed cancel and does not resume', async () => {
    const typed = await run('cancel', pinSession(), pinDb({ success: false, reason: 'activation_processing' }));
    const tapped = await run(`stripe_pin_not_now:${paymentId}`, pinSession(), pinDb({ success: false, reason: 'activation_processing' }));
    expect(tapped.sendText.mock.calls).toEqual(typed.sendText.mock.calls);
    expect(m.finish).not.toHaveBeenCalled();
  });

  it.each([
    ['another payment', `stripe_pin_not_now:pay-other`, pinSession()],
    ['another business (session bound elsewhere)', `stripe_pin_not_now:${paymentId}`, pinSession({ business_id: 'biz-B' })],
    ['a Paystack PIN session', `stripe_pin_not_now:${paymentId}`, pinSession({ data: { _save_card_gateway: 'paystack' } })],
    ['a non-PIN step', `stripe_pin_not_now:${paymentId}`, pinSession({ current_step: 'verify_card_pin' })],
    ['an empty payment id', 'stripe_pin_not_now:', pinSession()],
  ])('a tap scoped to %s does nothing', async (_label, text, session) => {
    const result = await run(text, session);
    expect(result.db.rpc).not.toHaveBeenCalled();
    expect(result.sendText).not.toHaveBeenCalled(); expect(result.sendButtons).not.toHaveBeenCalled();
    expect(m.finish).not.toHaveBeenCalled();
  });
});

describe('Typed input on the PIN step is unchanged apart from the Stripe re-prompt button', () => {
  it('typed cancel still cancels a Paystack PIN session', async () => {
    const result = await run('cancel', pinSession({ data: { _save_card_gateway: 'paystack' } }));
    expect(result.db.rpc).toHaveBeenCalledWith('cancel_transaction_card_setup', expect.objectContaining({ p_payment_id: paymentId }));
    expect(result.sendText).toHaveBeenCalledWith(phone, 'Card save cancelled.');
  });

  it('invalid PIN on the Stripe step re-prompts with the same Not now button', async () => {
    const result = await run('12a');
    expect(result.sendText).not.toHaveBeenCalled();
    expect(result.sendButtons).toHaveBeenCalledWith({
      to: phone.slice(1), body: 'Please enter exactly *4 digits* for your Waaiio PIN:',
      buttons: [{ id: `stripe_pin_not_now:${paymentId}`, title: 'Not now' }],
    });
    expect(result.db.rpc).not.toHaveBeenCalled();
  });

  it('invalid PIN on a Paystack PIN step keeps the plain-text re-prompt', async () => {
    const result = await run('12a', pinSession({ data: { _save_card_gateway: 'paystack' } }));
    expect(result.sendButtons).not.toHaveBeenCalled();
    expect(result.sendText).toHaveBeenCalledWith(phone, 'Please enter exactly *4 digits* for your Waaiio PIN:');
  });

  it('a typed 4-digit PIN still proceeds to PIN creation (reads the source payment), never cancels', async () => {
    const db = pinDb();
    const result = await run('1234', pinSession(), db);
    expect(db.rpc).not.toHaveBeenCalledWith('cancel_transaction_card_setup', expect.anything());
    // Source payment is re-read (absent here), so the PIN path continued past the input gates.
    expect(result.sendText).toHaveBeenCalledWith(phone, 'The payment is no longer available. Please type *save card* again.');
    expect(m.finish).not.toHaveBeenCalled();
  });
});
