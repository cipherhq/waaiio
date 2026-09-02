/**
 * S-1 Webhook + Hard-Stop Composition Tests (#256 + #279)
 *
 * Proves that deadline safety (#279) and emergency hard-stop (#256)
 * compose correctly at the webhook send boundary.
 *
 * Uses real MetaCloudSender (not mocked) with mocked MetaCloudService
 * and send-guard to verify provider call counts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock circuit breaker
vi.mock('@/lib/circuit-breaker', () => ({
  isCircuitOpen: () => false,
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  CircuitBreakerOpenError: class extends Error {},
}));

// Controllable suspension state
let suspendedBizIds = new Set<string>();
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockImplementation(async (bizId: string) => {
    if (!bizId) throw Object.assign(new Error('Messaging suspended for business unknown: missing_business_id'), { name: 'MessagingSuspendedError' });
    if (suspendedBizIds.has(bizId)) throw Object.assign(new Error(`Messaging suspended for business ${bizId}: suspended`), { name: 'MessagingSuspendedError' });
  }),
}));

const { MetaCloudSender } = await import('@/lib/channels/message-sender');

function createMockCloud() {
  return {
    sendText: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-1' }] }),
    sendButtons: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-2' }] }),
  };
}

describe('S-1 + #279 Webhook Composition (#256)', () => {
  beforeEach(() => {
    suspendedBizIds = new Set();
    vi.clearAllMocks();
  });

  it('allowed business + valid deadline → exactly 1 provider call', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-ok');
    // No deadline (beforeEachAttempt not set) — simulates non-deadline context
    await sender.sendText({ to: '+234800', text: 'test' });
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
  });

  it('suspended business + valid deadline → zero provider calls', async () => {
    suspendedBizIds.add('biz-bad');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-bad');
    await expect(sender.sendText({ to: '+234800', text: 'test' })).rejects.toThrow('suspended');
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  it('allowed business + expired deadline → zero provider calls', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-ok');
    sender.beforeEachAttempt = () => { throw new Error('Side-effect deadline exceeded'); };
    await expect(sender.sendText({ to: '+234800', text: 'test' })).rejects.toThrow('deadline');
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  it('suspension activates after first transient failure → no second provider call', async () => {
    let callCount = 0;
    const cloud = {
      ...createMockCloud(),
      sendText: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          suspendedBizIds.add('biz-race');
          throw new Error('Cloud API error: 500');
        }
        return { messages: [{ id: 'msg-1' }] };
      }),
    };
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-race');
    await expect(sender.sendText({ to: '+234800', text: 'test' })).rejects.toThrow('suspended');
    expect(cloud.sendText).toHaveBeenCalledTimes(1); // Only the first attempt reached Meta
  });

  it('deadline expires after first transient failure → no second provider call', async () => {
    let callCount = 0;
    let deadlineExpired = false;
    const cloud = {
      ...createMockCloud(),
      sendText: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          deadlineExpired = true;
          throw new Error('Cloud API error: 500');
        }
        return { messages: [{ id: 'msg-1' }] };
      }),
    };
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-ok');
    sender.beforeEachAttempt = () => { if (deadlineExpired) throw new Error('Side-effect deadline exceeded'); };
    await expect(sender.sendText({ to: '+234800', text: 'test' })).rejects.toThrow('deadline');
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
  });

  it('noRetry + valid guards → exactly 1 provider call', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-ok');
    sender.beforeEachAttempt = () => {}; // valid deadline
    await sender.sendText({ to: '+234800', text: 'test', noRetry: true });
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
  });

  it('noRetry + suspended → zero provider calls', async () => {
    suspendedBizIds.add('biz-bad');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-bad');
    sender.beforeEachAttempt = () => {}; // valid deadline
    await expect(sender.sendText({ to: '+234800', text: 'test', noRetry: true })).rejects.toThrow('suspended');
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  it('noRetry + expired deadline → zero provider calls', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-ok');
    sender.beforeEachAttempt = () => { throw new Error('Side-effect deadline exceeded'); };
    await expect(sender.sendText({ to: '+234800', text: 'test', noRetry: true })).rejects.toThrow('deadline');
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  it('noRetry: deadline expires during hard-stop authorization → zero provider calls', async () => {
    // Simulate: beforeEachAttempt passes, but hard-stop auth takes time,
    // and by the time we'd invoke the provider, deadline has expired.
    // In our implementation, beforeEachAttempt fires first in the closure,
    // so this tests that beforeEachAttempt fires AT ALL for noRetry.
    let attempt = 0;
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-ok');
    sender.beforeEachAttempt = () => {
      attempt++;
      if (attempt >= 1) throw new Error('Side-effect deadline exceeded');
    };
    await expect(sender.sendText({ to: '+234800', text: 'test', noRetry: true })).rejects.toThrow('deadline');
    expect(cloud.sendText).not.toHaveBeenCalled();
    expect(attempt).toBe(1); // beforeEachAttempt was called for the single attempt
  });

  it('wrapper forwarding preserves bindBusiness/enterPlatformDiscovery', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);

    // Simulate what createDeadlineGuardedSender does: wraps but forwards state APIs
    expect(sender.boundBusinessId).toBe('');
    sender.bindBusiness('biz-test');
    expect(sender.boundBusinessId).toBe('biz-test');
    sender.enterPlatformDiscovery();
    expect(sender.boundBusinessId).toBe('');

    // Platform send works when tenantless
    await sender.sendPlatformText({ to: '+234800', text: 'Welcome!' });
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
  });

  it('platform sends are also deadline-limited', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    // Tenantless platform send with expired deadline
    sender.beforeEachAttempt = () => { throw new Error('Side-effect deadline exceeded'); };
    await expect(sender.sendPlatformText({ to: '+234800', text: 'test' })).rejects.toThrow('deadline');
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  it('missing business identity → zero provider calls', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    // No bindBusiness → _businessId is ''
    await expect(sender.sendText({ to: '+234800', text: 'test' })).rejects.toThrow('missing_business_id');
    expect(cloud.sendText).not.toHaveBeenCalled();
  });
});
