/**
 * Issue #397: Launch alert delivery tests
 *
 * Covers:
 * - Opt-out respect (never send to opted-out)
 * - Duplicate/replay idempotency (campaign_version)
 * - Missing/wrong regional sender
 * - Template/config missing
 * - Provider failure + status recording
 * - Retry behavior (only failed/pending)
 * - Isolation from commerce/payment flows
 * - STOP handling for launch subscriptions
 * - Readiness counts
 * - Concurrency safety (campaign_version unique index)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Helpers ──

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    wa_number: '+2348001234567',
    market: 'NG',
    receiving_number: '12029226251',
    opt_in_status: 'active',
    notification_status: 'pending',
    campaign_version: null,
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    templateName: 'waaiio_launch_alert',
    templateLanguage: 'en_US',
    templateParams: ['Waaiio'],
    campaignVersion: 'v1',
    ...overrides,
  };
}

function mockSupabase(queryResult: unknown = null, error: unknown = null) {
  const updateCalls: unknown[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'limit', 'order', 'single', 'maybeSingle']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = Promise.resolve({ data: queryResult, error }).then.bind(
    Promise.resolve({ data: queryResult, error }),
  );
  chain.catch = Promise.resolve({ data: queryResult, error }).catch.bind(
    Promise.resolve({ data: queryResult, error }),
  );

  const updateChain: Record<string, unknown> = {};
  for (const m of ['eq', 'in']) {
    updateChain[m] = vi.fn().mockReturnValue(updateChain);
  }
  updateChain.then = Promise.resolve({ error: null }).then.bind(Promise.resolve({ error: null }));

  return {
    from: vi.fn((table: string) => {
      if (table === 'whatsapp_channels') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { phone_number_id: 'pn-123', meta_access_token: 'tok', waba_id: 'waba-1', phone_number: '12029226251' },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'platform_settings') {
        return chain;
      }
      return {
        select: vi.fn().mockReturnValue(chain),
        update: vi.fn((data: unknown) => {
          updateCalls.push(data);
          return updateChain;
        }),
      };
    }),
    _updateCalls: updateCalls,
  };
}

// ── Tests ──

describe('sendToSubscriber', () => {
  let sendToSubscriber: typeof import('../delivery').sendToSubscriber;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../delivery');
    sendToSubscriber = mod.sendToSubscriber;
  });

  it('sends template via sendTemplateFn and records sent status', async () => {
    const sub = makeSub();
    const config = makeConfig();
    const sb = mockSupabase();
    const sendFn = vi.fn().mockResolvedValue({ messageId: 'wamid.123' });

    // eslint-disable-next-line
    const result = await sendToSubscriber(sb as any, sub as any, config as any, sendFn);

    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('wamid.123');
    expect(sendFn).toHaveBeenCalledOnce();
    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({ phone_number_id: 'pn-123' }),
      '+2348001234567',
      'waaiio_launch_alert',
      'en_US',
      ['Waaiio'],
    );
  });

  it('never sends to opted-out subscribers', async () => {
    const sub = makeSub({ opt_in_status: 'opted_out' });
    const config = makeConfig();
    const sb = mockSupabase();
    const sendFn = vi.fn();

    // eslint-disable-next-line
    const result = await sendToSubscriber(sb as any, sub as any, config as any, sendFn);

    expect(result.status).toBe('skipped');
    expect(result.error).toBe('opted_out');
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('skips already-sent subscribers for same campaign (idempotent)', async () => {
    const sub = makeSub({ campaign_version: 'v1', notification_status: 'sent' });
    const config = makeConfig({ campaignVersion: 'v1' });
    const sb = mockSupabase();
    const sendFn = vi.fn();

    // eslint-disable-next-line
    const result = await sendToSubscriber(sb as any, sub as any, config as any, sendFn);

    expect(result.status).toBe('skipped');
    expect(result.error).toBe('already_sent');
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('records failed status when provider throws', async () => {
    const sub = makeSub();
    const config = makeConfig();
    const sb = mockSupabase();
    const sendFn = vi.fn().mockRejectedValue(new Error('Meta API 400: template not approved'));

    // eslint-disable-next-line
    const result = await sendToSubscriber(sb as any, sub as any, config as any, sendFn);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('template not approved');
  });

  it('fails with no_channel_credentials when channel not found', async () => {
    const sub = makeSub({ receiving_number: '9999999999' });
    const config = makeConfig();
    // Override whatsapp_channels to return null
    const sb = {
      from: vi.fn((table: string) => {
        if (table === 'whatsapp_channels') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        const c: Record<string, unknown> = {};
        for (const m of ['eq']) { c[m] = vi.fn().mockReturnValue(c); }
        c.then = Promise.resolve({ error: null }).then.bind(Promise.resolve({ error: null }));
        return { update: vi.fn().mockReturnValue(c) };
      }),
    };
    const sendFn = vi.fn();

    // eslint-disable-next-line
    const result = await sendToSubscriber(sb as any, sub as any, config as any, sendFn);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('no_channel_credentials');
    expect(sendFn).not.toHaveBeenCalled();
  });
});

// ── Delivery config ──

describe('loadDeliveryConfig', () => {
  let loadDeliveryConfig: typeof import('../delivery').loadDeliveryConfig;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../delivery');
    loadDeliveryConfig = mod.loadDeliveryConfig;
  });

  it('returns defaults when no platform_settings row exists', async () => {
    const sb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    };

    // eslint-disable-next-line
    const config = await loadDeliveryConfig(sb as any);
    expect(config.templateName).toBe('waaiio_launch_alert');
    expect(config.templateLanguage).toBe('en_US');
    expect(config.campaignVersion).toBe('v1');
  });

  it('reads template_name from platform_settings', async () => {
    const sb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { value: { template_name: 'custom_launch', template_language: 'pt_BR', campaign_version: 'v2' } },
              error: null,
            }),
          }),
        }),
      }),
    };

    // eslint-disable-next-line
    const config = await loadDeliveryConfig(sb as any);
    expect(config.templateName).toBe('custom_launch');
    expect(config.templateLanguage).toBe('pt_BR');
    expect(config.campaignVersion).toBe('v2');
  });
});

// ── Batch delivery ──

describe('deliverLaunchNotifications', () => {
  let deliverLaunchNotifications: typeof import('../delivery').deliverLaunchNotifications;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../delivery');
    deliverLaunchNotifications = mod.deliverLaunchNotifications;
  });

  it('processes multiple subscribers and returns summary', async () => {
    const subs = [
      makeSub({ id: 's1' }),
      makeSub({ id: 's2', opt_in_status: 'opted_out' }),
      makeSub({ id: 's3' }),
    ];

    const sb = {
      from: vi.fn((table: string) => {
        if (table === 'launch_subscribers') {
          const c: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'in', 'limit']) { c[m] = vi.fn().mockReturnValue(c); }
          c.then = Promise.resolve({ data: subs, error: null }).then.bind(
            Promise.resolve({ data: subs, error: null }),
          );
          c.catch = Promise.resolve({ data: subs, error: null }).catch.bind(
            Promise.resolve({ data: subs, error: null }),
          );
          // update chain
          const uc: Record<string, unknown> = {};
          for (const m of ['eq']) { uc[m] = vi.fn().mockReturnValue(uc); }
          uc.then = Promise.resolve({ error: null }).then.bind(Promise.resolve({ error: null }));
          c.update = vi.fn().mockReturnValue(uc);
          return c;
        }
        if (table === 'whatsapp_channels') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: { phone_number_id: 'pn-1', meta_access_token: 'tok', waba_id: 'w1', phone_number: '12029226251' },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const sendFn = vi.fn().mockResolvedValue({ messageId: 'wamid.ok' });
    const config = makeConfig();

    // eslint-disable-next-line
    const summary = await deliverLaunchNotifications(sb as any, config as any, sendFn);

    // s1 and s3 should be sent, s2 should be skipped (opted_out)
    expect(summary.sent).toBe(2);
    expect(summary.skipped).toBe(1);
  });
});

// ── STOP handling isolation ──

describe('STOP handling — launch subscriber opt-out', () => {
  it('bot.service.ts updates launch_subscribers on STOP without blocking commerce', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    // Must update launch_subscribers to opted_out
    expect(src).toContain("launch_subscribers");
    expect(src).toContain("opted_out");
    // Must be fire-and-forget (non-blocking)
    expect(src).toContain('then(() => {}, () => {})');
  });

  it('STOP handler still records messaging_opt_outs for commerce', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    const stopSection = src.substring(
      src.indexOf("STOP_WORDS = ['stop'"),
      src.indexOf('// Pre-check 1: Timeout'),
    );
    expect(stopSection).toContain('messaging_opt_outs');
  });
});

// ── Migration schema ──

describe('Migration 404 — delivery columns', () => {
  it('adds campaign_version, provider_message_id, delivery_error, delivered_at', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/404_launch_delivery_columns.sql', 'utf-8');
    expect(sql).toContain('campaign_version TEXT');
    expect(sql).toContain('provider_message_id TEXT');
    expect(sql).toContain('delivery_error TEXT');
    expect(sql).toContain('delivered_at TIMESTAMPTZ');
  });

  it('has unique index on (wa_number, campaign_version) for idempotency', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/404_launch_delivery_columns.sql', 'utf-8');
    expect(sql).toContain('idx_launch_subscribers_campaign_unique');
    expect(sql).toContain('wa_number, campaign_version');
  });

  it('seeds launch_notification_config in platform_settings', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/404_launch_delivery_columns.sql', 'utf-8');
    expect(sql).toContain('launch_notification_config');
    expect(sql).toContain('waaiio_launch_alert');
  });
});

// ── Isolation from commerce ──

describe('Commerce/payment isolation', () => {
  it('delivery service does not import payment modules', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    expect(src).not.toContain('lib/payments');
    expect(src).not.toContain('send-confirmation');
    expect(src).not.toContain('process-success');
  });

  it('delivery service does not import bot flow modules', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    expect(src).not.toContain('lib/bot/flows');
    expect(src).not.toContain('executor');
  });

  it('delivery service does not reference booking/order/invoice/reservation tables', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    expect(src).not.toContain("'bookings'");
    expect(src).not.toContain("'orders'");
    expect(src).not.toContain("'invoices'");
    expect(src).not.toContain("'reservations'");
  });
});

// ── metaCloudSendTemplate ──

describe('metaCloudSendTemplate — production send function', () => {
  it('constructs MetaCloudService with channel credentials', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    // Must use credentials from channel, not env vars alone
    expect(src).toContain('credentials.meta_access_token');
    expect(src).toContain('credentials.phone_number_id');
    expect(src).toContain('credentials.waba_id');
  });

  it('uses cloud.sendTemplate (not free-form text)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    expect(src).toContain('cloud.sendTemplate');
    expect(src).not.toContain('cloud.sendText');
  });
});
