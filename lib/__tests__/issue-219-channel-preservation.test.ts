/**
 * Issue #219 — Channel Preservation Tests
 *
 * Verifies that the inbound WhatsApp channel identity is captured, persisted
 * through payment flows, and used correctly during post-payment confirmation
 * delivery. Prevents cross-country channel fallback for WhatsApp-originated payments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Source code for structural assertions ──
const botServiceCode = readFileSync(resolve(__dirname, '../bot/bot.service.ts'), 'utf-8');
const sharedPaymentCode = readFileSync(resolve(__dirname, '../bot/flows/shared/payment.ts'), 'utf-8');
const sendConfirmationCode = readFileSync(resolve(__dirname, '../payments/send-confirmation.ts'), 'utf-8');

// ── Hoisted mocks ──
const { mockResolveByChannelId, mockResolveByBusinessId } = vi.hoisted(() => ({
  mockResolveByChannelId: vi.fn(),
  mockResolveByBusinessId: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `$${a}` }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace(/^\+/, '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('U') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: vi.fn().mockReturnValue(null) }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    resolveByChannelId = mockResolveByChannelId;
    resolveByBusinessId = mockResolveByBusinessId;
  },
}));

// ── Supabase mock helpers ──
function chain() {
  const c: Record<string, any> = {};
  ['select', 'eq', 'is', 'in', 'or', 'not', 'order', 'limit', 'update', 'insert', 'delete', 'neq'].forEach(
    (m) => (c[m] = vi.fn().mockReturnValue(c)),
  );
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  return c;
}

// ── Helpers for extracting code sections ──
function extractBlockA(): string {
  const marker = '#219 Block A: ALWAYS resolve inbound channel identity';
  const idx = botServiceCode.indexOf(marker);
  // Grab enough to cover the full Block A (through Block B marker)
  const blockBMarker = '#219 Block B:';
  const endIdx = botServiceCode.indexOf(blockBMarker, idx);
  return botServiceCode.slice(idx, endIdx > idx ? endIdx : idx + 3000);
}

// ── Test 1-5: Block A channel resolution logic (structural) ──

describe('#219 Block A: Inbound channel resolution', () => {
  it('1. Restart path + shared channel — channel lookup runs even when businessId is set', () => {
    // Block A runs when destinationPhone is present, regardless of businessId.
    // The code does `if (destinationPhone)` — NOT `if (destinationPhone && !businessId)`.
    // This ensures restartBusinessId (NG business) + US shared channel still captures inboundChannelId.
    const blockA = extractBlockA();

    // The guard condition must be `if (destinationPhone)` only
    expect(blockA).toContain('if (destinationPhone)');
    expect(blockA).not.toContain('if (destinationPhone && !businessId)');
  });

  it('2. Returning customer + shared channel — channel identity captured independently of business routing', () => {
    // The returning_customer path sets businessId AFTER Block A runs.
    // Block A lookup: `if (destinationPhone)` — runs first.
    // Returning customer lookup: `if (!businessId)` — runs after Block A.
    // Both paths result in inboundChannelId being set.

    const blockAIdx = botServiceCode.indexOf('#219 Block A:');
    const returningIdx = botServiceCode.indexOf('findReturningCustomerBusiness(from', blockAIdx);
    expect(blockAIdx).toBeGreaterThan(-1);
    expect(returningIdx).toBeGreaterThan(blockAIdx);

    // Verify inboundChannelId is set inside Block A, before returning customer resolution
    const channelAssign = botServiceCode.indexOf('inboundChannelId = inboundChannel.id', blockAIdx);
    expect(channelAssign).toBeGreaterThan(blockAIdx);
    expect(channelAssign).toBeLessThan(returningIdx);
  });

  it('3. Dedicated channel + matching business — _inbound_channel_id set correctly', () => {
    // When inbound on a dedicated channel where channel.business_id matches businessId,
    // inboundChannelId is set (no conflict path entered).
    const blockA = extractBlockA();

    // inboundChannelId is assigned unconditionally inside the `if (inboundChannel)` block
    expect(blockA).toContain('inboundChannelId = inboundChannel.id');

    // The dedicated channel conflict check only fires when businessId !== channel.business_id
    expect(blockA).toContain('businessId !== inboundChannel.business_id');
  });

  it('4. Dedicated channel + mismatched business (restart) — dedicated channel wins', () => {
    // When restartBusinessId = 'A' but dedicated channel.business_id = 'B',
    // the code discards the stale restart and routes to the dedicated channel's business.
    const blockA = extractBlockA();

    // Verify the "dedicated channel wins" path exists and reassigns businessId
    expect(blockA).toContain('Restart/dedicated channel conflict');
    expect(blockA).toContain('businessId = inboundChannel.business_id');
    expect(blockA).toContain("bizResolution = 'dedicated_number'");
  });

  it('5. Pre-resolved conflict terminates — preResolved vs dedicated mismatch returns early', () => {
    // preResolvedBusinessId = 'A', channel.business_id = 'B' → integrity error → return early
    const blockA = extractBlockA();

    // The pre_resolved conflict path logs an error and returns (terminates)
    expect(blockA).toContain("bizResolution === 'pre_resolved'");
    expect(blockA).toContain('INTEGRITY: preResolved/dedicated channel business conflict');
    expect(blockA).toContain('return;');
  });
});

// ── Test 6-7: initializePayment persists channel context ──

describe('#219 initializePayment channel propagation', () => {
  it('6. New payment — _inbound_channel_id and _confirmation_origin persisted in payment metadata', () => {
    // After creating a new payment record, initializePayment updates metadata with channel context

    // Verify opts accepts inboundChannelId and confirmationOrigin
    expect(sharedPaymentCode).toContain('inboundChannelId?: string');
    expect(sharedPaymentCode).toContain("confirmationOrigin?: 'whatsapp' | 'web'");

    // Verify new payment path persists both fields
    expect(sharedPaymentCode).toContain(
      '#219: Persist inbound channel + confirmation origin for post-payment delivery',
    );
    expect(sharedPaymentCode).toContain('existingMeta._inbound_channel_id = opts.inboundChannelId');
    expect(sharedPaymentCode).toContain('existingMeta._confirmation_origin = opts.confirmationOrigin');
  });

  it('7. Pending payment reuse — _inbound_channel_id and _confirmation_origin updated on reuse', () => {
    // When an existing pending payment is reused, the channel context is updated
    // because the customer may be retrying from a different channel

    expect(sharedPaymentCode).toContain('#219: Update channel context on reuse');
    expect(sharedPaymentCode).toContain('reuseMeta._inbound_channel_id = opts.inboundChannelId');
    expect(sharedPaymentCode).toContain('reuseMeta._confirmation_origin = opts.confirmationOrigin');

    // Verify the update is written to the DB
    expect(sharedPaymentCode).toContain("from('payments').update({ metadata: reuseMeta })");
  });
});

// ── Test 8-10: sendProactiveConfirmation channel resolution ──

describe('#219 sendProactiveConfirmation channel resolution', () => {
  const mockRpc = vi.fn();
  const mockFrom = vi.fn();

  const CLAIM_OK = {
    data: {
      claimed: true,
      claim_token: 'tok-ch',
      payment_id: 'p-ch',
      amount: 100,
      booking_id: 'bk-ch',
      invoice_id: null,
      campaign_id: null,
      reservation_id: null,
      order_id: null,
    },
  };
  const RENEW_OK = { data: { renewed: true } };
  const FIN_OK = { data: { finalized: true, already_finalized: false } };

  function buildMock(
    rpcMap: Record<string, { data?: unknown; error?: unknown }> = {},
    fromOverrides: Record<string, (c: ReturnType<typeof chain>) => void> = {},
  ) {
    mockRpc.mockImplementation((name: string) => {
      const r = rpcMap[name];
      return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null });
    });

    mockFrom.mockImplementation((table: string) => {
      const c = chain();
      if (fromOverrides[table]) {
        fromOverrides[table](c);
        return c;
      }
      if (table === 'bookings') {
        c.single = vi.fn().mockResolvedValue({
          data: {
            guest_phone: '+234123',
            business_id: 'b1',
            reference_code: 'X1',
            date: '2026-08-10',
            time: '14:00',
            flow_type: 'scheduling',
            total_amount: 100,
            deposit_amount: 100,
            businesses: { name: 'Biz', country_code: 'NG' },
            services: { name: 'S', duration_minutes: 30 },
          },
          error: null,
        });
      }
      if (table === 'businesses') {
        c.single = vi.fn().mockResolvedValue({
          data: { subscription_tier: 'free', owner_id: 'o1' },
          error: null,
        });
      }
      if (table === 'profiles') {
        c.single = vi.fn().mockResolvedValue({
          data: { email: 'o@test.com', phone: '+234' },
          error: null,
        });
      }
      if (table === 'payments') {
        c.single = vi.fn().mockResolvedValue({
          data: { metadata: {} },
          error: null,
        });
      }
      if (table === 'bot_sessions') {
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      }
      return c;
    });

    return { rpc: mockRpc, from: mockFrom } as any;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockResolveByChannelId.mockResolvedValue(null);
    mockResolveByBusinessId.mockResolvedValue(null);
  });

  it('8. _inbound_channel_id in payment metadata — resolveByChannelId called with that ID', async () => {
    const channelId = 'ch-us-shared-123';
    const mockSender = { sendText: vi.fn().mockResolvedValue(true) };
    mockResolveByChannelId.mockResolvedValue({
      channel: { id: channelId, phone_number_id: 'pn1' },
      sender: mockSender,
    });

    const s = buildMock(
      {
        claim_payment_confirmation: CLAIM_OK,
        renew_payment_confirmation_claim: RENEW_OK,
        finalize_payment_confirmation: FIN_OK,
      },
      {
        payments: (c) => {
          c.single = vi.fn().mockResolvedValue({
            data: { metadata: { _inbound_channel_id: channelId, _confirmation_origin: 'whatsapp' } },
            error: null,
          });
        },
      },
    );

    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, {
      id: 'p-ch',
      amount: 100,
      booking_id: 'bk-ch',
      invoice_id: null,
      campaign_id: null,
    });

    // resolveByChannelId should be called with the persisted channel ID
    expect(mockResolveByChannelId).toHaveBeenCalledWith(channelId);
    // resolveByBusinessId should NOT be called (origin channel resolved successfully)
    expect(mockResolveByBusinessId).not.toHaveBeenCalled();
  });

  it('9. Missing-channel fail-safe — whatsapp origin + no channel = skip customer send', async () => {
    // _confirmation_origin: 'whatsapp' + missing _inbound_channel_id
    // → customer WhatsApp send skipped, resolveByBusinessId NOT called

    const s = buildMock(
      {
        claim_payment_confirmation: CLAIM_OK,
        renew_payment_confirmation_claim: RENEW_OK,
        finalize_payment_confirmation: FIN_OK,
      },
      {
        payments: (c) => {
          c.single = vi.fn().mockResolvedValue({
            data: { metadata: { _confirmation_origin: 'whatsapp' } },
            error: null,
          });
        },
      },
    );

    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, {
      id: 'p-ch',
      amount: 100,
      booking_id: 'bk-ch',
      invoice_id: null,
      campaign_id: null,
    });

    // WhatsApp origin + no channel → resolveByBusinessId must NOT be called (fail-safe)
    expect(mockResolveByBusinessId).not.toHaveBeenCalled();

    // Verify this behavior is codified in the source
    expect(sendConfirmationCode).toContain(
      'no origin channel for WhatsApp-originated payment',
    );
  });

  it('e. WhatsApp origin does NOT borrow session channel — source structural test', () => {
    // #219: The session fallback lookup must ONLY run when confirmationOrigin !== 'whatsapp'.
    // This prevents WhatsApp-originated payments from borrowing a later/different session channel.
    // Verify the guard condition in source: `if (!inboundChId && confirmationOrigin !== 'whatsapp')`
    expect(sendConfirmationCode).toContain("!inboundChId && confirmationOrigin !== 'whatsapp'");

    // Verify the inverse: when confirmationOrigin === 'whatsapp' and no channel, it sets
    // a flag to skip customer send, rather than falling back to session channel.
    expect(sendConfirmationCode).toContain("confirmationOrigin === 'whatsapp'");
    expect(sendConfirmationCode).toContain('no origin channel for WhatsApp-originated payment');
  });

  it('f. Pending-payment reuse metadata write error → fail-closed (returns null) for WhatsApp origin', async () => {
    // When confirmationOrigin is 'whatsapp' and the metadata update fails,
    // initializePayment must return null (fail-closed) to prevent a payment
    // from losing its channel context.

    // We verify this by reading the source structure of shared/payment.ts
    // The code block: if (reuseUpdateErr && opts.confirmationOrigin === 'whatsapp') { ... return null; }
    expect(sharedPaymentCode).toContain("reuseUpdateErr && opts.confirmationOrigin === 'whatsapp'");
    expect(sharedPaymentCode).toContain('WhatsApp channel persistence failed on checkout reuse');

    // The return null is in the same block — verify the fail-closed behavior
    // by checking that the error path returns null (not the checkout URL)
    const failClosedIdx = sharedPaymentCode.indexOf("WhatsApp channel persistence failed on checkout reuse");
    const returnNullIdx = sharedPaymentCode.indexOf('return null;', failClosedIdx);
    // return null must appear within a few lines of the error log
    expect(returnNullIdx).toBeGreaterThan(failClosedIdx);
    expect(returnNullIdx - failClosedIdx).toBeLessThan(200);
  });

  it('10. Legacy/web fallback — no _confirmation_origin → resolveByBusinessId called', async () => {
    // No _confirmation_origin or 'web' origin → use resolveByBusinessId as fallback
    const mockSender = { sendText: vi.fn().mockResolvedValue(true) };
    mockResolveByBusinessId.mockResolvedValue({
      channel: { id: 'ch-fallback', phone_number_id: 'pn-fb' },
      sender: mockSender,
    });

    const s = buildMock(
      {
        claim_payment_confirmation: CLAIM_OK,
        renew_payment_confirmation_claim: RENEW_OK,
        finalize_payment_confirmation: FIN_OK,
      },
      {
        payments: (c) => {
          // No _inbound_channel_id, no _confirmation_origin → legacy path
          c.single = vi.fn().mockResolvedValue({
            data: { metadata: {} },
            error: null,
          });
        },
      },
    );

    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, {
      id: 'p-ch',
      amount: 100,
      booking_id: 'bk-ch',
      invoice_id: null,
      campaign_id: null,
    });

    // No confirmation origin → legacy fallback → resolveByBusinessId IS called
    expect(mockResolveByBusinessId).toHaveBeenCalled();

    // Verify the source code fallback path
    expect(sendConfirmationCode).toContain(
      'Non-WhatsApp origin or legacy (no _confirmation_origin)',
    );
    expect(sendConfirmationCode).toContain('resolveByBusinessId(businessId)');
  });
});
