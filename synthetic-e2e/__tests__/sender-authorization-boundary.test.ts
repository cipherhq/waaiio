/**
 * Executable MetaCloudSender authorization boundary tests.
 *
 * CTO R3 Fix 2: Tests the real MetaCloudSender with provider transport
 * stubbed. Proves that authorization denial → zero provider calls.
 *
 * Architecture:
 * - Real MetaCloudSender (from lib/channels/message-sender.ts)
 * - Stubbed MetaCloudService (captures instead of calling Meta)
 * - Mocked assertMessagingAllowed (controllable pass/fail)
 * - Mocked financial authorization RPC
 * - Zero actual Meta API egress
 *
 * This is NOT a source-string assertion — it is executable code
 * that instantiates the real sender and verifies behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the send-guard to control hard-stop behavior
const mockAssertMessagingAllowed = vi.fn();
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: (...args: unknown[]) => mockAssertMessagingAllowed(...args),
}));

// Mock attempt recording (no real DB needed)
vi.mock('@/lib/channels/attempt-recording', () => ({
  createAttempt: vi.fn().mockResolvedValue('attempt-test-001'),
  markSending: vi.fn().mockResolvedValue(undefined),
  markAccepted: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
  markAmbiguous: vi.fn().mockResolvedValue(undefined),
  updateAttemptContext: vi.fn().mockResolvedValue(undefined),
  isAmbiguousTransportError: vi.fn().mockReturnValue(false),
  AmbiguousSendError: class extends Error { attemptId: string; constructor(msg: string, id: string) { super(msg); this.attemptId = id; } },
  WamidPersistenceError: class extends Error {},
  GateBlockError: class extends Error {},
}));

// Mock circuit breaker
vi.mock('@/lib/circuit-breaker', () => ({
  isCircuitOpen: vi.fn().mockReturnValue(false),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  CircuitBreakerOpenError: class extends Error {
    constructor(key: string) { super(`Circuit open: ${key}`); }
  },
}));

// Mock phone-country resolution
vi.mock('@/lib/channels/phone-country', () => ({
  resolveRecipientCountry: vi.fn().mockReturnValue('NG'),
}));

// Mock service client for financial authorization
const mockRpc = vi.fn();
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    rpc: mockRpc,
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    }),
  })),
}));

import { MetaCloudSender } from '@/lib/channels/message-sender';
import { installMetaEgressDeny, uninstallMetaEgressDeny, assertZeroMetaEgress, resetMetaEgressCounter } from '../lib/network-deny';

// Track provider-level calls via the stubbed MetaCloudService
let providerCalls: Array<{ method: string; to: string }> = [];

function createStubCloudService() {
  providerCalls = [];
  return {
    sendText: vi.fn(async (msg: { to: string }) => {
      providerCalls.push({ method: 'sendText', to: msg.to });
      return { messageId: 'wamid.stub_001' };
    }),
    sendButtons: vi.fn(async (msg: { to: string }) => {
      providerCalls.push({ method: 'sendButtons', to: msg.to });
      return { messageId: 'wamid.stub_002' };
    }),
    sendList: vi.fn(async (msg: { to: string }) => {
      providerCalls.push({ method: 'sendList', to: msg.to });
      return { messageId: 'wamid.stub_003' };
    }),
    sendImage: vi.fn(async () => ({ messageId: 'wamid.stub_004' })),
    sendDocument: vi.fn(async () => ({ messageId: 'wamid.stub_005' })),
    sendAudio: vi.fn(async () => ({ messageId: 'wamid.stub_006' })),
    sendTemplate: vi.fn(async () => ({ messageId: 'wamid.stub_007' })),
    sendFlow: vi.fn(async () => ({ messageId: 'wamid.stub_008' })),
    sendReaction: vi.fn(async () => ({ messageId: 'wamid.stub_009' })),
    sendLocation: vi.fn(async () => ({ messageId: 'wamid.stub_010' })),
    sendProduct: vi.fn(async () => ({ messageId: 'wamid.stub_011' })),
    sendProductList: vi.fn(async () => ({ messageId: 'wamid.stub_012' })),
    markAsRead: vi.fn(async () => ({})),
  } as any;
}

// Minimal mock Supabase for attempt recording
function createMockSupabaseForSender() {
  const chain: Record<string, any> = {};
  for (const m of ['select', 'insert', 'update', 'eq', 'single']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
  return {
    from: vi.fn().mockReturnValue(chain),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  providerCalls = [];
  resetMetaEgressCounter();
  // Default: messaging allowed, financial gate OFF
  mockAssertMessagingAllowed.mockResolvedValue(undefined);
  mockRpc.mockResolvedValue({ data: { enforcement_required: false }, error: null });
});

describe('R3: MetaCloudSender authorization boundary (executable)', () => {

  it('hard-stop denial → zero provider calls', async () => {
    installMetaEgressDeny();
    try {
      const cloud = createStubCloudService();
      const supabase = createMockSupabaseForSender();
      const sender = new MetaCloudSender(cloud, supabase);
      sender.bindBusiness('biz-test-001');

      // Hard-stop: assertMessagingAllowed throws
      mockAssertMessagingAllowed.mockRejectedValue(new Error('Messaging suspended for business biz-test-001'));

      await expect(sender.sendText({ to: '15550001234', text: 'Should not reach provider' }))
        .rejects.toThrow('Messaging suspended');

      // Zero provider calls — the stub was never invoked
      expect(providerCalls).toHaveLength(0);
      expect(cloud.sendText).not.toHaveBeenCalled();

      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('financial authorization denial → zero provider calls', async () => {
    installMetaEgressDeny();
    try {
      const cloud = createStubCloudService();
      const supabase = createMockSupabaseForSender();
      const sender = new MetaCloudSender(cloud, supabase);
      sender.bindBusiness('biz-test-002');

      // Messaging allowed, but financial gate denies
      mockAssertMessagingAllowed.mockResolvedValue(undefined);
      mockRpc.mockResolvedValue({ data: { authorized: false, reason: 'Insufficient balance' }, error: null });

      await expect(sender.sendText({ to: '15550001234', text: 'Should not reach provider' }))
        .rejects.toThrow('Financial authorization denied');

      // Zero provider calls
      expect(providerCalls).toHaveLength(0);
      expect(cloud.sendText).not.toHaveBeenCalled();

      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('authorized send → provider stub called exactly once', async () => {
    installMetaEgressDeny();
    try {
      const cloud = createStubCloudService();
      const supabase = createMockSupabaseForSender();
      const sender = new MetaCloudSender(cloud, supabase);
      sender.bindBusiness('biz-test-003');

      // Both gates pass
      mockAssertMessagingAllowed.mockResolvedValue(undefined);
      mockRpc.mockResolvedValue({ data: { enforcement_required: false }, error: null });

      const result = await sender.sendText({ to: '15550001234', text: 'Authorized message' });

      // Provider stub reached exactly once
      expect(providerCalls).toHaveLength(1);
      expect(providerCalls[0].method).toBe('sendText');
      expect(providerCalls[0].to).toBe('15550001234');
      expect(cloud.sendText).toHaveBeenCalledTimes(1);
      expect(result.messageId).toBe('wamid.stub_001');

      // But no actual Meta egress (stub is in-process)
      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('financial RPC error → fail-closed zero provider calls', async () => {
    installMetaEgressDeny();
    try {
      const cloud = createStubCloudService();
      const supabase = createMockSupabaseForSender();
      const sender = new MetaCloudSender(cloud, supabase);
      sender.bindBusiness('biz-test-004');

      mockAssertMessagingAllowed.mockResolvedValue(undefined);
      mockRpc.mockResolvedValue({ data: null, error: { message: 'DB connection error' } });

      await expect(sender.sendText({ to: '15550001234', text: 'Should fail closed' }))
        .rejects.toThrow('Financial authorization RPC error');

      expect(providerCalls).toHaveLength(0);
      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('platform-scoped send skips business guard but reaches provider', async () => {
    installMetaEgressDeny();
    try {
      const cloud = createStubCloudService();
      const sender = new MetaCloudSender(cloud, null); // No supabase = no financial gate
      // No business bound = platform scope

      const result = await sender.sendPlatformText({ to: '15550001234', text: 'Platform greeting' });

      // Provider reached (platform sends skip business guard)
      expect(providerCalls).toHaveLength(1);
      expect(result.success).toBe(true);

      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });
});
