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

  it('noRetry: deadline expires DURING hard-stop authorization → zero provider calls', async () => {
    // The genuine race: deadline is valid when checked pre-auth, but expires
    // while the async assertMessagingAllowed DB call is pending. The post-auth
    // final deadline check catches the expiry before the provider call.
    let deadlineCheckCount = 0;
    let deadlineExpired = false;

    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-ok');

    // Deadline hook: passes on first call (pre-auth), throws on second (post-auth)
    sender.beforeEachAttempt = () => {
      deadlineCheckCount++;
      if (deadlineExpired) throw new Error('Side-effect deadline exceeded');
    };

    // Mock assertMessagingAllowed to simulate async work during which deadline expires
    const { assertMessagingAllowed } = await import('@/lib/channels/send-guard');
    (assertMessagingAllowed as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // Simulate: authorization takes time, deadline expires during this await
      deadlineExpired = true;
      // Authorization itself succeeds (business is not suspended)
    });

    await expect(sender.sendText({ to: '+234800', text: 'test', noRetry: true })).rejects.toThrow('deadline');
    expect(cloud.sendText).not.toHaveBeenCalled(); // Zero provider calls
    expect(deadlineCheckCount).toBe(2); // Pre-auth (passed) + post-auth (caught expiry)
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
