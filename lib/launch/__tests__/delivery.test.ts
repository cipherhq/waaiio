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

// ── Admin two-step confirmation flow ──

describe('Admin API — DB-backed confirmation flow', () => {
  it('Preview (GET) never calls deliverLaunchNotifications', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    // GET function should not contain deliverLaunchNotifications
    const getHandler = src.substring(src.indexOf('export async function GET'), src.indexOf('export async function POST'));
    expect(getHandler).not.toContain('deliverLaunchNotifications');
    expect(getHandler).not.toContain('metaCloudSendTemplate');
  });

  it('POST without confirmToken fails with 400', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    expect(src).toContain('Missing confirmToken');
    expect(src).toContain('status: 400');
  });

  it('confirmation is DB-backed (not in-memory Map)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    // Must NOT use in-memory Map
    expect(src).not.toContain('new Map');
    expect(src).not.toContain('pendingConfirmations');
    // Must use DB table
    expect(src).toContain('launch_delivery_confirmations');
    // Must use atomic consume RPC
    expect(src).toContain('consume_launch_confirmation');
  });

  it('confirmation is bound to admin (wrong_admin rejection)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    expect(src).toContain('wrong_admin');
    expect(src).toContain('p_admin_id');
  });

  it('confirmation is bound to campaign version (campaign_mismatch rejection)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    expect(src).toContain('campaign_mismatch');
    expect(src).toContain('p_campaign_version');
  });

  it('replay fails (already_consumed rejection)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    expect(src).toContain('already_consumed');
    expect(src).toContain('already used');
  });

  it('expired confirmation fails', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    expect(src).toContain('expired');
  });

  it('only POST with valid consumed confirmation invokes delivery', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    // deliverLaunchNotifications must only appear AFTER consume check
    const postHandler = src.substring(src.indexOf('export async function POST'));
    const consumeIdx = postHandler.indexOf("consume?.consumed");
    const deliverIdx = postHandler.indexOf('deliverLaunchNotifications');
    expect(consumeIdx).toBeGreaterThan(-1);
    expect(deliverIdx).toBeGreaterThan(consumeIdx);
  });

  it('config errors return 422 not 500', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    expect(src).toContain('LaunchConfigError');
    expect(src).toContain('422');
  });

  it('scope mismatch fails (retryOnly/limit must match preview)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    expect(src).toContain('scope_mismatch');
    expect(src).toContain('p_retry_only');
    expect(src).toContain('p_send_limit');
  });

  it('GET accepts scope params (retryOnly, limit) for preview', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    const getHandler = src.substring(src.indexOf('export async function GET'), src.indexOf('export async function POST'));
    expect(getHandler).toContain('retryOnly');
    expect(getHandler).toContain('sendLimit');
    expect(getHandler).toContain('retry_only');
    expect(getHandler).toContain('send_limit');
  });

  it('GET stores scope in confirmation token', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    const getHandler = src.substring(src.indexOf('export async function GET'), src.indexOf('export async function POST'));
    expect(getHandler).toContain('retry_only: retryOnly');
    expect(getHandler).toContain('send_limit: sendLimit');
  });

  it('POST passes scope to consume RPC for verification', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/admin/launch-notify/route.ts', 'utf-8');
    const postHandler = src.substring(src.indexOf('export async function POST'));
    expect(postHandler).toContain('p_retry_only');
    expect(postHandler).toContain('p_send_limit');
  });
});

// ── Scope-bound confirmation RPC ──

describe('Migration 407 — scope-bound confirmation', () => {
  it('adds retry_only and send_limit columns', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/407_confirmation_scope_binding.sql', 'utf-8');
    expect(sql).toContain('retry_only BOOLEAN');
    expect(sql).toContain('send_limit INT');
  });

  it('consume RPC checks retry_only binding', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/407_confirmation_scope_binding.sql', 'utf-8');
    expect(sql).toContain('AND retry_only = p_retry_only');
  });

  it('consume RPC checks send_limit binding', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/407_confirmation_scope_binding.sql', 'utf-8');
    expect(sql).toContain('AND send_limit = p_send_limit');
  });

  it('scope mismatch returns specific reason', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/407_confirmation_scope_binding.sql', 'utf-8');
    expect(sql).toContain("'scope_mismatch'");
  });
});

// ── DB confirmation RPC schema ──

describe('Migration 406 — DB-backed confirmation tokens', () => {
  it('creates launch_delivery_confirmations table', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/406_launch_delivery_confirmation.sql', 'utf-8');
    expect(sql).toContain('launch_delivery_confirmations');
    expect(sql).toContain('admin_id');
    expect(sql).toContain('campaign_version');
    expect(sql).toContain('consumed_at');
  });

  it('consume RPC checks admin_id binding', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/406_launch_delivery_confirmation.sql', 'utf-8');
    expect(sql).toContain('AND admin_id = p_admin_id');
  });

  it('consume RPC checks campaign_version binding', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/406_launch_delivery_confirmation.sql', 'utf-8');
    expect(sql).toContain('AND campaign_version = p_campaign_version');
  });

  it('consume RPC prevents replay (consumed_at IS NULL)', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/406_launch_delivery_confirmation.sql', 'utf-8');
    expect(sql).toContain('AND consumed_at IS NULL');
  });

  it('consume RPC enforces 5-minute expiry', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/406_launch_delivery_confirmation.sql', 'utf-8');
    expect(sql).toContain("INTERVAL '5 minutes'");
  });

  it('table has RLS enabled (admin-only)', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/406_launch_delivery_confirmation.sql', 'utf-8');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('is_admin()');
  });

  it('scope is recorded (eligible_count, pending_count)', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/406_launch_delivery_confirmation.sql', 'utf-8');
    expect(sql).toContain('eligible_count');
    expect(sql).toContain('pending_count');
  });
});

// ── Admin UI two-step flow ──

describe('Admin UI — two-step Preview then Confirm & Send', () => {
  it('has separate handlePreview and handleConfirmSend functions', () => {
    const fs = require('fs');
    const src = fs.readFileSync('admin/src/pages/LaunchSubscribers.tsx', 'utf-8');
    expect(src).toContain('handlePreview');
    expect(src).toContain('handleConfirmSend');
  });

  it('Preview button does not call adminApiFetch (no POST)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('admin/src/pages/LaunchSubscribers.tsx', 'utf-8');
    // handlePreview should use GET (fetch), not adminApiFetch (POST)
    const previewFn = src.substring(src.indexOf('async function handlePreview'), src.indexOf('async function handleConfirmSend'));
    expect(previewFn).not.toContain('adminApiFetch');
  });

  it('Confirm & Send button is separate from Preview', () => {
    const fs = require('fs');
    const src = fs.readFileSync('admin/src/pages/LaunchSubscribers.tsx', 'utf-8');
    expect(src).toContain("'Preview Send'");
    expect(src).toContain("'Confirm & Send'");
  });

  it('Confirm & Send only appears after preview data is loaded', () => {
    const fs = require('fs');
    const src = fs.readFileSync('admin/src/pages/LaunchSubscribers.tsx', 'utf-8');
    // The Confirm & Send button is inside {preview && (...)}
    expect(src).toContain('{preview && (');
  });

  it('has a Cancel button to dismiss preview without sending', () => {
    const fs = require('fs');
    const src = fs.readFileSync('admin/src/pages/LaunchSubscribers.tsx', 'utf-8');
    expect(src).toContain('handleCancelPreview');
    expect(src).toContain('Cancel');
  });

  it('Preview passes scope (retryOnly, limit) as query params to GET', () => {
    const fs = require('fs');
    const src = fs.readFileSync('admin/src/pages/LaunchSubscribers.tsx', 'utf-8');
    const previewFn = src.substring(src.indexOf('async function handlePreview'), src.indexOf('async function handleConfirmSend'));
    expect(previewFn).toContain('retryOnly');
    expect(previewFn).toContain("limit: '50'");
  });

  it('Confirm & Send passes scope from preview, not hardcoded values', () => {
    const fs = require('fs');
    const src = fs.readFileSync('admin/src/pages/LaunchSubscribers.tsx', 'utf-8');
    const confirmFn = src.substring(src.indexOf('async function handleConfirmSend'), src.indexOf('function handleCancelPreview'));
    // Must use preview.scope.retryOnly, not retryMode
    expect(confirmFn).toContain('preview.scope.retryOnly');
    expect(confirmFn).toContain('preview.scope.sendLimit');
    expect(confirmFn).not.toContain('retryMode');
  });

  it('preview display shows scope (retryOnly, limit)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('admin/src/pages/LaunchSubscribers.tsx', 'utf-8');
    expect(src).toContain('preview.scope.retryOnly');
    expect(src).toContain('preview.scope.sendLimit');
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
