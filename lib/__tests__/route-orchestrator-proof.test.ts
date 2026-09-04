/**
 * Route orchestrator executable proof (#257)
 *
 * Tests the ACTUAL production orchestration modules:
 * - lib/channels/otp-send-orchestrator.ts (auth/otp/send)
 * - lib/channels/payout-nudge-orchestrator.ts (payout-nudge)
 *
 * These are the real production modules consumed by the routes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ──

const { mockCreateAttempt, mockMarkSending, mockMarkAccepted, mockMarkFailed, mockMarkAmbiguous, MockGateBlockError, gateState } = vi.hoisted(() => {
  class _GBE extends Error {
    readonly isGateBlock = true as const;
    constructor(m: string) { super(m); this.name = 'GateBlockError'; }
  }
  return {
    mockCreateAttempt: vi.fn(),
    mockMarkSending: vi.fn(),
    mockMarkAccepted: vi.fn(),
    mockMarkFailed: vi.fn(),
    mockMarkAmbiguous: vi.fn(),
    MockGateBlockError: _GBE,
    gateState: { on: false },
  };
});

vi.mock('@/lib/channels/attempt-recording', () => ({
  createAttempt: (...args: unknown[]) => mockCreateAttempt(...args),
  markSending: (...args: unknown[]) => mockMarkSending(...args),
  markAccepted: (...args: unknown[]) => mockMarkAccepted(...args),
  markFailed: (...args: unknown[]) => mockMarkFailed(...args),
  markAmbiguous: (...args: unknown[]) => mockMarkAmbiguous(...args),
  isAmbiguousTransportError: (err: Error) => /abort|timeout|econnreset/i.test(err.message),
  isSendAttemptGateOn: () => gateState.on,
  GateBlockError: MockGateBlockError,
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Import the ACTUAL production orchestration modules
import { orchestrateOtpSend } from '@/lib/channels/otp-send-orchestrator';
import { executePayoutNudgeSend } from '@/lib/channels/payout-nudge-orchestrator';

describe('Auth OTP Send Orchestrator (actual production module)', () => {
  let primaryMetaCalls: number;
  let fallbackMetaCalls: number;

  beforeEach(() => {
    vi.clearAllMocks();
    gateState.on = false;
    primaryMetaCalls = 0;
    fallbackMetaCalls = 0;
    mockCreateAttempt.mockResolvedValue('attempt-1');
    mockMarkSending.mockResolvedValue(undefined);
    mockMarkAccepted.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockMarkAmbiguous.mockResolvedValue(undefined);
  });

  it('Gate ON primary createAttempt failure → zero primary Meta + zero fallback Meta', async () => {
    gateState.on = true;
    mockCreateAttempt.mockRejectedValue(new MockGateBlockError('Gate ON: create failed'));

    const result = await orchestrateOtpSend({
      supabase: {} as any,
      phone: '+1234',
      templateName: 'otp',
      languageCode: 'en',
      code: '123456',
      primarySend: async (sb) => {
        // Use the real withDirectRouteAttempt — GateBlockError will throw before provider call
        const { withDirectRouteAttempt } = await import('@/lib/channels/direct-route-attempt');
        return withDirectRouteAttempt(sb, {
          businessId: null, attemptScope: 'platform', recipientPhone: '+1234',
          flowType: 'test',
        }, async () => {
          primaryMetaCalls++;
          return new Response('ok', { status: 200 });
        });
      },
      fallbackSend: async () => {
        fallbackMetaCalls++;
        return { ok: true, wamid: 'w1' };
      },
    });

    expect(result.primaryGateBlocked).toBe(true);
    expect(result.sent).toBe(false);
    expect(primaryMetaCalls).toBe(0);
    expect(fallbackMetaCalls).toBe(0);
  });

  it('Gate ON primary markSending failure → zero primary Meta + zero fallback Meta', async () => {
    gateState.on = true;
    mockMarkSending.mockRejectedValue(new MockGateBlockError('Gate ON: sending failed'));

    const result = await orchestrateOtpSend({
      supabase: {} as any,
      phone: '+1234',
      templateName: 'otp',
      languageCode: 'en',
      code: '123456',
      primarySend: async (sb) => {
        const { withDirectRouteAttempt } = await import('@/lib/channels/direct-route-attempt');
        return withDirectRouteAttempt(sb, {
          businessId: null, attemptScope: 'platform', recipientPhone: '+1234',
          flowType: 'test',
        }, async () => {
          primaryMetaCalls++;
          return new Response('ok', { status: 200 });
        });
      },
      fallbackSend: async () => {
        fallbackMetaCalls++;
        return { ok: true };
      },
    });

    expect(result.primaryGateBlocked).toBe(true);
    expect(result.sent).toBe(false);
    expect(primaryMetaCalls).toBe(0);
    expect(fallbackMetaCalls).toBe(0);
  });

  it('Ambiguous primary emission → zero env fallback', async () => {
    const result = await orchestrateOtpSend({
      supabase: {} as any,
      phone: '+1234',
      templateName: 'otp',
      languageCode: 'en',
      code: '123456',
      primarySend: async () => {
        primaryMetaCalls++;
        // Simulate ambiguous result from withDirectRouteAttempt
        return { ok: false, ambiguous: true };
      },
      fallbackSend: async () => {
        fallbackMetaCalls++;
        return { ok: true };
      },
    });

    expect(result.primaryAmbiguous).toBe(true);
    expect(result.sent).toBe(false);
    expect(primaryMetaCalls).toBe(1);
    expect(fallbackMetaCalls).toBe(0);
  });

  it('Non-ambiguous primary failure → env fallback proceeds', async () => {
    const result = await orchestrateOtpSend({
      supabase: {} as any,
      phone: '+1234',
      templateName: 'otp',
      languageCode: 'en',
      code: '123456',
      primarySend: async () => {
        primaryMetaCalls++;
        throw new Error('Cloud API error: 500');
      },
      fallbackSend: async () => {
        fallbackMetaCalls++;
        return { ok: true, wamid: 'wamid.fb' };
      },
    });

    expect(result.sent).toBe(true);
    expect(result.deliveryPath).toBe('env_fallback');
    expect(primaryMetaCalls).toBe(1);
    expect(fallbackMetaCalls).toBe(1);
  });
});

describe('Payout-nudge Orchestrator (actual production module)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gateState.on = false;
    mockCreateAttempt.mockResolvedValue('attempt-pn-1');
    mockMarkSending.mockResolvedValue(undefined);
    mockMarkAccepted.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);

    // Mock global fetch for payout-nudge
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.pn' }] }), { status: 200 }),
    ));
  });

  it('Suspended business → attempt exists + pending_authorization + zero Meta', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(executePayoutNudgeSend({
      supabase: {} as any,
      businessId: 'biz-suspended',
      recipientPhone: '+1234',
      waToken: 'token',
      waPhoneId: 'phone-id',
      messageBody: 'test',
      authorizationCheck: async () => { throw new Error('Messaging suspended for business biz-suspended: suspended'); },
    })).rejects.toThrow('suspended');

    // Attempt was created (createAttempt called)
    expect(mockCreateAttempt).toHaveBeenCalled();
    // But NOT marked failed (stays pending_authorization)
    expect(mockMarkFailed).not.toHaveBeenCalled();
    // Zero Meta calls
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Missing provider credentials → zero attempt + zero Meta', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await executePayoutNudgeSend({
      supabase: {} as any,
      businessId: 'biz-1',
      recipientPhone: '+1234',
      waToken: '',
      waPhoneId: '',
      messageBody: 'test',
      authorizationCheck: async () => {},
    });

    expect(result.sent).toBe(false);
    expect(result.attemptId).toBeNull();
    // Zero attempt creation
    expect(mockCreateAttempt).not.toHaveBeenCalled();
    // Zero Meta calls
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
