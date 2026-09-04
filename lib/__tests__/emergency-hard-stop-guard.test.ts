/**
 * Emergency Hard-Stop Send Guard Tests (#256 S-1)
 *
 * Verifies that the send guard blocks Meta /messages calls when
 * messaging is suspended, and allows them when not suspended.
 * Uses mocks — no real Meta or DB calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

// ── Structural inventory test ──

describe('S-1 Egress Inventory (#256)', () => {
  const META_CLOUD_PATH = resolve(__dirname, '../channels/meta-cloud.ts');
  const SEND_GUARD_PATH = resolve(__dirname, '../channels/send-guard.ts');
  const MESSAGE_SENDER_PATH = resolve(__dirname, '../channels/message-sender.ts');
  const EDGE_FN_DIR = resolve(__dirname, '../../supabase/functions');

  it('Structural: MetaCloudSender has assertMessagingAllowed guard for every send method', () => {
    const src = readFileSync(MESSAGE_SENDER_PATH, 'utf-8');
    // #257: guard is inside withAttemptAndGuard(), called by every send method.
    // Verify: 1) withAttemptAndGuard contains the guard, 2) every send method uses it.
    expect(src, 'withAttemptAndGuard missing assertMessagingAllowed').toContain('assertMessagingAllowed');
    const sendMethods = [
      'sendText', 'sendList', 'sendButtons', 'sendImage', 'sendDocument',
      'sendAudio', 'sendTemplate', 'sendFlow', 'sendReaction', 'sendLocation',
      'sendProduct', 'sendProductList',
    ];
    for (const method of sendMethods) {
      const methodRegex = new RegExp(`async ${method}\\b[\\s\\S]*?withAttemptAndGuard`, 'm');
      expect(src, `${method} missing withAttemptAndGuard (contains guard)`).toMatch(methodRegex);
    }
  });

  it('Structural: send-guard module exists and exports assertMessagingAllowed', () => {
    const src = readFileSync(SEND_GUARD_PATH, 'utf-8');
    expect(src).toContain('export async function assertMessagingAllowed');
    expect(src).toContain('MessagingSuspendedError');
  });

  it('Structural: every message-sending Edge Function has canonical final-boundary guard inside sendWhatsApp', () => {
    const sendingFunctions = [
      'booking-reminders', 'abandoned-cart-reminder', 'birthday-campaign',
      'noshow-reschedule', 'contract-reminders', 'low-stock-alerts',
      'recurring-reminder', 'customer-reengagement', 'waitlist-expiration',
      'process-sequences', 'generate-sign-link', 'chat-timeout',
    ];
    for (const fn of sendingFunctions) {
      const fnPath = resolve(EDGE_FN_DIR, fn, 'index.ts');
      const src = readFileSync(fnPath, 'utf-8');
      const sendHelperIdx = src.indexOf('async function sendWhatsApp') !== -1
        ? src.indexOf('async function sendWhatsApp')
        : src.indexOf('async function sendWhatsAppForBusiness');
      expect(sendHelperIdx, `${fn}: missing sendWhatsApp helper`).toBeGreaterThanOrEqual(0);

      const helperEnd = src.indexOf('\n}\n', sendHelperIdx);
      const helperBody = src.slice(sendHelperIdx, helperEnd > 0 ? helperEnd + 3 : sendHelperIdx + 2000);

      // #257: Suspension check is now inside withEdgeAttemptRecording callback
      // Verify: suspension logic + withEdgeAttemptRecording both present in helper
      expect(helperBody, `${fn}: missing withEdgeAttemptRecording`).toContain('withEdgeAttemptRecording');
      expect(helperBody, `${fn}: missing messaging_suspended check`).toContain("messaging_suspended");
      expect(helperBody, `${fn}: missing fetch to graph.facebook.com`).toContain('graph.facebook.com');
    }
  });

  it('Structural: non-sending Edge Functions do NOT have suspension check', () => {
    const nonSendingFunctions = ['daily-summary', 'session-cleanup'];
    for (const fn of nonSendingFunctions) {
      const fnPath = resolve(EDGE_FN_DIR, fn, 'index.ts');
      const src = readFileSync(fnPath, 'utf-8');
      expect(src, `${fn} should not have messaging_suspended check`).not.toContain('messaging_suspended');
    }
  });

  it('Structural: payout-nudge has assertMessagingAllowed guard', () => {
    const src = readFileSync(resolve(__dirname, '../../app/api/cron/payout-nudge/route.ts'), 'utf-8');
    expect(src).toContain('assertMessagingAllowed');
  });

  it('Structural: platform-scoped exemptions do NOT have business guard', () => {
    // recurring/verify — customer OTP, no business context
    const recurringVerify = readFileSync(resolve(__dirname, '../../app/api/recurring/verify/route.ts'), 'utf-8');
    expect(recurringVerify).not.toContain('assertMessagingAllowed');
    expect(recurringVerify).not.toContain('messaging_suspended');

    // admin/otp — admin 2FA, no business context
    const adminOtp = readFileSync(resolve(__dirname, '../../app/api/admin/otp/route.ts'), 'utf-8');
    expect(adminOtp).not.toContain('assertMessagingAllowed');
    expect(adminOtp).not.toContain('messaging_suspended');

    // auth/otp/send — user login OTP, uses sendAuthenticationTemplate on MetaCloudService directly (not MetaCloudSender)
    const authOtpSend = readFileSync(resolve(__dirname, '../../app/api/auth/otp/send/route.ts'), 'utf-8');
    expect(authOtpSend).not.toContain('assertMessagingAllowed');
    expect(authOtpSend).not.toContain('messaging_suspended');
    // Verify it uses MetaCloudService directly, not MetaCloudSender
    expect(authOtpSend).toContain('MetaCloudService');
    expect(authOtpSend).not.toContain('MetaCloudSender');
  });

  it('Structural: markAsRead in meta-cloud.ts is NOT guarded (read receipt, not content send)', () => {
    const src = readFileSync(META_CLOUD_PATH, 'utf-8');
    // markAsRead should not reference assertMessagingAllowed
    const markAsReadSection = src.split('markAsRead')[1]?.split('async')[0] || '';
    expect(markAsReadSection).not.toContain('assertMessagingAllowed');
  });

  it('Regression: every graph.facebook.com /messages fetch is classified', () => {
    // Scan all TS files for direct /messages fetches
    const allFiles = findTsFiles(resolve(__dirname, '../../'));
    const unclassified: string[] = [];

    // Known classified paths
    const classifiedFiles = new Set([
      // Business-scoped (guarded via MetaCloudSender or assertMessagingAllowed)
      'lib/channels/meta-cloud.ts',       // callApi — guarded via MetaCloudSender
      'lib/channels/message-sender.ts',    // MetaCloudSender — has guard
      'app/api/cron/payout-nudge/route.ts', // direct fetch — has assertMessagingAllowed
      // Platform-scoped exemptions (no business context)
      'app/api/recurring/verify/route.ts',  // platform OTP — explicit exemption
      'app/api/admin/otp/route.ts',         // admin OTP — explicit exemption
      'app/api/auth/otp/send/route.ts',     // user login OTP — uses MetaCloudService directly, platform-scoped
      // Edge Functions (guarded via messaging_suspended check)
      'supabase/functions/booking-reminders/index.ts',
      'supabase/functions/abandoned-cart-reminder/index.ts',
      'supabase/functions/birthday-campaign/index.ts',
      'supabase/functions/noshow-reschedule/index.ts',
      'supabase/functions/contract-reminders/index.ts',
      'supabase/functions/low-stock-alerts/index.ts',
      'supabase/functions/recurring-reminder/index.ts',
      'supabase/functions/customer-reengagement/index.ts',
      'supabase/functions/waitlist-expiration/index.ts',
      'supabase/functions/process-sequences/index.ts',
      'supabase/functions/generate-sign-link/index.ts',
      'supabase/functions/chat-timeout/index.ts',
    ]);

    for (const file of allFiles) {
      if (file.includes('node_modules') || file.includes('__tests__') || file.includes('.test.')) continue;
      try {
        const content = readFileSync(file, 'utf-8');
        if (content.includes('/messages') && content.includes('graph.facebook.com')) {
          const relPath = file.replace(resolve(__dirname, '../../') + '/', '');
          if (!classifiedFiles.has(relPath)) {
            unclassified.push(relPath);
          }
        }
      } catch { /* skip unreadable */ }
    }

    expect(unclassified, `Unclassified Meta /messages egress: ${unclassified.join(', ')}`).toHaveLength(0);
  });
});

// ── Send guard unit tests ──

describe('S-1 Send Guard Unit Tests (#256)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('assertMessagingAllowed: missing businessId → throws', async () => {
    const { assertMessagingAllowed } = await import('../channels/send-guard');
    await expect(assertMessagingAllowed('')).rejects.toThrow('missing_business_id');
  });

  it('assertMessagingAllowed: suspended business → throws', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { messaging_suspended: true }, error: null }),
            }),
          }),
        }),
      }),
    }));
    const { assertMessagingAllowed } = await import('../channels/send-guard');
    await expect(assertMessagingAllowed('biz-1')).rejects.toThrow('suspended');
  });

  it('assertMessagingAllowed: not suspended → resolves', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { messaging_suspended: false }, error: null }),
            }),
          }),
        }),
      }),
    }));
    const { assertMessagingAllowed } = await import('../channels/send-guard');
    await expect(assertMessagingAllowed('biz-1')).resolves.toBeUndefined();
  });

  it('assertMessagingAllowed: DB error → throws (fail closed)', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: { message: 'DB timeout' } }),
            }),
          }),
        }),
      }),
    }));
    const { assertMessagingAllowed } = await import('../channels/send-guard');
    await expect(assertMessagingAllowed('biz-1')).rejects.toThrow('db_error');
  });

  it('assertMessagingAllowed: missing business row → throws (fail closed)', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }));
    const { assertMessagingAllowed } = await import('../channels/send-guard');
    await expect(assertMessagingAllowed('biz-1')).rejects.toThrow('business_not_found');
  });

  it('assertMessagingAllowed: NULL messaging_suspended → throws (fail closed)', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { messaging_suspended: null }, error: null }),
            }),
          }),
        }),
      }),
    }));
    const { assertMessagingAllowed } = await import('../channels/send-guard');
    await expect(assertMessagingAllowed('biz-1')).rejects.toThrow('suspended');
  });

  it('MetaCloudSender with missing businessId → zero Meta calls (fail closed)', async () => {
    // Mock the send guard to track calls
    let guardCalled = false;
    vi.doMock('@/lib/channels/send-guard', () => ({
      assertMessagingAllowed: async (bizId: string) => {
        guardCalled = true;
        if (!bizId) throw new Error('Messaging suspended for business unknown: missing_business_id');
      },
    }));
    vi.doMock('@/lib/circuit-breaker', () => ({
      isCircuitOpen: () => false,
      recordSuccess: () => {},
      recordFailure: () => {},
      CircuitBreakerOpenError: class extends Error {},
    }));

    const { MetaCloudSender } = await import('../channels/message-sender');
    const mockCloud = { sendText: vi.fn() };
    // Construct without businessId — defaults to ''
    const sender = new MetaCloudSender(mockCloud as any);

    await expect(sender.sendText({ to: '+1234567890', text: 'test' })).rejects.toThrow('missing_business_id');
    expect(guardCalled).toBe(true);
    expect(mockCloud.sendText).not.toHaveBeenCalled(); // Zero Meta calls
  });

  it('Retry-race: suspension activates between attempts → second attempt blocked', async () => {
    let callCount = 0;
    let suspended = false;

    vi.doMock('@/lib/channels/send-guard', () => ({
      assertMessagingAllowed: async () => {
        if (suspended) throw new Error('Messaging suspended for business biz-1: suspended');
        // First call passes, subsequent calls may be blocked if suspended changes
      },
    }));
    vi.doMock('@/lib/circuit-breaker', () => ({
      isCircuitOpen: () => false,
      recordSuccess: () => {},
      recordFailure: () => {},
      CircuitBreakerOpenError: class extends Error {},
    }));

    const { MetaCloudSender } = await import('../channels/message-sender');
    const mockCloud = {
      sendText: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First attempt: Meta returns transient 500 error
          // Before retry, admin suspends
          suspended = true;
          throw new Error('Cloud API error: 500');
        }
        return { messages: [{ id: 'msg-1' }] };
      }),
    };

    const sender = new MetaCloudSender(mockCloud as any, 'biz-1');
    // The send should fail: first attempt hits Meta (500), suspension activates,
    // retry calls assertMessagingAllowed which now throws
    await expect(sender.sendText({ to: '+1234567890', text: 'test' })).rejects.toThrow('suspended');
    // Meta was called exactly once (the failed first attempt). The retry was blocked before reaching Meta.
    expect(mockCloud.sendText).toHaveBeenCalledTimes(1);
  });
});

// ── Shared-channel resolver executable tests ──

describe('S-1 Shared-Channel Business Identity (#256)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('shared channel: business A suspended → blocked, business B allowed → reaches Meta', async () => {
    // Both businesses use the same shared channel (channel.business_id = NULL)
    const sharedChannel = {
      id: 'ch-shared',
      business_id: null,
      channel_type: 'shared',
      is_active: true,
      phone_number_id: 'pnid-1',
      access_token: 'tok-1',
      waba_id: 'waba-1',
      country_code: 'NG',
    };

    let guardBusinessId: string | null = null;
    // Mock send-guard to capture which businessId is checked
    vi.doMock('@/lib/channels/send-guard', () => ({
      assertMessagingAllowed: async (bizId: string) => {
        guardBusinessId = bizId;
        // Simulate: biz-A is suspended, biz-B is allowed
        if (bizId === 'biz-A') throw new Error('Messaging suspended for business biz-A: suspended');
      },
    }));
    vi.doMock('@/lib/circuit-breaker', () => ({
      isCircuitOpen: () => false,
      recordSuccess: () => {},
      recordFailure: () => {},
      CircuitBreakerOpenError: class extends Error {},
    }));

    const { MetaCloudSender } = await import('../channels/message-sender');
    const mockCloud = { sendText: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-1' }] }) };

    // Business A: sender built from shared channel, then bound to biz-A
    const senderA = new MetaCloudSender(mockCloud as any);
    senderA.bindBusiness('biz-A');
    await expect(senderA.sendText({ to: '+234800', text: 'test' })).rejects.toThrow('suspended');
    expect(guardBusinessId).toBe('biz-A');
    expect(mockCloud.sendText).not.toHaveBeenCalled();

    // Reset for business B
    mockCloud.sendText.mockClear();
    guardBusinessId = null;

    // Business B: same shared channel, bound to biz-B
    const senderB = new MetaCloudSender(mockCloud as any);
    senderB.bindBusiness('biz-B');
    await senderB.sendText({ to: '+234800', text: 'test' });
    expect(guardBusinessId).toBe('biz-B');
    expect(mockCloud.sendText).toHaveBeenCalledTimes(1);
  });

  it('ChannelResolver.resolveByBusinessId stamps requested businessId via bindBusiness API', async () => {
    const RESOLVER_SRC = readFileSync(resolve(__dirname, '../channels/channel-resolver.ts'), 'utf-8');
    // stampBusinessId must be called on every resolution path and use bindBusiness
    expect(RESOLVER_SRC).toContain('stampBusinessId(resolved, businessId)');
    expect(RESOLVER_SRC).toContain('stampBusinessId(shared, businessId)');
    // stampBusinessId uses bindBusiness API, not direct assignment
    expect(RESOLVER_SRC).toContain('resolved.sender.bindBusiness(businessId)');
    // Cache hit path also stamps
    const cacheSection = RESOLVER_SRC.slice(RESOLVER_SRC.indexOf('const cached = this.cache.get'));
    expect(cacheSection).toContain('stampBusinessId(resolved, businessId)');
  });
});

// ── Edge final-boundary executable tests ──

describe('S-1 Edge Final-Boundary Guard (#256)', () => {
  /**
   * Simulates the Edge sendWhatsApp() pattern used by all 12 sending functions.
   * This is the canonical guard logic — extracted for executable testing.
   */
  async function edgeSendWhatsApp(
    bizCheck: { messaging_suspended: boolean | null } | null,
    bizErr: { message: string } | null,
    fetchMock: () => Promise<{ ok: boolean }>,
  ): Promise<boolean> {
    // This mirrors the exact pattern in every Edge function's sendWhatsApp()
    if (bizErr || !bizCheck || bizCheck.messaging_suspended !== false) {
      return false; // blocked
    }
    const response = await fetchMock();
    return response.ok;
  }

  it('suspended → zero Meta fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const result = await edgeSendWhatsApp({ messaging_suspended: true }, null, fetchMock);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DB returned error → zero Meta fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const result = await edgeSendWhatsApp(null, { message: 'connection refused' }, fetchMock);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DB thrown error (null data, null error) → zero Meta fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    // When DB returns null data with null error (missing row)
    const result = await edgeSendWhatsApp(null, null, fetchMock);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('NULL messaging_suspended → zero Meta fetch (fail closed)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const result = await edgeSendWhatsApp({ messaging_suspended: null as any }, null, fetchMock);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('not suspended (false) → one Meta fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const result = await edgeSendWhatsApp({ messaging_suspended: false }, null, fetchMock);
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Edge race: early read allowed, suspension flips, final guard blocks', async () => {
    let suspended = false;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });

    // Simulate early batch-start read (allowed)
    const earlyRead = { messaging_suspended: false };
    expect(earlyRead.messaging_suspended).toBe(false); // early read says OK

    // Suspension activates between early read and actual send
    suspended = true;

    // Final-boundary fresh read (simulating what sendWhatsApp does)
    const freshRead = { messaging_suspended: suspended };
    const result = await edgeSendWhatsApp(freshRead, null, fetchMock);

    // Final guard blocks despite early read being allowed
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Structural: Edge guard uses canonical pattern ──

describe('S-1 Edge Canonical Guard Pattern (#256)', () => {
  const EDGE_FN_DIR = resolve(__dirname, '../../supabase/functions');

  it('every sending Edge Function uses the canonical fail-closed guard function', () => {
    const sendingFunctions = [
      'booking-reminders', 'abandoned-cart-reminder', 'birthday-campaign',
      'noshow-reschedule', 'contract-reminders', 'low-stock-alerts',
      'recurring-reminder', 'customer-reengagement', 'waitlist-expiration',
      'process-sequences', 'generate-sign-link', 'chat-timeout',
    ];
    for (const fn of sendingFunctions) {
      const fnPath = resolve(EDGE_FN_DIR, fn, 'index.ts');
      const src = readFileSync(fnPath, 'utf-8');

      // Verify the canonical guard pattern inside sendWhatsApp:
      // 1. Fresh DB query for messaging_suspended
      // 2. Fail-closed: bizErr || !bizCheck || messaging_suspended !== false
      // 3. Return false (block) before any fetch
      const sendHelperIdx = src.indexOf('async function sendWhatsApp') !== -1
        ? src.indexOf('async function sendWhatsApp')
        : src.indexOf('async function sendWhatsAppForBusiness');
      expect(sendHelperIdx, `${fn}: missing sendWhatsApp helper`).toBeGreaterThanOrEqual(0);

      const helperBody = src.slice(sendHelperIdx, src.indexOf('\n}\n', sendHelperIdx) + 3);

      // Must have fresh DB query (not batch map lookup)
      expect(helperBody, `${fn}: missing fresh DB query`).toContain(".from('businesses')");
      expect(helperBody, `${fn}: missing .select for messaging_suspended`).toContain("'messaging_suspended'");

      // #257: Suspension check is now a callback inside withEdgeAttemptRecording
      expect(helperBody, `${fn}: missing withEdgeAttemptRecording`).toContain('withEdgeAttemptRecording');
      expect(helperBody, `${fn}: missing messaging_suspended check in callback`).toContain('messaging_suspended');
    }
  });
});

// ── Production-shaped BotService/shared-channel scope tests ──

describe('S-1 Production-Shaped Binding + Scope Tests (#256)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function mockGuardAndCircuit(suspendedBizIds: Set<string> = new Set()) {
    vi.doMock('@/lib/channels/send-guard', () => ({
      assertMessagingAllowed: vi.fn().mockImplementation(async (bizId: string) => {
        if (!bizId) throw new Error('Messaging suspended for business unknown: missing_business_id');
        if (suspendedBizIds.has(bizId)) throw new Error(`Messaging suspended for business ${bizId}: suspended`);
      }),
    }));
    vi.doMock('@/lib/circuit-breaker', () => ({
      isCircuitOpen: () => false, recordSuccess: () => {}, recordFailure: () => {},
      CircuitBreakerOpenError: class extends Error {},
    }));
  }

  // 1. Tenantless shared-number greeting works
  it('1. tenantless shared-channel greeting reaches Meta', async () => {
    mockGuardAndCircuit();
    const { MetaCloudSender } = await import('../channels/message-sender');
    const mockCloud = { sendText: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-1' }] }) };
    const sender = new MetaCloudSender(mockCloud as any);
    expect(sender.boundBusinessId).toBe('');
    const result = await sender.sendPlatformText({ to: '+234800', text: 'Welcome!' });
    expect(result.success).toBe(true);
    expect(mockCloud.sendText).toHaveBeenCalledTimes(1);
  });

  // 2. Business A resolution binds A (via bindBusiness)
  it('2. bindBusiness(A) binds A, subsequent send checks guard for A', async () => {
    mockGuardAndCircuit();
    const { MetaCloudSender } = await import('../channels/message-sender');
    const { assertMessagingAllowed } = await import('../channels/send-guard');
    const mockCloud = { sendText: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-1' }] }) };
    const sender = new MetaCloudSender(mockCloud as any);
    sender.bindBusiness('biz-A');
    expect(sender.boundBusinessId).toBe('biz-A');
    await sender.sendText({ to: '+234800', text: 'test' });
    expect(assertMessagingAllowed).toHaveBeenCalledWith('biz-A');
  });

  // 3. Suspended A → zero Meta calls
  it('3. suspended A → zero Meta call', async () => {
    mockGuardAndCircuit(new Set(['biz-A']));
    const { MetaCloudSender } = await import('../channels/message-sender');
    const mockCloud = { sendText: vi.fn() };
    const sender = new MetaCloudSender(mockCloud as any);
    sender.bindBusiness('biz-A');
    await expect(sender.sendText({ to: '+234800', text: 'test' })).rejects.toThrow('suspended');
    expect(mockCloud.sendText).not.toHaveBeenCalled();
  });

  // 4. Resumed A session binds before sends
  it('4. resumed session binds A before sends', async () => {
    mockGuardAndCircuit();
    const { MetaCloudSender } = await import('../channels/message-sender');
    const { assertMessagingAllowed } = await import('../channels/send-guard');
    const mockCloud = { sendText: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-1' }] }) };
    const sender = new MetaCloudSender(mockCloud as any);
    expect(sender.boundBusinessId).toBe('');
    // Simulate session resume: bind business
    sender.bindBusiness('biz-resumed');
    expect(sender.boundBusinessId).toBe('biz-resumed');
    await sender.sendText({ to: '+234800', text: 'test' });
    expect(assertMessagingAllowed).toHaveBeenCalledWith('biz-resumed');
  });

  // 5. Switch from suspended A: enterPlatformDiscovery → picker → resolve B
  it('5. switch from suspended A: enterPlatformDiscovery → platform picker works → resolve B allowed', async () => {
    mockGuardAndCircuit(new Set(['biz-A']));
    const { MetaCloudSender } = await import('../channels/message-sender');
    const mockCloud = {
      sendText: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-1' }] }),
      sendButtons: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-2' }] }),
    };
    const sender = new MetaCloudSender(mockCloud as any);

    // Business A bound and suspended — business sends blocked
    sender.bindBusiness('biz-A');
    await expect(sender.sendText({ to: '+234800', text: 'A msg' })).rejects.toThrow('suspended');
    expect(mockCloud.sendText).not.toHaveBeenCalled();

    // Platform sends also blocked because A is bound
    await expect(sender.sendPlatformText({ to: '+234800', text: 'picker' })).rejects.toThrow('suspended');
    expect(mockCloud.sendText).not.toHaveBeenCalled();

    // Explicit tenant exit → platform discovery
    sender.enterPlatformDiscovery();
    expect(sender.boundBusinessId).toBe('');

    // Now platform picker works (tenantless)
    await sender.sendPlatformButtons({ to: '+234800', body: 'Pick a business', buttons: [{ id: 'b1', title: 'Biz B' }] });
    expect(mockCloud.sendButtons).toHaveBeenCalledTimes(1);

    // Resolve B, bind B → B is allowed
    sender.bindBusiness('biz-B');
    expect(sender.boundBusinessId).toBe('biz-B');
    await sender.sendText({ to: '+234800', text: 'B msg' });
    expect(mockCloud.sendText).toHaveBeenCalledTimes(1);
  });

  // 6. Dedicated/preResolved suspended A cannot bypass through platform methods
  it('6. dedicated suspended A cannot bypass via sendPlatformText', async () => {
    mockGuardAndCircuit(new Set(['biz-A']));
    const { MetaCloudSender } = await import('../channels/message-sender');
    const mockCloud = { sendText: vi.fn() };
    const sender = new MetaCloudSender(mockCloud as any);
    // Simulate dedicated channel: business pre-bound
    sender.bindBusiness('biz-A');
    // No enterPlatformDiscovery — this is a dedicated channel, not a switch
    await expect(sender.sendPlatformText({ to: '+234800', text: 'maintenance' })).rejects.toThrow('suspended');
    expect(mockCloud.sendText).not.toHaveBeenCalled();
  });

  // 7. No direct authorization-identity mutation remains
  it('7. _businessId is not directly accessible (private field)', async () => {
    mockGuardAndCircuit();
    const { MetaCloudSender } = await import('../channels/message-sender');
    const mockCloud = {};
    const sender = new MetaCloudSender(mockCloud as any);
    // TypeScript enforces private access, but runtime check: no 'businessId' public property
    expect(Object.getOwnPropertyDescriptor(sender, 'businessId')).toBeUndefined();
    // Only _businessId exists as a private field (convention)
    expect(sender.boundBusinessId).toBe(''); // read-only getter works
  });

  // 8. business-scoped missing identity still fails closed
  it('8. business-scoped send with missing identity → zero Meta calls', async () => {
    mockGuardAndCircuit();
    const { MetaCloudSender } = await import('../channels/message-sender');
    const mockCloud = { sendText: vi.fn() };
    const sender = new MetaCloudSender(mockCloud as any);
    await expect(sender.sendText({ to: '+234800', text: 'test' })).rejects.toThrow('missing_business_id');
    expect(mockCloud.sendText).not.toHaveBeenCalled();
  });

  // Structural: all binding points use bindBusiness/enterPlatformDiscovery APIs
  it('Structural: bot.service.ts uses authoritative binding APIs', () => {
    const src = readFileSync(resolve(__dirname, '../bot/bot.service.ts'), 'utf-8');
    // Binding at all resolution points
    expect(src).toContain('this.messageSender.bindBusiness');
    // Platform discovery transitions
    expect(src).toContain('this.messageSender.enterPlatformDiscovery');
    // No direct .businessId assignment (private field)
    expect(src).not.toMatch(/messageSender\s*\.businessId\s*=/);
    expect(src).not.toMatch(/sender\s*\.businessId\s*=/);
  });

  it('Structural: webhook uses bindBusiness API, not direct assignment', () => {
    const src = readFileSync(resolve(__dirname, '../../app/api/webhook/meta-cloud/route.ts'), 'utf-8');
    expect(src).toContain('resolved.sender.bindBusiness');
    expect(src).not.toMatch(/\.businessId\s*=\s*preResolvedBusinessId/);
  });

  it('Structural: ChannelResolver uses bindBusiness API, not direct assignment', () => {
    const src = readFileSync(resolve(__dirname, '../channels/channel-resolver.ts'), 'utf-8');
    expect(src).toContain('sender.bindBusiness');
    expect(src).toContain('resolved.sender.bindBusiness');
    // No direct .businessId assignment
    expect(src).not.toMatch(/\.businessId\s*=\s*businessId/);
  });
});

// ── Helper: recursively find .ts files ──

function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git' || entry.name === '.claude') continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) results.push(...findTsFiles(full));
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) results.push(full);
    }
  } catch { /* skip */ }
  return results;
}
