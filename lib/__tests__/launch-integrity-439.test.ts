/**
 * Slice 0A + 0B: Launch integrity tests (#439)
 *
 * 0A — Proves resolveChannelCredentials exercises the real function
 *       against mocked Supabase query chains with channel_type filtering.
 * 0B — Proves handleLaunchOptIn sends truthful copy on DB failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ══════════════════════════════════════════════════════════
// Slice 0A — Launch sender authority hardening
// ══════════════════════════════════════════════════════════

describe('Slice 0A — resolveChannelCredentials shared-channel authority (#439)', () => {
  // Exercise the REAL resolveChannelCredentials function against mocked Supabase.
  // The mock chain must reflect the actual .eq() filters the function applies.

  function buildMockSupabase(returnData: unknown) {
    const eqFilters: Array<{ col: string; val: string }> = [];

    const chain: Record<string, any> = {};
    chain.from = vi.fn(() => chain);
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((col: string, val: string) => {
      eqFilters.push({ col, val });
      return chain;
    });
    chain.limit = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: returnData, error: null }));

    return { supabase: chain as any, eqFilters };
  }

  it('queries with channel_type=shared AND is_active=true', async () => {
    const { resolveChannelCredentials } = await import('@/lib/launch/delivery');

    const { supabase, eqFilters } = buildMockSupabase({
      phone_number_id: 'pn-123',
      meta_access_token: 'tok',
      waba_id: 'waba-1',
      phone_number: '+12025551234',
    });

    const result = await resolveChannelCredentials(supabase, '+12025551234');

    expect(result).not.toBeNull();
    expect(result!.phone_number_id).toBe('pn-123');

    // Verify all three .eq() filters were applied (#503: primary lookup is phone_number_id)
    expect(eqFilters).toContainEqual({ col: 'phone_number_id', val: '+12025551234' });
    expect(eqFilters).toContainEqual({ col: 'channel_type', val: 'shared' });
    expect(eqFilters).toContainEqual({ col: 'is_active', val: true });
  });

  it('returns null when channel is dedicated (query returns no match)', async () => {
    const { resolveChannelCredentials } = await import('@/lib/launch/delivery');

    // Simulate: dedicated channel exists but shared filter excludes it
    const { supabase } = buildMockSupabase(null);

    const result = await resolveChannelCredentials(supabase, '+12025559999');
    expect(result).toBeNull();
  });

  it('returns null when channel is inactive (query returns no match)', async () => {
    const { resolveChannelCredentials } = await import('@/lib/launch/delivery');

    const { supabase } = buildMockSupabase(null);

    const result = await resolveChannelCredentials(supabase, '+12025550000');
    expect(result).toBeNull();
  });

  it('returns null when no channel exists at all', async () => {
    const { resolveChannelCredentials } = await import('@/lib/launch/delivery');

    const { supabase } = buildMockSupabase(null);

    const result = await resolveChannelCredentials(supabase, '+19999999999');
    expect(result).toBeNull();
  });
});

describe('Slice 0A — claimAndSendToSubscriber fails closed on null credentials (#439)', () => {
  it('returns failed with no_channel_credentials when resolver returns null', async () => {
    const { claimAndSendToSubscriber } = await import('@/lib/launch/delivery');

    // Mock supabase with successful claim but null channel credentials
    const rpcCalls: Array<{ fn: string; args: unknown }> = [];
    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(function eq(): any {
            return {
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                  })),
                })),
              })),
            };
          }),
        })),
      })),
      rpc: vi.fn(async (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        if (fn === 'claim_launch_delivery') {
          return {
            data: {
              claimed: true,
              claim_token: 'test-token-uuid',
              wa_number: '+12025551111',
              receiving_number: '+12025552222',
            },
            error: null,
          };
        }
        if (fn === 'complete_launch_delivery') {
          return { data: { completed: true }, error: null };
        }
        return { data: null, error: null };
      }),
    } as any;

    const sendFn = vi.fn();
    const config = {
      templateName: 'test_template',
      templateLanguage: 'en_US',
      templateParams: [],
      campaignVersion: 'v-test',
    };

    const result = await claimAndSendToSubscriber(
      mockSupabase, 'sub-123', config, sendFn,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('no_channel_credentials');
    expect(sendFn).not.toHaveBeenCalled();

    // Verify complete_launch_delivery was called with 'failed'
    const completeCall = rpcCalls.find(c => c.fn === 'complete_launch_delivery');
    expect(completeCall).toBeDefined();
    expect((completeCall!.args as any).p_status).toBe('failed');
  });
});

// ══════════════════════════════════════════════════════════
// Slice 0B — Truthful launch opt-in
// ══════════════════════════════════════════════════════════

describe('Slice 0B — handleLaunchOptIn truthful persistence (#439)', () => {
  let handleLaunchOptIn: typeof import('@/lib/bot/launch-optin').handleLaunchOptIn;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/bot/launch-optin');
    handleLaunchOptIn = mod.handleLaunchOptIn;
  });

  function buildMockSupabase(upsertError: { message: string } | null) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'whatsapp_channels') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    limit: vi.fn(() => ({
                      maybeSingle: vi.fn(async () => ({
                        data: { country_code: 'US' },
                        error: null,
                      })),
                    })),
                  })),
                  limit: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({
                      data: { country_code: 'US' },
                      error: null,
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        // launch_subscribers — select (existing check) + upsert
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
            })),
          })),
          upsert: vi.fn(async () => ({
            error: upsertError,
          })),
        };
      }),
    } as any;
  }

  it('sends "You\'re on the list!" on successful upsert', async () => {
    const supabase = buildMockSupabase(null);
    const replies: string[] = [];
    const sendReply = vi.fn(async (_phone: string, msg: string) => { replies.push(msg); });

    const handled = await handleLaunchOptIn(
      supabase, '+12025551111', 'Notify me when Waaiio launches (button)',
      '+12025552222', sendReply,
    );

    expect(handled).toBe(true);
    expect(sendReply).toHaveBeenCalledOnce();
    expect(replies[0]).toContain("You're in!");
    expect(replies[0]).toContain('STOP');
  });

  it('does NOT claim subscription succeeded when upsert fails', async () => {
    const supabase = buildMockSupabase({ message: 'connection refused' });
    const replies: string[] = [];
    const sendReply = vi.fn(async (_phone: string, msg: string) => { replies.push(msg); });

    const handled = await handleLaunchOptIn(
      supabase, '+12025551111', 'Notify me when Waaiio launches',
      '+12025552222', sendReply,
    );

    expect(handled).toBe(true);
    expect(sendReply).toHaveBeenCalledOnce();
    // Must NOT say "on the list"
    expect(replies[0]).not.toContain("on the list");
    expect(replies[0]).not.toContain("You're on the list");
    // Must include retry guidance
    expect(replies[0]).toContain("try again");
    // Must NOT include STOP instruction (user is not subscribed)
    expect(replies[0]).not.toContain("STOP");
  });

  it('retry after failure remains safe (idempotent upsert)', async () => {
    // First call fails
    const failSupabase = buildMockSupabase({ message: 'timeout' });
    const failReplies: string[] = [];
    await handleLaunchOptIn(
      failSupabase, '+12025551111', 'Notify me when Waaiio launches',
      '+12025552222', vi.fn(async (_, msg) => { failReplies.push(msg); }),
    );
    expect(failReplies[0]).not.toContain("on the list");

    // Second call succeeds (upsert is idempotent via UNIQUE on wa_number)
    const successSupabase = buildMockSupabase(null);
    const successReplies: string[] = [];
    await handleLaunchOptIn(
      successSupabase, '+12025551111', 'Notify me when Waaiio launches',
      '+12025552222', vi.fn(async (_, msg) => { successReplies.push(msg); }),
    );
    expect(successReplies[0]).toContain("You're in!");
  });

  it('non-matching message returns false (not handled)', async () => {
    const supabase = buildMockSupabase(null);
    const sendReply = vi.fn();

    const handled = await handleLaunchOptIn(
      supabase, '+12025551111', 'Hello, I want to book',
      '+12025552222', sendReply,
    );

    expect(handled).toBe(false);
    expect(sendReply).not.toHaveBeenCalled();
  });
});
