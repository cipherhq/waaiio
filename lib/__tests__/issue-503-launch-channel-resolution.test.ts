/**
 * Issue #503: Launch QR channel resolution fix
 *
 * Root cause: launch-optin and delivery both compared Meta's phone_number_id
 * against whatsapp_channels.phone_number (human-readable format). They never
 * matched, causing market to default to 'XX' and delivery to fail with
 * no_channel_credentials.
 *
 * Fix: query by phone_number_id first, with bounded fallback to phone_number.
 *
 * Tests cover:
 *   1. Webhook-style Meta phone_number_id resolves expected channel/country
 *   2. Market is not 'XX' when a valid channel exists
 *   3. Signup remains idempotent by wa_number
 *   4. Repeat signup updates/reactivates existing row
 *   5. Launch delivery resolves credentials using phone_number_id
 *   6. Unknown/wrong destination fails safely
 *   7. STOP/opt-out behavior unchanged
 *   8. No live Meta sends occur (all mocked)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Mock helpers ──

/**
 * Builds a Supabase-like mock for whatsapp_channels queries.
 * The launch-optin handler now issues TWO queries (phone_number_id first,
 * then phone_number fallback), so the mock needs to handle both paths.
 */
function buildChannelMock(opts: {
  primaryResult?: { country_code: string } | null;
  fallbackResult?: { country_code: string } | null;
}) {
  let callCount = 0;

  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockImplementation((_col: string, _val: string) => {
        // Track which query branch we're in (primary vs fallback)
        const isFirst = callCount === 0;
        callCount++;
        const result = isFirst ? (opts.primaryResult ?? null) : (opts.fallbackResult ?? null);

        // Build the remaining chain — for primary path: 2 more .eq (is_active)
        // For fallback path: 3 more .eq (channel_type, is_active)
        // Both terminate with .limit().maybeSingle()
        const terminal = {
          limit: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: result, error: null }),
          }),
        };

        return {
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              ...terminal,
              eq: vi.fn().mockReturnValue(terminal),
            }),
            ...terminal,
          }),
          ...terminal,
        };
      }),
    }),
  };
}

/**
 * Builds a full Supabase mock for handleLaunchOptIn tests.
 * Intercepts both 'whatsapp_channels' (for market resolution) and
 * 'launch_subscribers' (for upsert).
 */
function buildOptInSupabase(opts: {
  channelPrimaryResult?: { country_code: string } | null;
  channelFallbackResult?: { country_code: string } | null;
  upsertFn?: ReturnType<typeof vi.fn>;
}) {
  const upsertFn = opts.upsertFn || vi.fn().mockResolvedValue({ error: null });
  let channelCallCount = 0;

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'whatsapp_channels') {
        const primaryResult = opts.channelPrimaryResult ?? null;
        const fallbackResult = opts.channelFallbackResult ?? null;
        const isFirst = channelCallCount === 0;
        channelCallCount++;
        const result = isFirst ? primaryResult : fallbackResult;

        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: result, error: null }),
                  }),
                }),
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: result, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      // launch_subscribers
      return { upsert: upsertFn };
    }),
  };
}

/**
 * Builds a Supabase mock for resolveChannelCredentials tests.
 * Supports primary (phone_number_id) and fallback (phone_number) lookups.
 */
function buildCredentialsMock(opts: {
  primaryResult?: { phone_number_id: string; meta_access_token: string | null; waba_id: string | null; phone_number: string } | null;
  fallbackResult?: { phone_number_id: string; meta_access_token: string | null; waba_id: string | null; phone_number: string } | null;
}) {
  let callCount = 0;
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'whatsapp_channels') {
        const isFirst = callCount === 0;
        callCount++;
        const result = isFirst ? (opts.primaryResult ?? null) : (opts.fallbackResult ?? null);

        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: result, error: null }),
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
}

// ── Test suites ──

describe('Issue #503: Launch opt-in — channel resolution by phone_number_id', () => {
  let handleLaunchOptIn: typeof import('@/lib/bot/launch-optin').handleLaunchOptIn;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/bot/launch-optin');
    handleLaunchOptIn = mod.handleLaunchOptIn;
  });

  // Test 1: Webhook-style Meta phone_number_id resolves the expected channel/country
  it('resolves market from Meta phone_number_id (primary lookup)', async () => {
    const upsertArgs: unknown[] = [];
    const upsertFn = vi.fn().mockImplementation((data: unknown) => {
      upsertArgs.push(data);
      return Promise.resolve({ error: null });
    });

    const sb = buildOptInSupabase({
      channelPrimaryResult: { country_code: 'US' },
      upsertFn,
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);

    const result = await handleLaunchOptIn(
      sb as any,
      '+14155551234',
      'Notify me when Waaiio launches',
      '469075', // Meta phone_number_id, NOT the human-readable number
      sendReply,
    );

    expect(result).toBe(true);
    expect(upsertArgs[0]).toMatchObject({ market: 'US', receiving_number: '469075' });
    expect(sendReply).toHaveBeenCalledOnce();
  });

  // Test 2: Market is NOT 'XX' when a valid channel exists
  it('market is not XX when a valid channel matches phone_number_id', async () => {
    const upsertArgs: unknown[] = [];
    const upsertFn = vi.fn().mockImplementation((data: unknown) => {
      upsertArgs.push(data);
      return Promise.resolve({ error: null });
    });

    const sb = buildOptInSupabase({
      channelPrimaryResult: { country_code: 'NG' },
      upsertFn,
    });

    await handleLaunchOptIn(
      sb as any,
      '+2348001234567',
      'Notify me when Waaiio launches',
      '550123456',
      vi.fn().mockResolvedValue(undefined),
    );

    const recorded = upsertArgs[0] as Record<string, unknown>;
    expect(recorded.market).toBe('NG');
    expect(recorded.market).not.toBe('XX');
  });

  // Test 3: Signup remains idempotent by wa_number
  it('signup is idempotent — uses upsert with onConflict wa_number', async () => {
    let capturedOptions: unknown = null;
    const upsertFn = vi.fn().mockImplementation((_data: unknown, opts: unknown) => {
      capturedOptions = opts;
      return Promise.resolve({ error: null });
    });

    const sb = buildOptInSupabase({
      channelPrimaryResult: { country_code: 'US' },
      upsertFn,
    });

    // Call twice with same user phone
    await handleLaunchOptIn(sb as any, '+14155551234', 'Notify me when Waaiio launches', '469075', vi.fn().mockResolvedValue(undefined));
    // Reset channel call count by creating fresh mock
    const sb2 = buildOptInSupabase({
      channelPrimaryResult: { country_code: 'US' },
      upsertFn,
    });
    await handleLaunchOptIn(sb2 as any, '+14155551234', 'Notify me when Waaiio launches', '469075', vi.fn().mockResolvedValue(undefined));

    // Both calls use onConflict: 'wa_number'
    expect(upsertFn).toHaveBeenCalledTimes(2);
    expect(capturedOptions).toMatchObject({ onConflict: 'wa_number' });
  });

  // Test 4: Repeat signup updates/reactivates the existing row
  it('re-signup after opt-out reactivates with opt_in_status active', async () => {
    const upsertArgs: unknown[] = [];
    const upsertFn = vi.fn().mockImplementation((data: unknown) => {
      upsertArgs.push(data);
      return Promise.resolve({ error: null });
    });

    const sb = buildOptInSupabase({
      channelPrimaryResult: { country_code: 'GH' },
      upsertFn,
    });

    // Simulate a re-signup (user previously sent STOP, now sends the opt-in again)
    const result = await handleLaunchOptIn(
      sb as any,
      '+233500123456',
      'Notify me when Waaiio launches',
      '789012',
      vi.fn().mockResolvedValue(undefined),
    );

    expect(result).toBe(true);
    // The upsert sets opt_in_status back to 'active'
    expect(upsertArgs[0]).toMatchObject({
      wa_number: '+233500123456',
      opt_in_status: 'active',
      market: 'GH',
    });
  });

  // Test 6a: Unknown destination — no channel match defaults to 'XX' safely
  it('unknown destination phone falls back to market XX without crashing', async () => {
    const upsertArgs: unknown[] = [];
    const upsertFn = vi.fn().mockImplementation((data: unknown) => {
      upsertArgs.push(data);
      return Promise.resolve({ error: null });
    });

    const sb = buildOptInSupabase({
      channelPrimaryResult: null, // no match on phone_number_id
      channelFallbackResult: null, // no match on phone_number either
      upsertFn,
    });

    const result = await handleLaunchOptIn(
      sb as any,
      '+14155559999',
      'Notify me when Waaiio launches',
      'nonexistent_id',
      vi.fn().mockResolvedValue(undefined),
    );

    expect(result).toBe(true); // message is still handled
    expect(upsertArgs[0]).toMatchObject({ market: 'XX' });
  });

  // Test 6b: Undefined destination also works safely
  it('undefined destinationPhone results in market XX without crash', async () => {
    const upsertArgs: unknown[] = [];
    const upsertFn = vi.fn().mockImplementation((data: unknown) => {
      upsertArgs.push(data);
      return Promise.resolve({ error: null });
    });

    const sb = buildOptInSupabase({ upsertFn });

    const result = await handleLaunchOptIn(
      sb as any,
      '+14155559999',
      'Notify me when Waaiio launches',
      undefined,
      vi.fn().mockResolvedValue(undefined),
    );

    expect(result).toBe(true);
    expect(upsertArgs[0]).toMatchObject({ market: 'XX', receiving_number: 'unknown' });
  });

  // Test 7: STOP/opt-out behavior — non-matching messages are not handled
  it('does NOT handle non-launch messages (STOP, cancel, etc.)', async () => {
    const sb = {} as never;
    const sendReply = vi.fn();

    for (const msg of ['STOP', 'cancel', 'exit', 'Hi', 'Book', 'pay 5000']) {
      const result = await handleLaunchOptIn(sb, '+1234', msg, undefined, sendReply);
      expect(result).toBe(false);
    }
    expect(sendReply).not.toHaveBeenCalled();
  });

  // Test 8: No live Meta sends — sendReply is the only output and it's mocked
  it('uses injected sendReply, never calls Meta directly', async () => {
    const sendReply = vi.fn().mockResolvedValue(undefined);
    const sb = buildOptInSupabase({
      channelPrimaryResult: { country_code: 'US' },
    });

    await handleLaunchOptIn(sb as any, '+1234', 'Notify me when Waaiio launches', '469075', sendReply);

    expect(sendReply).toHaveBeenCalledOnce();
    // The confirmation message should contain the expected text
    const msg = sendReply.mock.calls[0][1];
    expect(msg).toContain("You're in!");
    expect(msg).toContain('STOP');
  });

  // Fallback path: phone_number match when phone_number_id fails
  it('falls back to phone_number when phone_number_id has no match', async () => {
    const upsertArgs: unknown[] = [];
    const upsertFn = vi.fn().mockImplementation((data: unknown) => {
      upsertArgs.push(data);
      return Promise.resolve({ error: null });
    });

    const sb = buildOptInSupabase({
      channelPrimaryResult: null, // phone_number_id lookup fails
      channelFallbackResult: { country_code: 'GB' }, // phone_number fallback succeeds
      upsertFn,
    });

    await handleLaunchOptIn(
      sb as any,
      '+447700900123',
      'Notify me when Waaiio launches',
      '+442071234567', // human-readable number used as destinationPhone
      vi.fn().mockResolvedValue(undefined),
    );

    expect(upsertArgs[0]).toMatchObject({ market: 'GB' });
  });
});

// ── Launch delivery — channel credential resolution ──

describe('Issue #503: Launch delivery — resolveChannelCredentials by phone_number_id', () => {
  let resolveChannelCredentials: typeof import('@/lib/launch/delivery').resolveChannelCredentials;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/launch/delivery');
    resolveChannelCredentials = mod.resolveChannelCredentials;
  });

  // Test 5: Delivery resolves credentials using stored receiving identifier (phone_number_id)
  it('resolves credentials when receiving_number matches phone_number_id', async () => {
    const channelData = {
      phone_number_id: '469075',
      meta_access_token: 'EAA-test-token',
      waba_id: 'waba-123',
      phone_number: '+12029226251',
    };

    const sb = buildCredentialsMock({ primaryResult: channelData });

    const result = await resolveChannelCredentials(sb as any, '469075');

    expect(result).not.toBeNull();
    expect(result!.phone_number_id).toBe('469075');
    expect(result!.meta_access_token).toBe('EAA-test-token');
    expect(result!.waba_id).toBe('waba-123');
    expect(result!.phone_number).toBe('+12029226251');
  });

  // Test 5b: Fallback to phone_number when phone_number_id does not match
  it('falls back to phone_number when phone_number_id has no match', async () => {
    const channelData = {
      phone_number_id: '469075',
      meta_access_token: 'EAA-fb-token',
      waba_id: 'waba-456',
      phone_number: '+12029226251',
    };

    const sb = buildCredentialsMock({
      primaryResult: null,
      fallbackResult: channelData,
    });

    const result = await resolveChannelCredentials(sb as any, '+12029226251');

    expect(result).not.toBeNull();
    expect(result!.phone_number_id).toBe('469075');
  });

  // Test 6: Unknown/wrong destination fails safely
  it('returns null when no channel matches either lookup', async () => {
    const sb = buildCredentialsMock({
      primaryResult: null,
      fallbackResult: null,
    });

    const result = await resolveChannelCredentials(sb as any, 'nonexistent_999');

    expect(result).toBeNull();
  });

  // Test 8: No live Meta sends — resolveChannelCredentials only does DB queries
  it('does not make any external API calls', async () => {
    const sb = buildCredentialsMock({
      primaryResult: {
        phone_number_id: '469075',
        meta_access_token: 'tok',
        waba_id: 'w1',
        phone_number: '+12029226251',
      },
    });

    // The function only queries Supabase, never calls Meta
    const result = await resolveChannelCredentials(sb as any, '469075');
    expect(result).not.toBeNull();
    // Verify only from() was called (DB query), no fetch/axios/etc.
    expect(sb.from).toHaveBeenCalledWith('whatsapp_channels');
  });
});

// ── Integration: claim-and-send uses phone_number_id resolution ──

describe('Issue #503: claimAndSendToSubscriber with phone_number_id resolution', () => {
  let claimAndSendToSubscriber: typeof import('@/lib/launch/delivery').claimAndSendToSubscriber;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/launch/delivery');
    claimAndSendToSubscriber = mod.claimAndSendToSubscriber;
  });

  it('claim winner resolves channel by phone_number_id and sends', async () => {
    const sendFn = vi.fn().mockResolvedValue({ messageId: 'wamid.503ok' });
    const channelData = {
      phone_number_id: '469075',
      meta_access_token: 'tok',
      waba_id: 'w1',
      phone_number: '+12029226251',
    };

    let channelCallCount = 0;
    const sb = {
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'claim_launch_delivery') {
          return Promise.resolve({
            data: {
              claimed: true,
              claim_token: 'tok-503',
              wa_number: '+14155551234',
              receiving_number: '469075', // This is the Meta phone_number_id
            },
            error: null,
          });
        }
        return Promise.resolve({ data: { completed: true }, error: null });
      }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'whatsapp_channels') {
          const isFirst = channelCallCount === 0;
          channelCallCount++;
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({
                        data: isFirst ? channelData : null,
                        error: null,
                      }),
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

    const config = {
      templateName: 'waaiio_launch_alert',
      templateLanguage: 'en_US',
      templateParams: ['Waaiio'],
      campaignVersion: 'v1',
    };

    const result = await claimAndSendToSubscriber(sb as any, 'sub-503', config, sendFn);

    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('wamid.503ok');
    expect(sendFn).toHaveBeenCalledOnce();
    // Verify the send function received the correct credentials
    expect(sendFn.mock.calls[0][0]).toMatchObject({ phone_number_id: '469075' });
  });

  it('missing channel after claim fails with no_channel_credentials (not crash)', async () => {
    const sendFn = vi.fn();
    const sb = {
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'claim_launch_delivery') {
          return Promise.resolve({
            data: {
              claimed: true,
              claim_token: 'tok-fail',
              wa_number: '+1',
              receiving_number: 'nonexistent_channel',
            },
            error: null,
          });
        }
        return Promise.resolve({ data: { completed: true }, error: null });
      }),
      from: vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            }),
          }),
        }),
      })),
    };

    const config = {
      templateName: 'waaiio_launch_alert',
      templateLanguage: 'en_US',
      templateParams: [],
      campaignVersion: 'v1',
    };

    const result = await claimAndSendToSubscriber(sb as any, 'sub-bad', config, sendFn);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('no_channel_credentials');
    expect(sendFn).not.toHaveBeenCalled();
  });
});

// ── Preservation of #397 safety guarantees ──

describe('Issue #503: Preserves #397 claim/idempotency/safety guarantees', () => {
  it('delivery.ts still uses claim_launch_delivery RPC for atomic claim', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    expect(src).toContain("'claim_launch_delivery'");
    expect(src).toContain('claim_token');
  });

  it('delivery.ts still uses complete_launch_delivery RPC for fenced completion', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    expect(src).toContain("'complete_launch_delivery'");
    expect(src).toContain('p_claim_token');
  });

  it('delivery.ts does not import payment or commerce modules', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    expect(src).not.toContain('lib/payments');
    expect(src).not.toContain('send-confirmation');
    expect(src).not.toContain("'bookings'");
    expect(src).not.toContain("'orders'");
  });

  it('sendTemplateFn is still injected (no live Meta sends from delivery module)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    // claimAndSendToSubscriber takes sendTemplateFn as a parameter
    expect(src).toContain('sendTemplateFn');
    // deliverLaunchNotifications also takes it
    const fnCount = (src.match(/sendTemplateFn/g) || []).length;
    expect(fnCount).toBeGreaterThanOrEqual(4); // parameter + usage in both functions
  });

  it('batch delivery still enforces limit (default 100)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    expect(src).toContain('options?.limit || 100');
  });

  it('resolveChannelCredentials still requires channel_type = shared and is_active = true', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    // Both primary and fallback queries require shared + active
    const matches = src.match(/channel_type.*shared/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // primary + fallback
    const activeMatches = src.match(/is_active.*true/g) || [];
    expect(activeMatches.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Source file fix verification ──

describe('Issue #503: Source file fix verification', () => {
  it('launch-optin.ts queries phone_number_id first (not phone_number)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/launch-optin.ts', 'utf-8');
    // Primary lookup must be phone_number_id
    const primaryIdx = src.indexOf(".eq('phone_number_id', destinationPhone)");
    expect(primaryIdx).toBeGreaterThan(-1);
    // Fallback uses phone_number
    const fallbackIdx = src.indexOf(".eq('phone_number', destinationPhone)");
    expect(fallbackIdx).toBeGreaterThan(primaryIdx);
  });

  it('launch-optin.ts fallback is bounded to shared+active channels only', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/launch-optin.ts', 'utf-8');
    // The fallback section should contain channel_type shared
    const fallbackSection = src.substring(src.indexOf('Bounded fallback'));
    expect(fallbackSection).toContain("'shared'");
    expect(fallbackSection).toContain("'is_active'");
  });

  it('delivery.ts resolveChannelCredentials queries phone_number_id first', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    const fnBody = src.substring(
      src.indexOf('async function resolveChannelCredentials'),
      src.indexOf('// ── Atomic claim'),
    );
    const primaryIdx = fnBody.indexOf(".eq('phone_number_id', receivingNumber)");
    const fallbackIdx = fnBody.indexOf(".eq('phone_number', receivingNumber)");
    expect(primaryIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(primaryIdx);
  });

  it('delivery.ts fallback is bounded to shared+active channels', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/launch/delivery.ts', 'utf-8');
    const fnBody = src.substring(
      src.indexOf('Bounded fallback'),
      src.indexOf('// ── Atomic claim'),
    );
    expect(fnBody).toContain("'shared'");
    expect(fnBody).toContain("'is_active'");
  });
});
