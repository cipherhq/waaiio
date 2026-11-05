/**
 * Owner decision 2026-11-04 (option A): the owner's "new order" alert.
 *
 * - Orders the customer pays ONLINE (payment link, saved card) get NO alert at
 *   creation. The only alert is the one sent after payment succeeds
 *   (sendProactiveConfirmation → owner_notif_whatsapp).
 * - Orders where the owner must act keep the alert at creation:
 *   bank transfer, zero-total orders, and routes that are still ambiguous
 *   (online + bank transfer offered together, payment setup failed).
 *
 * Executes the real ordering `process_order` step and the real
 * `sendProactiveConfirmation`; only I/O boundaries are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Boundary mocks ──

const mockGetSavedMethods = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/payments/saved-payment-adapter', () => ({
  savedPaymentAdapter: {
    getSavedMethods: (...a: unknown[]) => mockGetSavedMethods(...a),
    chargeSavedMethod: vi.fn(),
    requiresPin: vi.fn(),
    verifyPin: vi.fn(),
  },
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/constants');
  return { ...actual, formatCurrency: (a: number) => `₦${a}`, getCurrencyCode: () => 'NGN' };
});
vi.mock('@/lib/categoryConfig', () => ({
  getCategoryLabels: () => ({ confirmationEmoji: '🏢', receiptTitle: 'Order', actionVerb: 'Payment', quantityLabel: 'item(s)' }),
}));

vi.mock('@/lib/bot/flows/shared/user', () => ({
  createWhatsAppUser: vi.fn().mockResolvedValue('user-1'),
  findUserByPhone: vi.fn().mockResolvedValue({ first_name: 'John', last_name: 'Doe' }),
  getCustomerName: vi.fn().mockResolvedValue('John Doe'),
}));

const mockInitializePayment = vi.fn();
vi.mock('@/lib/bot/flows/shared/payment', () => ({
  initializePayment: (...a: unknown[]) => mockInitializePayment(...a),
}));

const mockCheckBankTransferEligibility = vi.fn();
vi.mock('@/lib/bot/flows/shared/bank-transfer', () => ({
  checkBankTransferEligibility: (...a: unknown[]) => mockCheckBankTransferEligibility(...a),
  createPendingTransfer: vi.fn(),
  formatBankTransferBlock: vi.fn().mockReturnValue('Bank: Test Bank 0123456789'),
  BANK_ONLY_BUTTONS: [{ id: 'sent_transfer', title: "I've sent transfer" }],
}));

vi.mock('@/lib/bot/flows/shared/terms', () => ({
  getTermsPrompt: vi.fn().mockReturnValue([{ type: 'buttons', body: 'T&C', buttons: [{ id: 'accept_terms', title: 'Accept' }] }]),
}));
vi.mock('@/lib/bot/flows/shared/capability-guard', () => ({
  requireCurrentCapability: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/payments/reconcile', () => ({
  reconcilePayment: vi.fn().mockResolvedValue({ lifecycle: { status: 'completed' } }),
}));
vi.mock('@/lib/payments/bot-recovery', () => ({
  verifyAndReconcilePayment: vi.fn().mockResolvedValue({ outcome: 'not_paid' }),
}));
vi.mock('@/lib/bot/smart-intent', () => ({
  extractEntitiesOnly: vi.fn().mockReturnValue({}),
  parseSmartIntent: vi.fn(),
  parseSmartIntentHybrid: vi.fn(),
  matchServiceFromKeywords: vi.fn(),
  buildAcknowledgment: vi.fn(),
  matchProductsFromKeywords: vi.fn(),
}));

const mockNotifyOwnerNewOrder = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewOrder: (...a: unknown[]) => mockNotifyOwnerNewOrder(...a),
  notifyOwnerNewPayment: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewTicketSale: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewBooking: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewQuoteRequest: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewInvoicePayment: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewDonation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/flows/shared/templates', () => ({
  getOrderConfirmationMessage: vi.fn().mockReturnValue('Order Summary'),
  getReservationConfirmationMessage: vi.fn().mockReturnValue('Reservation Summary'),
  getTicketConfirmationMessage: vi.fn().mockReturnValue('Ticket Summary'),
  getConfirmationMessage: vi.fn().mockReturnValue('Confirmation'),
}));
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/receipt-ocr', () => ({ analyzeReceipt: vi.fn(), receiptMatchesExpected: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/ive-paid-input', () => ({
  parseIvePaidInput: vi.fn().mockReturnValue({ recognized: false }),
  isIvePaidInput: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/tier-limits', () => ({ checkTierLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/whitelabel', () => ({ getPoweredByFooter: () => '_Powered by Waaiio_', isWhiteLabel: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: vi.fn().mockReturnValue(null) }));

// Post-payment side (sendProactiveConfirmation) boundaries
vi.mock('@/lib/channels/channel-resolver', () => {
  const MockChannelResolver = class {
    resolveByChannelId = vi.fn().mockResolvedValue(null);
    resolveByBusinessId = vi.fn().mockResolvedValue({
      channel: { id: 'ch-dedicated', channel_type: 'dedicated' },
      sender: { sendText: vi.fn().mockResolvedValue(undefined), sendDocument: vi.fn().mockResolvedValue(undefined) },
    });
  };
  return { ChannelResolver: MockChannelResolver };
});
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/email/templates', () => ({
  paymentReceivedEmail: vi.fn().mockReturnValue({ subject: 't', html: '<p/>' }),
  bookingConfirmationEmail: vi.fn().mockReturnValue({ subject: 't', html: '<p/>' }),
  donationReceiptEmail: vi.fn().mockReturnValue({ subject: 't', html: '<p/>' }),
}));
vi.mock('@/lib/bot/flows/shared/send-tickets', () => ({
  sendTicketsAfterPurchase: vi.fn().mockResolvedValue({ success: true, tickets: [] }),
}));
vi.mock('@/lib/payments/saved-card-offer', () => ({
  checkAndOfferSavedCard: vi.fn().mockResolvedValue(undefined),
  retryPendingSavedCardOffer: vi.fn().mockResolvedValue(undefined),
}));

import type { FlowContext, FlowStepConfig } from '../types';

// ── Helpers ──

const ORDER_ID = 'ord-1';
const ORDER_REF = 'WA-OR-0001';
const BANK_ACCOUNT = { bank_name: 'Test Bank', account_number: '0123456789', account_name: 'TestBiz' };

/**
 * Ordering-side Supabase mock.
 * `created` controls create_order_atomic; `existing` models the re-entry read
 * of a pending order that cancel_stale_order_atomic keeps (instant_not_expired).
 */
function orderingSupabase(opts: { created?: boolean } = {}) {
  const makeChain = (table: string): Record<string, any> => {
    const c: Record<string, any> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not', 'neq', 'or', 'lt', 'gt', 'gte', 'lte', 'is', 'update', 'insert', 'upsert', 'delete']) {
      c[m] = vi.fn().mockReturnValue(c);
    }
    c.single = vi.fn().mockResolvedValue(
      table === 'orders'
        ? { data: { id: ORDER_ID, status: 'pending', reference_code: ORDER_REF }, error: null }
        : { data: null, error: null },
    );
    c.maybeSingle = vi.fn().mockResolvedValue(
      table === 'countries' ? { data: { currency_code: 'NGN' }, error: null } : { data: null, error: null },
    );
    return c;
  };
  return {
    from: vi.fn().mockImplementation((table: string) => makeChain(table)),
    rpc: vi.fn().mockImplementation((name: string) => {
      if (name === 'create_order_atomic') {
        return Promise.resolve({ data: { order_id: ORDER_ID, reference_code: ORDER_REF, created: opts.created ?? true, error: null }, error: null });
      }
      if (name === 'cancel_stale_order_atomic') {
        return Promise.resolve({ data: { cancelled: false, reason: 'instant_not_expired' }, error: null });
      }
      if (name === 'create_transfer_with_reservation') {
        return Promise.resolve({ data: { transfer_id: 'tr-1', reference_code: 'BT-0001' }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    }),
  } as any;
}

function flowCtx(supabase: any, sessionData: Record<string, unknown>): FlowContext {
  if (!sessionData._inbound_channel_id) sessionData._inbound_channel_id = 'channel-test';
  return {
    supabase,
    sender: { sendText: vi.fn().mockResolvedValue(undefined), sendButtons: vi.fn(), sendList: vi.fn(), sendImage: vi.fn(), sendDocument: vi.fn() },
    standalone: {} as any,
    intelligence: {} as any,
    from: '+2348012345678',
    session: { id: 's-1', user_id: 'user-1', business_id: 'biz-1', current_step: 'process_order', session_data: sessionData, version: 1 },
    business: { id: 'biz-1', name: 'TestBiz', slug: 'testbiz', category: 'other' as any, flow_type: 'ordering' as any, subscription_tier: 'free', trial_ends_at: '', metadata: {}, country_code: 'NG' as any, payment_gateway: 'paystack' },
    t: (t: string) => Promise.resolve(t),
  } as unknown as FlowContext;
}

function newOrderSession(price = 5000): Record<string, unknown> {
  return {
    active_capability: 'ordering', _terms_accepted: true,
    cart: [{ product_id: 'p1', name: 'Jollof Rice', quantity: 1, price }],
    first_name: 'Ada', last_name: 'Obi', delivery_type: 'pickup',
  };
}

/** Post-payment Supabase mock for sendProactiveConfirmation on an order payment. */
function paymentSupabase() {
  const chain = (): Record<string, any> => {
    const c: Record<string, any> = {};
    ['select', 'eq', 'neq', 'not', 'is', 'in', 'or', 'order', 'limit', 'update', 'insert', 'delete'].forEach(m => (c[m] = vi.fn().mockReturnValue(c)));
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  };
  return {
    rpc: vi.fn().mockImplementation((name: string) => {
      if (name === 'claim_payment_confirmation') {
        return Promise.resolve({
          data: { claimed: true, claim_token: 'tok-1', payment_id: 'p1', amount: 5000, booking_id: null, reservation_id: null, invoice_id: null, campaign_id: null, order_id: ORDER_ID },
          error: null,
        });
      }
      if (name === 'renew_payment_confirmation_claim') return Promise.resolve({ data: { renewed: true }, error: null });
      if (name === 'finalize_payment_confirmation') return Promise.resolve({ data: { finalized: true }, error: null });
      if (name === 'release_payment_confirmation') return Promise.resolve({ data: { released: true }, error: null });
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn().mockImplementation((table: string) => {
      const c = chain();
      if (table === 'payments') {
        c.single = vi.fn().mockResolvedValue({ data: { user_id: null, gateway: 'paystack', metadata: { order_id: ORDER_ID } }, error: null });
      }
      if (table === 'orders') {
        const orderData = {
          delivery_phone: '+2348012345678', delivery_name: 'Ada Obi', delivery_address: null,
          reference_code: ORDER_REF, business_id: 'biz-1', order_items: [],
          businesses: { name: 'TestBiz', country_code: 'NG' },
        };
        c.single = vi.fn().mockResolvedValue({ data: orderData, error: null });
        c.maybeSingle = vi.fn().mockResolvedValue({ data: orderData, error: null });
      }
      if (table === 'businesses') {
        c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: 'free', owner_id: null }, error: null });
      }
      return c;
    }),
  };
}

// Route set-ups. Each mirrors what the real helpers return for that route.
function onlineOnly() {
  mockInitializePayment.mockResolvedValue({ url: 'https://pay.test/xyz', reference: 'PAY-REF-1' });
  mockCheckBankTransferEligibility.mockResolvedValue({ qualifies: false, bankAccount: null, platformSettings: {} });
}
function onlinePlusBank() {
  mockInitializePayment.mockResolvedValue({ url: 'https://pay.test/xyz', reference: 'PAY-REF-1' });
  mockCheckBankTransferEligibility.mockResolvedValue({ qualifies: true, bankAccount: BANK_ACCOUNT, platformSettings: { transfer_expiry_hours: 24 } });
}
function bankOnly() {
  mockInitializePayment.mockResolvedValue(null); // gateway could not start online payment
  mockCheckBankTransferEligibility.mockResolvedValue({ qualifies: true, bankAccount: BANK_ACCOUNT, platformSettings: { transfer_expiry_hours: 24 } });
}
function noRoute() {
  mockInitializePayment.mockResolvedValue(null);
  mockCheckBankTransferEligibility.mockResolvedValue({ qualifies: false, bankAccount: null, platformSettings: {} });
}
function savedCardOnFile() {
  mockGetSavedMethods.mockResolvedValue([{ id: 'spm-1', displayLabel: 'Visa •••• 4242', last4: '4242' }]);
}

describe('Owner new-order alert — online orders alert only after payment (Owner option A, 2026-11-04)', () => {
  let step: FlowStepConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSavedMethods.mockResolvedValue([]);
    const { orderingFlow } = await import('../ordering.flow');
    step = orderingFlow.steps.find(s => s.id === 'process_order')!;
  });

  // ── Online routes: no creation alert ──

  it('online payment link: NO alert at creation, then exactly ONE alert after payment succeeds', async () => {
    onlineOnly();
    const sd = newOrderSession();
    const msgs = await step.prompt(flowCtx(orderingSupabase(), sd));

    // Customer got the online payment link
    expect(JSON.stringify(msgs)).toContain('https://pay.test/xyz');
    expect(mockNotifyOwnerNewOrder).not.toHaveBeenCalled();

    // Payment succeeds → the existing post-payment confirmation sends the alert
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    const result = await sendProactiveConfirmation(
      paymentSupabase() as never,
      { id: 'p1', amount: 5000, booking_id: null, invoice_id: null, campaign_id: null, reservation_id: null, order_id: ORDER_ID },
    );
    expect(result.status).toBe('completed');
    expect(mockNotifyOwnerNewOrder).toHaveBeenCalledTimes(1);
    expect(mockNotifyOwnerNewOrder.mock.calls[0][0]).toMatchObject({ referenceCode: ORDER_REF, totalAmount: 5000 });
    expect(mockNotifyOwnerNewOrder.mock.calls[0][0].paymentPending).toBeFalsy();
  });

  it('saved card offered (staging WA-OR-8782 route): NO alert at creation', async () => {
    savedCardOnFile();
    onlineOnly();
    const sd = newOrderSession();
    const msgs = await step.prompt(flowCtx(orderingSupabase(), sd));

    expect(JSON.stringify(msgs)).toContain('pay_saved');
    expect(mockNotifyOwnerNewOrder).not.toHaveBeenCalled();
  });

  it('saved card skipped, then online link only: still NO creation alert', async () => {
    savedCardOnFile();
    onlineOnly();
    const sd = newOrderSession();
    await step.prompt(flowCtx(orderingSupabase(), sd));
    expect(mockNotifyOwnerNewOrder).not.toHaveBeenCalled();

    // Customer taps "Use different card" → step re-prompts with the same order
    sd._skip_saved_card = true;
    delete sd._saved_method_id;
    await step.prompt(flowCtx(orderingSupabase({ created: false }), sd));

    expect(mockNotifyOwnerNewOrder).not.toHaveBeenCalled();
  });

  // ── Routes where the owner must act: keep the creation alert ──

  it('bank transfer only: alert at creation, marked awaiting payment', async () => {
    bankOnly();
    const sd = newOrderSession();
    const msgs = await step.prompt(flowCtx(orderingSupabase(), sd));

    expect(JSON.stringify(msgs)).toContain('sent_transfer');
    expect(mockNotifyOwnerNewOrder).toHaveBeenCalledTimes(1);
    expect(mockNotifyOwnerNewOrder.mock.calls[0][0]).toMatchObject({ referenceCode: ORDER_REF, totalAmount: 5000, paymentPending: true });
  });

  it('zero-total order: alert at creation, not awaiting payment', async () => {
    onlineOnly();
    const sd = newOrderSession(0);
    await step.prompt(flowCtx(orderingSupabase(), sd));

    expect(mockInitializePayment).not.toHaveBeenCalled();
    expect(mockNotifyOwnerNewOrder).toHaveBeenCalledTimes(1);
    expect(mockNotifyOwnerNewOrder.mock.calls[0][0]).toMatchObject({ referenceCode: ORDER_REF, totalAmount: 0, paymentPending: false });
  });

  // ── Ambiguous routes: default to keeping the creation alert ──

  it('online + bank transfer offered together (customer chooses later): alert kept at creation', async () => {
    onlinePlusBank();
    const sd = newOrderSession();
    const msgs = await step.prompt(flowCtx(orderingSupabase(), sd));

    expect(JSON.stringify(msgs)).toContain('https://pay.test/xyz');
    expect(JSON.stringify(msgs)).toContain('sent_transfer');
    expect(mockNotifyOwnerNewOrder).toHaveBeenCalledTimes(1);
    expect(mockNotifyOwnerNewOrder.mock.calls[0][0]).toMatchObject({ paymentPending: true });
  });

  it('payment setup failed (no online link, no bank transfer): alert kept at creation', async () => {
    noRoute();
    const sd = newOrderSession();
    await step.prompt(flowCtx(orderingSupabase(), sd));

    expect(mockNotifyOwnerNewOrder).toHaveBeenCalledTimes(1);
  });

  it('saved card skipped, then online + bank transfer offered: the owed creation alert is sent once', async () => {
    savedCardOnFile();
    onlinePlusBank();
    const sd = newOrderSession();
    await step.prompt(flowCtx(orderingSupabase(), sd));
    expect(mockNotifyOwnerNewOrder).not.toHaveBeenCalled();

    sd._skip_saved_card = true;
    delete sd._saved_method_id;
    await step.prompt(flowCtx(orderingSupabase({ created: false }), sd));
    expect(mockNotifyOwnerNewOrder).toHaveBeenCalledTimes(1);
    expect(mockNotifyOwnerNewOrder.mock.calls[0][0]).toMatchObject({ referenceCode: ORDER_REF, paymentPending: true });

    // "Get new link" re-prompts again — no second creation alert
    await step.prompt(flowCtx(orderingSupabase({ created: false }), sd));
    expect(mockNotifyOwnerNewOrder).toHaveBeenCalledTimes(1);
  });

  // ── Re-entry without a fresh creation never alerts ──

  it('re-entry on an order this session did not create: no alert on any route', async () => {
    bankOnly();
    const sd = { ...newOrderSession(), order_id: ORDER_ID, reference_code: ORDER_REF };
    await step.prompt(flowCtx(orderingSupabase({ created: false }), sd));

    expect(mockNotifyOwnerNewOrder).not.toHaveBeenCalled();
  });
});
