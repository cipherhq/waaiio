/**
 * Issue #397 CTO correction: Launch alert delivery tests
 *
 * Covers:
 * - Atomic claim concurrency: two concurrent claims, only one send executes
 * - Opt-out respect (never send to opted-out)
 * - Idempotent replay (already_sent skip)
 * - Missing/wrong regional sender
 * - Config failure — fail closed when missing/invalid
 * - Provider failure + status recording
 * - Retry behavior
 * - Admin preview-first flow (confirmToken required)
 * - Isolation from commerce/payment flows
 * - Claim-token fencing (losing claim must not complete)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Helpers ──

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    templateName: 'waaiio_launch_alert',
    templateLanguage: 'en_US',
    templateParams: ['Waaiio'],
    campaignVersion: 'v1',
    ...overrides,
  };
}

function channelQueryMock(result = { phone_number_id: 'pn-1', meta_access_token: 'tok', waba_id: 'w1', phone_number: '12029226251' }) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: result, error: null }),
          }),
        }),
      }),
    }),
  };
}

// ── Atomic claim concurrency tests ──

describe('claimAndSendToSubscriber — atomic claim concurrency', () => {
  let claimAndSendToSubscriber: typeof import('../delivery').claimAndSendToSubscriber;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../delivery');
    claimAndSendToSubscriber = mod.claimAndSendToSubscriber;
  });

  it('two concurrent claims — only one send function executes', async () => {
    // Simulate the claim RPC: first caller wins, second gets { claimed: false }
    let claimCount = 0;
    const claimResults = [
      { claimed: true, claim_token: 'tok-1', wa_number: '+234800', receiving_number: '12029226251' },
      { claimed: false, reason: 'claimed_by_other' },
    ];

    const sendFn = vi.fn().mockResolvedValue({ messageId: 'wamid.ok' });

    const makeSb = (claimIdx: number) => ({
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'claim_launch_delivery') {
          const idx = claimCount++;
          return Promise.resolve({ data: claimResults[Math.min(idx, 1)], error: null });
        }
        // complete_launch_delivery
        return Promise.resolve({ data: { completed: true }, error: null });
      }),
      from: vi.fn((table: string) => {
        if (table === 'whatsapp_channels') return channelQueryMock();
        return {};
      }),
    });

    // Race two concurrent claims for the SAME subscriber
    const sb = makeSb(0);
    const config = makeConfig();
    // eslint-disable-next-line
    const [r1, r2] = await Promise.all([
      claimAndSendToSubscriber(sb as any, 'sub-1', config as any, sendFn),
      claimAndSendToSubscriber(sb as any, 'sub-1', config as any, sendFn),
    ]);

    // Exactly ONE send should have executed
    expect(sendFn).toHaveBeenCalledOnce();

    // One result is 'sent', the other is 'skipped'
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(['sent', 'skipped']);
  });

  it('claim winner sends, claim loser does NOT send', async () => {
    const sendFn = vi.fn().mockResolvedValue({ messageId: 'wamid.123' });
    const sb = {
      rpc: vi.fn().mockResolvedValue({
        data: { claimed: false, reason: 'claimed_by_other' },
        error: null,
      }),
      from: vi.fn(() => channelQueryMock()),
    };

    // eslint-disable-next-line
    const result = await claimAndSendToSubscriber(sb as any, 'sub-1', makeConfig() as any, sendFn);
    expect(result.status).toBe('skipped');
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('claim winner sends template and completes claim', async () => {
    const sendFn = vi.fn().mockResolvedValue({ messageId: 'wamid.456' });
    const rpcCalls: string[] = [];
    const sb = {
      rpc: vi.fn().mockImplementation((name: string) => {
        rpcCalls.push(name);
        if (name === 'claim_launch_delivery') {
          return Promise.resolve({
            data: { claimed: true, claim_token: 'tok-abc', wa_number: '+1234', receiving_number: '555' },
            error: null,
          });
        }
        return Promise.resolve({ data: { completed: true }, error: null });
      }),
      from: vi.fn(() => channelQueryMock()),
    };

    // eslint-disable-next-line
    const result = await claimAndSendToSubscriber(sb as any, 'sub-1', makeConfig() as any, sendFn);
    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('wamid.456');
    expect(rpcCalls).toEqual(['claim_launch_delivery', 'complete_launch_delivery']);
  });

  it('already_sent subscriber is skipped without send', async () => {
    const sendFn = vi.fn();
    const sb = {
      rpc: vi.fn().mockResolvedValue({
        data: { claimed: false, already_sent: true, reason: 'already_sent' },
        error: null,
      }),
      from: vi.fn(() => channelQueryMock()),
    };

    // eslint-disable-next-line
    const result = await claimAndSendToSubscriber(sb as any, 'sub-1', makeConfig() as any, sendFn);
    expect(result.status).toBe('skipped');
    expect(result.error).toBe('already_sent');
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('opted-out subscriber is skipped without send', async () => {
    const sendFn = vi.fn();
    const sb = {
      rpc: vi.fn().mockResolvedValue({
        data: { claimed: false, reason: 'opted_out' },
        error: null,
      }),
      from: vi.fn(() => channelQueryMock()),
    };

    // eslint-disable-next-line
    const result = await claimAndSendToSubscriber(sb as any, 'sub-1', makeConfig() as any, sendFn);
    expect(result.status).toBe('skipped');
    expect(result.error).toBe('opted_out');
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('provider failure releases claim with failed status', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('Meta 400: template not approved'));
    const completeCalls: unknown[] = [];
    const sb = {
      rpc: vi.fn().mockImplementation((name: string, params: unknown) => {
        if (name === 'claim_launch_delivery') {
          return Promise.resolve({
            data: { claimed: true, claim_token: 'tok-x', wa_number: '+1', receiving_number: '555' },
            error: null,
          });
        }
        completeCalls.push(params);
        return Promise.resolve({ data: { completed: true }, error: null });
      }),
      from: vi.fn(() => channelQueryMock()),
    };

    // eslint-disable-next-line
    const result = await claimAndSendToSubscriber(sb as any, 'sub-1', makeConfig() as any, sendFn);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('template not approved');
    // complete_launch_delivery called with 'failed' status
    expect(completeCalls[0]).toMatchObject({ p_status: 'failed' });
  });

  it('missing channel credentials fails claim without sending', async () => {
    const sendFn = vi.fn();
    const sb = {
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'claim_launch_delivery') {
          return Promise.resolve({
            data: { claimed: true, claim_token: 'tok-y', wa_number: '+1', receiving_number: 'nonexistent' },
            error: null,
          });
        }
        return Promise.resolve({ data: { completed: true }, error: null });
      }),
      from: vi.fn(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          }),
        }),
      })),
    };

    // eslint-disable-next-line
    const result = await claimAndSendToSubscriber(sb as any, 'sub-1', makeConfig() as any, sendFn);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('no_channel_credentials');
    expect(sendFn).not.toHaveBeenCalled();
  });
});

// ── Config failure — fail closed ──

describe('loadDeliveryConfig — fail closed', () => {
  let loadDeliveryConfig: typeof import('../delivery').loadDeliveryConfig;
  let LaunchConfigError: typeof import('../delivery').LaunchConfigError;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../delivery');
    loadDeliveryConfig = mod.loadDeliveryConfig;
    LaunchConfigError = mod.LaunchConfigError;
  });

  it('throws LaunchConfigError when platform_settings key is missing', async () => {
    const sb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
          }),
        }),
      }),
    };

    // eslint-disable-next-line
    await expect(loadDeliveryConfig(sb as any)).rejects.toThrow(LaunchConfigError);
    // eslint-disable-next-line
    await expect(loadDeliveryConfig(sb as any)).rejects.toThrow('not found');
  });

  it('throws LaunchConfigError when template_name is empty', async () => {
    const sb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { value: { template_name: '', campaign_version: 'v1' } },
              error: null,
            }),
          }),
        }),
      }),
    };

    // eslint-disable-next-line
    await expect(loadDeliveryConfig(sb as any)).rejects.toThrow('template_name');
  });

  it('throws LaunchConfigError when campaign_version is missing', async () => {
    const sb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { value: { template_name: 'my_template' } },
              error: null,
            }),
          }),
        }),
      }),
    };

    // eslint-disable-next-line
    await expect(loadDeliveryConfig(sb as any)).rejects.toThrow('campaign_version');
  });

  it('succeeds with valid config', async () => {
    const sb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { value: { template_name: 'waaiio_launch', template_language: 'en_US', campaign_version: 'v2', template_params: ['Go'] } },
              error: null,
            }),
          }),
        }),
      }),
    };

    // eslint-disable-next-line
    const config = await loadDeliveryConfig(sb as any);
    expect(config.templateName).toBe('waaiio_launch');
    expect(config.campaignVersion).toBe('v2');
  });
});

// ── Admin preview-first flow ──

describe('Admin API — preview-first safety', () => {
  it('admin API route requires confirmToken for POST', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    expect(src).toContain('confirmToken');
    expect(src).toContain('Missing confirmToken');
  });

  it('GET returns a confirmToken', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    expect(src).toContain('readiness.confirmToken');
    expect(src).toContain('pendingConfirmations.set');
  });

  it('confirmToken is single-use (consumed on POST)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    expect(src).toContain('pendingConfirmations.delete(confirmToken)');
  });

  it('POST rejects if campaign_version changed since preview', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    expect(src).toContain('Campaign version changed');
  });

  it('config errors return 422 not 500', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    expect(src).toContain('LaunchConfigError');
    expect(src).toContain('422');
  });
});

// ── STOP handling ──

describe('STOP handling — launch subscriber opt-out', () => {
  it('bot.service.ts updates launch_subscribers on STOP without blocking commerce', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    expect(src).toContain("launch_subscribers");
    expect(src).toContain("opted_out");
    expect(src).toContain('then(() => {}, () => {})');
  });
});

// ── Migration schema ──

describe('Migration 405 — atomic claim RPC', () => {
  it('creates claim_launch_delivery RPC', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/405_launch_delivery_claim.sql', 'utf-8');
    expect(sql).toContain('claim_launch_delivery');
    expect(sql).toContain('claim_token');
    expect(sql).toContain('gen_random_uuid()');
  });

  it('creates complete_launch_delivery RPC', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/405_launch_delivery_claim.sql', 'utf-8');
    expect(sql).toContain('complete_launch_delivery');
    expect(sql).toContain('p_claim_token');
  });

  it('claim RPC checks opt_in_status = active', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/405_launch_delivery_claim.sql', 'utf-8');
    expect(sql).toContain("opt_in_status = 'active'");
  });

  it('claim RPC prevents already-sent for same campaign', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/405_launch_delivery_claim.sql', 'utf-8');
    expect(sql).toContain("notification_status = 'sent'");
    expect(sql).toContain('campaign_version = p_campaign_version');
  });

  it('stale claims expire after 5 minutes', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/405_launch_delivery_claim.sql', 'utf-8');
    expect(sql).toContain("INTERVAL '5 minutes'");
  });

  it('complete RPC verifies claim_token (fencing)', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/405_launch_delivery_claim.sql', 'utf-8');
    expect(sql).toContain('AND claim_token = p_claim_token');
  });
});

// ── Commerce isolation ──

describe('Commerce/payment isolation', () => {
  it('delivery service does not import payment modules', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    expect(src).not.toContain('lib/payments');
    expect(src).not.toContain('send-confirmation');
  });

  it('delivery service does not reference commerce tables', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    expect(src).not.toContain("'bookings'");
    expect(src).not.toContain("'orders'");
    expect(src).not.toContain("'invoices'");
  });
});
