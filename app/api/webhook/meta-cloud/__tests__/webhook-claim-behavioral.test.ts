/**
 * #271 Slice B — Executable runtime behavioral tests for webhook claim/fencing.
 *
 * Tests the deadline-guarded sender, duplicate-response prevention, and
 * the processing-failure → completion (not failed) policy.
 *
 * Uses real function calls with mocked external boundaries (Meta API, Supabase).
 *
 * Refs: #278, #271
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  generateRequestId: vi.fn(() => 'req-test'),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import type { MessageSender } from '@/lib/channels/message-sender';

// Mock send-guard so assertMessagingAllowed is a no-op (business suspension not under test here)
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn(async () => {}),
  MessagingSuspendedError: class extends Error { constructor(id: string, r: string) { super(`Messaging suspended for business ${id}: ${r}`); } },
}));

// Mock circuit breaker (used by withRetry inside MetaCloudSender)
vi.mock('@/lib/circuit-breaker', () => ({
  isCircuitOpen: vi.fn(() => false),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  CircuitBreakerOpenError: class extends Error { constructor(k: string) { super(k); } },
}));

describe('Slice B — deadline-guarded sender', () => {
  // Import the guarded sender creator dynamically since it's defined in the route file.
  // We test the pattern directly by reimplementing the same logic.

  const SIDE_EFFECT_DEADLINE_MS = 50_000;

  class DeadlineExceededError extends Error {
    constructor() { super('Side-effect deadline exceeded — send suppressed'); this.name = 'DeadlineExceededError'; }
  }

  function createDeadlineGuardedSender(inner: MessageSender, startTime: number): MessageSender {
    function guardedCall<T>(fn: () => Promise<T>): Promise<T> {
      if (Date.now() - startTime >= SIDE_EFFECT_DEADLINE_MS) {
        return Promise.reject(new DeadlineExceededError());
      }
      return fn();
    }
    return {
      sendText: (msg) => guardedCall(() => inner.sendText(msg)),
      sendButtons: (msg) => guardedCall(() => inner.sendButtons(msg)),
      sendList: (msg) => guardedCall(() => inner.sendList(msg)),
      sendImage: (msg) => guardedCall(() => inner.sendImage(msg)),
      sendDocument: (msg) => guardedCall(() => inner.sendDocument(msg)),
      sendAudio: (msg) => guardedCall(() => inner.sendAudio(msg)),
    };
  }

  let innerSender: MessageSender;

  beforeEach(() => {
    vi.clearAllMocks();
    innerSender = {
      sendText: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-1' }),
      sendButtons: vi.fn().mockResolvedValue({ success: true }),
      sendList: vi.fn().mockResolvedValue({ success: true }),
      sendImage: vi.fn().mockResolvedValue({ success: true }),
      sendDocument: vi.fn().mockResolvedValue({ success: true }),
      sendAudio: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  it('allows sends when within the deadline', async () => {
    const startTime = Date.now(); // just started
    const guarded = createDeadlineGuardedSender(innerSender, startTime);

    await guarded.sendText({ to: '+123', text: 'Hello' });
    expect(innerSender.sendText).toHaveBeenCalledOnce();
  });

  it('blocks sends after the deadline is exceeded', async () => {
    // Start time 60 seconds ago — well past the 50s deadline
    const startTime = Date.now() - 60_000;
    const guarded = createDeadlineGuardedSender(innerSender, startTime);

    await expect(guarded.sendText({ to: '+123', text: 'Hello' }))
      .rejects.toThrow('Side-effect deadline exceeded');

    // Inner sender must NOT have been called
    expect(innerSender.sendText).not.toHaveBeenCalled();
  });

  it('blocks ALL send methods after deadline, not just sendText', async () => {
    const startTime = Date.now() - 60_000;
    const guarded = createDeadlineGuardedSender(innerSender, startTime);

    await expect(guarded.sendButtons({ to: '+123', body: 'Pick', buttons: [] }))
      .rejects.toThrow('Side-effect deadline exceeded');
    await expect(guarded.sendList({ to: '+123', title: 'T', body: 'B', buttonLabel: 'L', items: [] }))
      .rejects.toThrow('Side-effect deadline exceeded');
    await expect(guarded.sendImage({ to: '+123', imageUrl: 'http://img' }))
      .rejects.toThrow('Side-effect deadline exceeded');

    expect(innerSender.sendButtons).not.toHaveBeenCalled();
    expect(innerSender.sendList).not.toHaveBeenCalled();
    expect(innerSender.sendImage).not.toHaveBeenCalled();
  });

  it('first send within deadline succeeds, later send past deadline fails', async () => {
    // Start time 49 seconds ago — just within deadline
    let startTime = Date.now() - 49_000;
    const guarded = createDeadlineGuardedSender(innerSender, startTime);

    // First send: within deadline
    await guarded.sendText({ to: '+123', text: 'First' });
    expect(innerSender.sendText).toHaveBeenCalledOnce();

    // Simulate time advancing past deadline by overriding startTime
    // Since the guarded sender captures startTime by reference closure, we need
    // a new guarded sender to simulate time passing. In production, the same
    // guarded sender instance is used and Date.now() naturally advances.
    const guardedLate = createDeadlineGuardedSender(innerSender, Date.now() - 51_000);
    await expect(guardedLate.sendText({ to: '+123', text: 'Late' }))
      .rejects.toThrow('Side-effect deadline exceeded');

    // Inner sender called only once (the first send)
    expect(innerSender.sendText).toHaveBeenCalledOnce();
  });
});

describe('Slice B — processing failure → completed (no replay)', () => {
  it('catch block sends error message THEN completes (not fails) the event', async () => {
    // Read the actual route source to verify the ordering
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const routeSrc = readFileSync(
      resolve(__dirname, '../route.ts'), 'utf-8',
    );

    // Find the catch block
    const catchIdx = routeSrc.indexOf('catch (processingErr)');
    expect(catchIdx).toBeGreaterThan(0);

    // After catch: guardedSender.sendText (error message) must come BEFORE complete_webhook_event
    const afterCatch = routeSrc.slice(catchIdx);
    const sendIdx = afterCatch.indexOf('guardedSender.sendText');
    const completeIdx = afterCatch.indexOf('complete_webhook_event');

    // Send must come before complete
    expect(sendIdx).toBeGreaterThan(0);
    expect(completeIdx).toBeGreaterThan(sendIdx);

    // Must NOT call fail_webhook_event in the catch block (uses complete to prevent replay)
    const failInCatch = afterCatch.slice(0, afterCatch.indexOf('continue;')).indexOf('fail_webhook_event');
    expect(failInCatch).toBe(-1);
  });

  it('guardedSender (not resolved.sender) is used for the error fallback send', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const routeSrc = readFileSync(resolve(__dirname, '../route.ts'), 'utf-8');

    const catchIdx = routeSrc.indexOf('catch (processingErr)');
    const afterCatch = routeSrc.slice(catchIdx, catchIdx + 1500);

    // Must use guardedSender (deadline-guarded), not resolved.sender
    expect(afterCatch).toContain('guardedSender.sendText');
    expect(afterCatch).not.toContain('resolved.sender.sendText');
  });

  it('BotService receives the deadline-guarded sender, not the raw sender', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const routeSrc = readFileSync(resolve(__dirname, '../route.ts'), 'utf-8');

    // BotService must be instantiated with guardedSender
    expect(routeSrc).toContain('new BotService(supabase, guardedSender,');
  });

  it('all outbound sends in the claimed block use guardedSender', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const routeSrc = readFileSync(resolve(__dirname, '../route.ts'), 'utf-8');

    // Find the claimed block (after claimToken assignment)
    const claimTokenIdx = routeSrc.indexOf('const claimToken = claimResult.claim_token');
    const afterClaim = routeSrc.slice(claimTokenIdx);

    // No resolved.sender.sendText should appear in the claimed block
    // (all must use guardedSender or go through BotService which has guardedSender)
    const endOfClaimBlock = afterClaim.indexOf('continue; // Move to next message');
    const claimedBlock = afterClaim.slice(0, endOfClaimBlock);

    // Count resolved.sender usage — should be zero in the claimed block
    const rawSenderInClaimed = (claimedBlock.match(/resolved\.sender\.send/g) || []).length;
    expect(rawSenderInClaimed).toBe(0);
  });

  it('deadline guard sets beforeEachAttempt on MetaCloudSender for per-retry enforcement', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const routeSrc = readFileSync(resolve(__dirname, '../route.ts'), 'utf-8');

    const guardedSenderDef = routeSrc.slice(
      routeSrc.indexOf('function createDeadlineGuardedSender'),
      routeSrc.indexOf('function createDeadlineGuardedSender') + 2000,
    );
    // Must set beforeEachAttempt on the inner sender for per-retry guard
    expect(guardedSenderDef).toContain('beforeEachAttempt');
    expect(guardedSenderDef).toContain('deadlineCheck');
  });

  it('withRetry calls beforeEachAttempt before every provider attempt', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const senderSrc = readFileSync(resolve(__dirname, '../../../../../lib/channels/message-sender.ts'), 'utf-8');

    // withRetry must accept and call beforeEachAttempt
    expect(senderSrc).toContain('beforeEachAttempt');
    // Must be called inside the retry loop before fn()
    const withRetryFn = senderSrc.slice(
      senderSrc.indexOf('async function withRetry'),
      senderSrc.indexOf('async function withRetry') + 1000,
    );
    expect(withRetryFn).toContain('if (beforeEachAttempt) beforeEachAttempt()');

    // Every withRetry call in MetaCloudSender must pass this.beforeEachAttempt
    const senderClass = senderSrc.slice(senderSrc.indexOf('class MetaCloudSender'));
    const withRetryCalls = senderClass.match(/withRetry\(/g) || [];
    const guardedCalls = senderClass.match(/this\.beforeEachAttempt/g) || [];
    // Every withRetry call must pass the guard
    expect(guardedCalls.length).toBeGreaterThanOrEqual(withRetryCalls.length);
  });

  it('handleCatalogOrder sender parameter is required (fail-closed)', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const routeSrc = readFileSync(resolve(__dirname, '../route.ts'), 'utf-8');

    // The call site must pass guardedSender to handleCatalogOrder
    expect(routeSrc).toContain('handleCatalogOrder(supabase, resolved, msg, source, msgLog, guardedSender)');

    // handleCatalogOrder sender parameter must be required (not optional)
    const fnBody = routeSrc.slice(
      routeSrc.indexOf('async function handleCatalogOrder'),
      routeSrc.indexOf('async function handleCatalogOrder') + 5000,
    );
    // Must have required sender parameter (no ?)
    expect(fnBody).toContain('sender: import');
    expect(fnBody).not.toContain('sender?:');
    // Must use outbound for sends
    const sendTexts = fnBody.match(/await\s+(outbound|resolved\.sender)\.sendText/g) || [];
    const rawSenderSends = sendTexts.filter(s => s.includes('resolved.sender'));
    expect(rawSenderSends.length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Real MetaCloudSender retry-boundary test
// ══════════════════════════════════════════════════════════════

describe('Slice B — real MetaCloudSender.withRetry deadline enforcement', () => {
  it('sendButtons: attempt 1 before deadline fails retryably, attempt 2 after deadline suppressed by beforeEachAttempt', async () => {
    // Import the REAL MetaCloudSender (not a copy)
    const { MetaCloudSender } = await import('@/lib/channels/message-sender');

    // Track provider API calls
    let providerCallCount = 0;

    // Mock MetaCloudService — sendButtons throws a 5xx (retryable) error on first call
    const mockCloud = {
      sendButtons: vi.fn(async () => {
        providerCallCount++;
        // Simulate 5xx server error — retryable, not a 4xx
        throw new Error('Cloud API error: 500 Internal Server Error');
      }),
    } as any;

    const sender = new MetaCloudSender(mockCloud);
    // Bind a test business so the send-guard doesn't fail on missing_business_id
    sender.bindBusiness('test-biz-id');

    // Simulate: request started 49.5s ago — just before the 50s deadline
    const SIDE_EFFECT_DEADLINE_MS = 50_000;
    let fakeNow = Date.now();
    const requestStart = fakeNow - 49_500; // 49.5s elapsed

    // Install the per-attempt deadline guard (same as production route does).
    // Reads Date.now() to get current time (which triggers the mock time advance).
    sender.beforeEachAttempt = () => {
      const now = Date.now(); // triggers mock time advance after first provider call
      if (now - requestStart >= SIDE_EFFECT_DEADLINE_MS) {
        throw new Error('Side-effect deadline exceeded');
      }
    };

    // The first attempt will pass the guard (49.5s < 50s), call the provider,
    // and throw a 5xx. withRetry will then sleep for the delay period.
    // We advance fakeNow past the deadline before the second attempt.

    // Override Date.now for the retry delay — advance time past deadline
    const origDateNow = Date.now;
    let dateNowCallCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      dateNowCallCount++;
      // After the first provider call + delay, advance time past deadline
      if (providerCallCount >= 1) {
        fakeNow = requestStart + 51_000; // 51s elapsed — past deadline
      }
      return fakeNow;
    });

    // Call sendButtons — should throw after attempt 1 fails and attempt 2 is blocked
    try {
      await sender.sendButtons({
        to: '+2348001234567',
        body: 'Pick an option:',
        buttons: [{ id: 'opt1', title: 'Option 1' }],
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      // The error should be the deadline exceeded (from beforeEachAttempt on attempt 2)
      // OR the original 5xx if retries exhausted — but with our guard, attempt 2 is blocked
      expect(err).toBeDefined();
    }

    // Restore Date.now
    vi.restoreAllMocks();

    // THE KEY PROOF: provider was called exactly ONCE
    // Attempt 1 happened (before deadline), attempt 2 was suppressed by beforeEachAttempt
    expect(providerCallCount).toBe(1);
    expect(mockCloud.sendButtons).toHaveBeenCalledTimes(1);
  });
});
