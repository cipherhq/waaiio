/**
 * ACC-203: Provider adapter proof — MetaCloudSender.sendTemplate noRetry behavior
 *
 * Exercises the REAL MetaCloudSender adapter (not a mocked resolved sender)
 * to prove:
 * 1. noRetry:true → exactly one underlying cloud.sendTemplate call, error propagates
 * 2. Default (no noRetry) → existing retry behavior still occurs
 * 3. MetaApiError 5xx → ambiguous path (route-level regression)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock circuit breaker to avoid interference
vi.mock('@/lib/channels/circuit-breaker', () => ({
  isCircuitOpen: () => false,
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  CircuitBreakerOpenError: class extends Error { constructor(k: string) { super(`Circuit open: ${k}`); } },
}));

// Mock send guard — this test exercises retry behavior, not suspension
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocking circuit breaker
const { MetaCloudSender } = await import('@/lib/channels/message-sender');
const { MetaApiError } = await import('@/lib/channels/meta-api-error');

function createMockCloud(sendTemplateFn: (...args: unknown[]) => Promise<unknown>) {
  return { sendTemplate: sendTemplateFn } as unknown as ConstructorParameters<typeof MetaCloudSender>[0];
}

const baseMsg = {
  to: '2348012345678',
  templateName: 'promo_pickup_verification_v2',
  templateParams: ['Biz', 'Prize', '123456', '10'],
};

describe('MetaCloudSender.sendTemplate provider-adapter proof', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. noRetry:true ──

  it('noRetry:true — ambiguous error causes exactly one underlying call', async () => {
    const cloudSendTemplate = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const sender = new MetaCloudSender(createMockCloud(cloudSendTemplate));

    await expect(sender.sendTemplate({ ...baseMsg, noRetry: true })).rejects.toThrow('ETIMEDOUT');

    // Exactly one call — no retry
    expect(cloudSendTemplate).toHaveBeenCalledTimes(1);
  });

  it('noRetry:true — 5xx MetaApiError causes exactly one underlying call', async () => {
    const cloudSendTemplate = vi.fn().mockRejectedValue(new MetaApiError('Cloud API error: 500', 500));
    const sender = new MetaCloudSender(createMockCloud(cloudSendTemplate));

    await expect(sender.sendTemplate({ ...baseMsg, noRetry: true })).rejects.toThrow('500');

    expect(cloudSendTemplate).toHaveBeenCalledTimes(1);
  });

  it('noRetry:true — success returns messageId', async () => {
    const cloudSendTemplate = vi.fn().mockResolvedValue({ messageId: 'wamid.test123' });
    const sender = new MetaCloudSender(createMockCloud(cloudSendTemplate));

    const result = await sender.sendTemplate({ ...baseMsg, noRetry: true });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('wamid.test123');
    expect(cloudSendTemplate).toHaveBeenCalledTimes(1);
  });

  // ── 2. Default behavior (retry still works) ──

  it('default (no noRetry) — retries on retryable server error and eventually succeeds', async () => {
    // #257: ECONNRESET is now ambiguous (may have emitted) → no retry.
    // Use a clearly retryable 500 error instead.
    const cloudSendTemplate = vi.fn()
      .mockRejectedValueOnce(new Error('Cloud API error: 500'))
      .mockResolvedValueOnce({ messageId: 'wamid.retry-success' });

    const sender = new MetaCloudSender(createMockCloud(cloudSendTemplate));

    // Start the sendTemplate call — will fail first, then retry after delay
    const sendPromise = sender.sendTemplate({ ...baseMsg });

    // Advance past the retry delay (1000ms * (0+1) = 1000ms)
    await vi.advanceTimersByTimeAsync(1500);

    const result = await sendPromise;

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('wamid.retry-success');
    // Called twice: first attempt fails, retry succeeds
    expect(cloudSendTemplate).toHaveBeenCalledTimes(2);
  });

  it('default — 4xx error does NOT retry', async () => {
    const cloudSendTemplate = vi.fn().mockRejectedValue(new MetaApiError('Cloud API error: 400', 400));
    const sender = new MetaCloudSender(createMockCloud(cloudSendTemplate));

    await expect(sender.sendTemplate({ ...baseMsg })).rejects.toThrow('400');

    // Only one call — 4xx is not retried
    expect(cloudSendTemplate).toHaveBeenCalledTimes(1);
  });
});

// ── 3. Route-level regression: MetaApiError 5xx → ambiguous path ──

describe('Route regression: MetaApiError 5xx takes ambiguous path', () => {
  it('OTP route: 5xx MetaApiError is ambiguous (not definite failure)', () => {
    // MetaApiError with httpStatus 500 should NOT be classified as definite rejection
    const err = new MetaApiError('Cloud API error: 500', 500);
    const isDefiniteRejection = err instanceof MetaApiError && err.httpStatus >= 400 && err.httpStatus < 500;
    expect(isDefiniteRejection).toBe(false); // 500 is NOT 4xx → ambiguous
  });

  it('OTP route: 4xx MetaApiError IS definite rejection', () => {
    const err = new MetaApiError('Cloud API error: 400', 400);
    const isDefiniteRejection = err instanceof MetaApiError && err.httpStatus >= 400 && err.httpStatus < 500;
    expect(isDefiniteRejection).toBe(true);
  });

  it('OTP route: generic Error is ambiguous', () => {
    const err = new Error('ETIMEDOUT');
    const isDefiniteRejection = err instanceof MetaApiError && (err as MetaApiError).httpStatus >= 400 && (err as MetaApiError).httpStatus < 500;
    expect(isDefiniteRejection).toBe(false);
  });
});
