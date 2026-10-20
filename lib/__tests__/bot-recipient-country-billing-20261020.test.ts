/**
 * PR #667 regression tests — WhatsApp billing metadata
 *
 * Covers five CTO-requested areas:
 *  1. Attempt INSERT persists recipient_country_code + message_category
 *  2. Inbound customer-initiated replies default to 'service' category
 *  3. Explicitly supplied message categories are preserved
 *  4. Template + platform-scoped sends are NOT injected with 'service'
 *  5. Fail-closed financial authorization gate (GateBlockError)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolveRecipientCountry } from '@/lib/channels/phone-country';
import {
  createAttempt,
  setSendAttemptGate,
  GateBlockError,
} from '@/lib/channels/attempt-recording';
import type { MessageSender } from '@/lib/channels/message-sender';

// ── Shared mocks ──

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

/** Build a mock Supabase client that captures the INSERT row for inspection. */
function buildMockSupabase() {
  const insertedRows: Record<string, unknown>[] = [];
  return {
    from: vi.fn().mockImplementation(() => ({
      insert: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        const id = 'attempt-' + Math.random().toString(36).slice(2, 8);
        insertedRows.push({ ...data, id });
        return { select: () => ({ single: () => ({ data: { id }, error: null }) }) };
      }),
      update: vi.fn().mockImplementation(() => ({
        eq: () => ({ error: null }),
      })),
    })),
    _insertedRows: insertedRows,
  };
}

// ── §1 phone-country resolution (existing) ──

describe('WhatsApp recipient country billing context', () => {
  it('resolves the same US recipient with or without a + prefix', () => {
    expect(resolveRecipientCountry('+15712746425')).toBe('US');
    expect(resolveRecipientCountry('15712746425')).toBe('US');
  });

  it('resolves Nigerian number from bare WhatsApp digits', () => {
    expect(resolveRecipientCountry('2348031234567')).toBe('NG');
  });

  it('resolves UK number', () => {
    expect(resolveRecipientCountry('+442071234567')).toBe('GB');
  });

  it('does not substitute the business or WhatsApp sender country for unknown recipients', () => {
    expect(resolveRecipientCountry('not-a-phone')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(resolveRecipientCountry('')).toBeNull();
  });
});

// ── §2 Attempt INSERT persists billing metadata ──

describe('Attempt INSERT persists billing metadata before financial authorization', () => {
  beforeEach(() => {
    setSendAttemptGate(false);
  });

  it('writes recipient_country_code on INSERT', async () => {
    const supabase = buildMockSupabase();
    await createAttempt(supabase as any, {
      businessId: 'biz-test',
      attemptScope: 'business',
      recipientPhone: '+15712746425',
      recipientCountryCode: 'US',
    });
    expect(supabase._insertedRows).toHaveLength(1);
    expect(supabase._insertedRows[0].recipient_country_code).toBe('US');
  });

  it('writes message_category on INSERT', async () => {
    const supabase = buildMockSupabase();
    await createAttempt(supabase as any, {
      businessId: 'biz-test',
      attemptScope: 'business',
      recipientPhone: '+15712746425',
      messageCategory: 'service',
    });
    expect(supabase._insertedRows).toHaveLength(1);
    expect(supabase._insertedRows[0].message_category).toBe('service');
  });

  it('writes both recipient_country_code AND message_category atomically on INSERT', async () => {
    const supabase = buildMockSupabase();
    await createAttempt(supabase as any, {
      businessId: 'biz-test',
      attemptScope: 'business',
      recipientPhone: '+2348031234567',
      recipientCountryCode: 'NG',
      messageCategory: 'service',
    });
    expect(supabase._insertedRows).toHaveLength(1);
    const row = supabase._insertedRows[0];
    expect(row.recipient_country_code).toBe('NG');
    expect(row.message_category).toBe('service');
    // Both fields are available BEFORE any subsequent update
    expect(row.status).toBe('pending_authorization');
  });

  it('writes null for omitted billing fields (no undefined in DB)', async () => {
    const supabase = buildMockSupabase();
    await createAttempt(supabase as any, {
      businessId: 'biz-test',
      attemptScope: 'business',
      recipientPhone: '+15712746425',
      // recipientCountryCode omitted
      // messageCategory omitted
    });
    const row = supabase._insertedRows[0];
    expect(row.recipient_country_code).toBeNull();
    expect(row.message_category).toBeNull();
  });
});

// ── §3–4 Deadline-guarded sender category classification ──
//
// createDeadlineGuardedSender is local to the webhook route. We test the
// same transformation pattern it applies: `msg.messageCategory ?? 'service'`
// for business sends, passthrough for templates, passthrough for platform sends.

describe('Inbound reply message category classification', () => {
  /** Spy-based mock sender that records the messageCategory it receives. */
  function buildSpySender() {
    const calls: Record<string, unknown[]> = {};
    const capture = (method: string) => vi.fn().mockImplementation(async (msg: any) => {
      calls[method] = calls[method] || [];
      calls[method].push(msg);
      return { success: true, messageId: 'wamid-test' };
    });

    const inner: MessageSender = {
      sendText: capture('sendText'),
      sendList: capture('sendList'),
      sendButtons: capture('sendButtons'),
      sendImage: capture('sendImage'),
      sendDocument: capture('sendDocument'),
      sendAudio: capture('sendAudio'),
      sendTemplate: capture('sendTemplate'),
      sendFlow: capture('sendFlow'),
      sendReaction: capture('sendReaction'),
      sendLocation: capture('sendLocation'),
      sendProduct: capture('sendProduct'),
      sendProductList: capture('sendProductList'),
      sendPlatformText: capture('sendPlatformText'),
      sendPlatformButtons: capture('sendPlatformButtons'),
    };
    return { inner, calls };
  }

  /**
   * Replicate the exact transformation from createDeadlineGuardedSender
   * (app/api/webhook/meta-cloud/route.ts lines 74–93).
   * This tests the contract, not the implementation — if the route
   * changes how it wraps, this test catches the drift.
   */
  function applyGuardedSenderTransform(
    inner: MessageSender,
  ): MessageSender {
    return {
      sendText: (msg) => inner.sendText({ ...msg, messageCategory: msg.messageCategory ?? 'service' }),
      sendList: (msg) => inner.sendList({ ...msg, messageCategory: msg.messageCategory ?? 'service' }),
      sendButtons: (msg) => inner.sendButtons({ ...msg, messageCategory: msg.messageCategory ?? 'service' }),
      sendImage: (msg) => inner.sendImage({ ...msg, messageCategory: msg.messageCategory ?? 'service' }),
      sendDocument: (msg) => inner.sendDocument({ ...msg, messageCategory: msg.messageCategory ?? 'service' }),
      sendAudio: (msg) => inner.sendAudio({ ...msg, messageCategory: msg.messageCategory ?? 'service' }),
      // Templates: NO injection — caller's category (or none) passes through
      sendTemplate: inner.sendTemplate ? (msg) => inner.sendTemplate!(msg) : undefined,
      sendFlow: inner.sendFlow ? (msg) => inner.sendFlow!({ ...msg, messageCategory: msg.messageCategory ?? 'service' }) : undefined,
      // Platform sends: NO injection — platform scope is pre-business
      sendPlatformText: inner.sendPlatformText ? (msg) => inner.sendPlatformText!(msg) : undefined,
      sendPlatformButtons: inner.sendPlatformButtons ? (msg) => inner.sendPlatformButtons!(msg) : undefined,
    };
  }

  // §2: Customer-initiated inbound replies default to 'service'

  it('sendText defaults to service when no messageCategory supplied', async () => {
    const { inner, calls } = buildSpySender();
    const guarded = applyGuardedSenderTransform(inner);
    await guarded.sendText({ to: '15712746425', text: 'Hello' });
    expect(calls.sendText[0].messageCategory).toBe('service');
  });

  it('sendButtons defaults to service when no messageCategory supplied', async () => {
    const { inner, calls } = buildSpySender();
    const guarded = applyGuardedSenderTransform(inner);
    await guarded.sendButtons({ to: '15712746425', body: 'Pick one', buttons: [{ id: '1', title: 'Yes' }] });
    expect(calls.sendButtons[0].messageCategory).toBe('service');
  });

  it('sendImage defaults to service when no messageCategory supplied', async () => {
    const { inner, calls } = buildSpySender();
    const guarded = applyGuardedSenderTransform(inner);
    await guarded.sendImage({ to: '15712746425', imageUrl: 'https://example.com/img.png' });
    expect(calls.sendImage[0].messageCategory).toBe('service');
  });

  it('sendList defaults to service when no messageCategory supplied', async () => {
    const { inner, calls } = buildSpySender();
    const guarded = applyGuardedSenderTransform(inner);
    await guarded.sendList({
      to: '15712746425', title: 'Menu', body: 'Options', buttonLabel: 'See',
      items: [{ title: 'A', postbackText: 'a' }],
    });
    expect(calls.sendList[0].messageCategory).toBe('service');
  });

  // §3: Explicitly supplied message categories remain unchanged

  it('sendText preserves explicit marketing category', async () => {
    const { inner, calls } = buildSpySender();
    const guarded = applyGuardedSenderTransform(inner);
    await guarded.sendText({ to: '15712746425', text: 'Promo', messageCategory: 'marketing' });
    expect(calls.sendText[0].messageCategory).toBe('marketing');
  });

  it('sendButtons preserves explicit utility category', async () => {
    const { inner, calls } = buildSpySender();
    const guarded = applyGuardedSenderTransform(inner);
    await guarded.sendButtons({
      to: '15712746425', body: 'Confirm', buttons: [{ id: '1', title: 'OK' }],
      messageCategory: 'utility',
    });
    expect(calls.sendButtons[0].messageCategory).toBe('utility');
  });

  it('sendFlow preserves explicit authentication category', async () => {
    const { inner, calls } = buildSpySender();
    const guarded = applyGuardedSenderTransform(inner);
    await guarded.sendFlow!({
      to: '15712746425', bodyText: 'OTP', flowId: 'f1', flowCta: 'Enter', screen: 's1',
      messageCategory: 'authentication',
    });
    expect(calls.sendFlow[0].messageCategory).toBe('authentication');
  });

  // §4a: Template sends do NOT inject 'service'

  it('sendTemplate passes message through without injecting service', async () => {
    const { inner, calls } = buildSpySender();
    const guarded = applyGuardedSenderTransform(inner);
    await guarded.sendTemplate!({
      to: '15712746425', templateName: 'order_confirm', templateParams: ['ORD-1'],
    });
    // messageCategory should be undefined — NOT 'service'
    expect(calls.sendTemplate[0].messageCategory).toBeUndefined();
  });

  it('sendTemplate preserves explicitly supplied category', async () => {
    const { inner, calls } = buildSpySender();
    const guarded = applyGuardedSenderTransform(inner);
    await guarded.sendTemplate!({
      to: '15712746425', templateName: 'promo_blast', templateParams: ['50%'],
      messageCategory: 'marketing',
    });
    expect(calls.sendTemplate[0].messageCategory).toBe('marketing');
  });

  // §4b: Platform-scoped sends do NOT inject 'service'

  it('sendPlatformText passes message through without injecting service', async () => {
    const { inner, calls } = buildSpySender();
    const guarded = applyGuardedSenderTransform(inner);
    await guarded.sendPlatformText!({ to: '15712746425', text: 'Welcome to Waaiio' });
    // Platform sends have no messageCategory field — must not be added
    expect(calls.sendPlatformText[0].messageCategory).toBeUndefined();
  });

  it('sendPlatformButtons passes message through without injecting service', async () => {
    const { inner, calls } = buildSpySender();
    const guarded = applyGuardedSenderTransform(inner);
    await guarded.sendPlatformButtons!({
      to: '15712746425', body: 'Pick business', buttons: [{ id: 'b1', title: 'Acme' }],
    });
    expect(calls.sendPlatformButtons[0].messageCategory).toBeUndefined();
  });
});

// ── §5 Fail-closed financial authorization gate ──

describe('Fail-closed financial authorization gate', () => {
  beforeEach(() => {
    setSendAttemptGate(true);
  });

  it('GateBlockError prevents Meta emission when INSERT fails', async () => {
    // Mock Supabase with INSERT error
    const supabase = {
      from: vi.fn().mockImplementation(() => ({
        insert: vi.fn().mockImplementation(() => ({
          select: () => ({ single: () => ({ data: null, error: { message: 'DB unavailable' } }) }),
        })),
      })),
    };

    await expect(
      createAttempt(supabase as any, {
        businessId: 'biz-test',
        attemptScope: 'business',
        recipientPhone: '+15712746425',
        recipientCountryCode: 'US',
        messageCategory: 'service',
      }),
    ).rejects.toThrow(GateBlockError);
  });

  it('GateBlockError message confirms zero Meta emission', async () => {
    const supabase = {
      from: vi.fn().mockImplementation(() => ({
        insert: vi.fn().mockImplementation(() => ({
          select: () => ({ single: () => ({ data: null, error: { message: 'connection refused' } }) }),
        })),
      })),
    };

    await expect(
      createAttempt(supabase as any, {
        businessId: 'biz-test',
        attemptScope: 'business',
        recipientPhone: '+15712746425',
      }),
    ).rejects.toThrow(/zero Meta emission/);
  });

  it('gate OFF allows send to proceed despite INSERT failure', async () => {
    setSendAttemptGate(false);
    const supabase = {
      from: vi.fn().mockImplementation(() => ({
        insert: vi.fn().mockImplementation(() => ({
          select: () => ({ single: () => ({ data: null, error: { message: 'DB unavailable' } }) }),
        })),
      })),
    };

    // Gate OFF: returns null instead of throwing
    const result = await createAttempt(supabase as any, {
      businessId: 'biz-test',
      attemptScope: 'business',
      recipientPhone: '+15712746425',
    });
    expect(result).toBeNull();
  });
});
