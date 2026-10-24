/**
 * Circuit Breaker — Financial Denial Exclusion Tests (Lane 3)
 *
 * Proves that financial authorization denials (insufficient_allowance_balance,
 * etc.) do NOT trigger recordFailure on the Meta Cloud circuit breaker.
 * These are business-logic errors, not Meta API failures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must mock circuit-breaker before importing message-sender
const mockRecordFailure = vi.fn();
const mockRecordSuccess = vi.fn();
const mockIsCircuitOpen = vi.fn().mockReturnValue(false);

vi.mock('@/lib/circuit-breaker', () => ({
  isCircuitOpen: (...args: unknown[]) => mockIsCircuitOpen(...args),
  recordSuccess: (...args: unknown[]) => mockRecordSuccess(...args),
  recordFailure: (...args: unknown[]) => mockRecordFailure(...args),
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {
    constructor(service: string) {
      super(`Circuit breaker open for "${service}"`);
      this.name = 'CircuitBreakerOpenError';
    }
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/channels/attempt-recording', () => ({
  createAttempt: vi.fn().mockResolvedValue('attempt-123'),
  updateAttemptContext: vi.fn().mockResolvedValue(undefined),
  markSending: vi.fn().mockResolvedValue(undefined),
  markAccepted: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
  markAmbiguous: vi.fn().mockResolvedValue(undefined),
  settleAttempt: vi.fn().mockResolvedValue(true),
  setSendAttemptGate: vi.fn(),
  isAmbiguousTransportError: vi.fn().mockReturnValue(false),
  GateBlockError: class GateBlockError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'GateBlockError';
    }
  },
  AmbiguousSendError: class AmbiguousSendError extends Error {
    constructor(msg: string, public attemptId?: string) {
      super(msg);
      this.name = 'AmbiguousSendError';
    }
  },
  WamidPersistenceError: class WamidPersistenceError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'WamidPersistenceError';
    }
  },
}));

vi.mock('@/lib/channels/phone-country', () => ({
  resolveRecipientCountry: vi.fn().mockReturnValue('US'),
}));

vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockResolvedValue(undefined),
}));

describe('Circuit breaker must NOT count financial authorization denials', () => {
  beforeEach(() => {
    mockRecordFailure.mockClear();
    mockRecordSuccess.mockClear();
    mockIsCircuitOpen.mockReturnValue(false);
  });

  it('financial authorization denial does not trigger recordFailure', async () => {
    // Import fresh to pick up mocks
    const { createServiceClient } = await import('@/lib/supabase/service');
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: { authorized: false, reason: 'insufficient_allowance_balance' },
        error: null,
      }),
    });

    const { MetaCloudSender } = await import('@/lib/channels/message-sender');

    const mockCloud = {
      sendText: vi.fn().mockResolvedValue({ messageId: 'wamid-test' }),
    } as any;

    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: () => ({ single: () => ({ data: { id: 'attempt-123' }, error: null }) }),
        }),
        update: vi.fn().mockReturnValue({
          eq: () => ({ error: null }),
        }),
      }),
    } as any;

    const sender = new MetaCloudSender(mockCloud, mockSupabase);
    sender.bindBusiness('biz-test');

    await expect(
      sender.sendText({ to: '+15712746425', text: 'hello' })
    ).rejects.toThrow(/Financial authorization denied/);

    // The critical assertion: recordFailure must NOT have been called
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('financial RPC error does not trigger recordFailure', async () => {
    const { createServiceClient } = await import('@/lib/supabase/service');
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'connection timeout' },
      }),
    });

    const { MetaCloudSender } = await import('@/lib/channels/message-sender');

    const mockCloud = {
      sendText: vi.fn().mockResolvedValue({ messageId: 'wamid-test' }),
    } as any;

    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: () => ({ single: () => ({ data: { id: 'attempt-123' }, error: null }) }),
        }),
        update: vi.fn().mockReturnValue({
          eq: () => ({ error: null }),
        }),
      }),
    } as any;

    const sender = new MetaCloudSender(mockCloud, mockSupabase);
    sender.bindBusiness('biz-test');

    await expect(
      sender.sendText({ to: '+15712746425', text: 'hello' })
    ).rejects.toThrow(/Financial authorization/);

    // Financial RPC errors must NOT trigger circuit breaker either
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('actual Meta 5xx error still triggers recordFailure', async () => {
    const { createServiceClient } = await import('@/lib/supabase/service');
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: { authorized: true },
        error: null,
      }),
    });

    const { MetaCloudSender } = await import('@/lib/channels/message-sender');

    const mockCloud = {
      sendText: vi.fn().mockRejectedValue(new Error('Cloud API error: 500 Internal Server Error')),
    } as any;

    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: () => ({ single: () => ({ data: { id: 'attempt-123' }, error: null }) }),
        }),
        update: vi.fn().mockReturnValue({
          eq: () => ({ error: null }),
        }),
      }),
    } as any;

    const sender = new MetaCloudSender(mockCloud, mockSupabase);
    sender.bindBusiness('biz-test');

    await expect(
      sender.sendText({ to: '+15712746425', text: 'hello' })
    ).rejects.toThrow(/500/);

    // Meta server errors SHOULD still trigger recordFailure
    expect(mockRecordFailure).toHaveBeenCalled();
  });
});
