/**
 * Capability menu correctness tests.
 *
 * Proves that prompt() always renders the correct capability menu
 * regardless of whether skipIf() ran, that stale cached data cannot
 * override fresh capabilities, and that zero-capability edge cases
 * never produce an empty WhatsApp interactive payload.
 */
import { describe, it, expect, vi } from 'vitest';
import { getStep } from './helpers';
import { capabilitySelectionFlow } from '../capability-selection.flow';
import type { FlowContext } from '../types';

const step = getStep(capabilitySelectionFlow, 'select_capability');

// ── Helpers ──

/** Build a mock supabase that returns backing data counts per table */
function mockSupabase(tableCounts: Record<string, number> = {}, profileId?: string) {
  const from = vi.fn((table: string) => {
    const count = tableCounts[table] ?? 0;
    const chain: Record<string, any> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.insert = vi.fn().mockReturnValue(chain);
    chain.update = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.neq = vi.fn().mockReturnValue(chain);
    chain.or = vi.fn().mockReturnValue(chain);
    chain.is = vi.fn().mockReturnValue(chain);
    chain.not = vi.fn().mockReturnValue(chain);
    chain.in = vi.fn().mockReturnValue(chain);
    chain.gte = vi.fn().mockReturnValue(chain);
    chain.lte = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn().mockResolvedValue({ data: null, error: null });

    if (table === 'profiles') {
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: profileId ? { id: profileId } : null, error: null,
      });
    } else {
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    }

    // For count queries (select with { count: 'exact', head: true })
    const originalSelect = chain.select;
    chain.select = vi.fn((...args: any[]) => {
      if (args[1]?.count === 'exact') {
        const countChain: Record<string, any> = {};
        countChain.eq = vi.fn().mockReturnValue(countChain);
        countChain.neq = vi.fn().mockReturnValue(countChain);
        countChain.or = vi.fn().mockReturnValue(countChain);
        countChain.is = vi.fn().mockReturnValue(countChain);
        countChain.not = vi.fn().mockReturnValue(countChain);
        countChain.limit = vi.fn().mockReturnValue(countChain);
        countChain.then = (fn: any) => fn({ count, data: [], error: null });
        Object.defineProperty(countChain, Symbol.toStringTag, { value: 'Promise' });
        return countChain;
      }
      return chain;
    });

    return chain;
  });

  return { from, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
}

/** Build a FlowContext for capability menu testing */
function buildCtx(opts: {
  capabilities: string[];
  tableCounts?: Record<string, number>;
  profileId?: string;
  hasHistory?: boolean;
  forceMenu?: boolean;
  staleCachedCaps?: string[];
  staleCachedLabels?: Record<string, string>;
}): FlowContext {
  const counts = { ...(opts.tableCounts || {}) };
  if (opts.hasHistory) {
    counts['bookings'] = (counts['bookings'] || 0) + 1;
  }
  const supabase = mockSupabase(counts, opts.profileId);

  const session_data: Record<string, unknown> = {
    capabilities: opts.capabilities,
  };
  if (opts.forceMenu) session_data._force_capability_menu = true;
  if (opts.staleCachedCaps) session_data._filtered_capabilities = opts.staleCachedCaps;
  if (opts.staleCachedLabels) session_data._capability_custom_labels = opts.staleCachedLabels;

  return {
    supabase: supabase as any,
    sender: {
      sendText: vi.fn().mockResolvedValue({}),
      sendButtons: vi.fn().mockResolvedValue({}),
      sendList: vi.fn().mockResolvedValue({}),
      sendDocument: vi.fn().mockResolvedValue({}),
    } as any,
    standalone: {} as any,
    intelligence: {} as any,
    t: vi.fn(async (text: string) => text),
    from: '+2341234567890',
    session: {
      id: 'test-session', user_id: 'u1', business_id: 'biz-snapakit',
      current_step: 'select_capability', session_data, version: 0,
    },
    business: {
      id: 'biz-snapakit', name: 'SnapaKit', slug: 'snapakit',
      category: 'other' as any, flow_type: 'scheduling' as any,
      subscription_tier: 'starter',
      trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
      metadata: {},
    },
  };
}

function getItems(msg: any): any[] {
  return msg.items || msg.buttons || [];
}

function getPostbacks(msg: any): string[] {
  const items = msg.items || [];
  const buttons = msg.buttons || [];
  return [...items.map((i: any) => i.postbackText), ...buttons.map((b: any) => b.id)];
}

// ── Core menu rendering ──

describe('capability menu correctness', () => {
  const FIVE_CAPS = ['payment', 'ordering', 'chat', 'giving', 'appointment'];
  const FIVE_CAPS_BACKING: Record<string, number> = {
    products: 5,       // ordering
    services: 3,       // giving
    appointments: 2,   // appointment
  };

  it('five backed capabilities + returning customer → five business actions + My Account', async () => {
    const ctx = buildCtx({
      capabilities: FIVE_CAPS,
      tableCounts: FIVE_CAPS_BACKING,
      profileId: 'profile-1',
      hasHistory: true,
    });

    const result = await step.prompt!(ctx);
    const msg = result![0];
    expect(msg.type).toBe('list');
    const postbacks = getPostbacks(msg);
    expect(postbacks.length).toBe(6);
    expect(postbacks).toContain('cap_payment');
    expect(postbacks).toContain('cap_ordering');
    expect(postbacks).toContain('cap_chat');
    expect(postbacks).toContain('cap_giving');
    expect(postbacks).toContain('cap_appointment');
    expect(postbacks).toContain('cap_my_account');
  });

  it('five backed capabilities + new customer → five business actions, no My Account', async () => {
    const ctx = buildCtx({
      capabilities: FIVE_CAPS,
      tableCounts: FIVE_CAPS_BACKING,
    });

    const result = await step.prompt!(ctx);
    const msg = result![0];
    expect(msg.type).toBe('list');
    const postbacks = getPostbacks(msg);
    expect(postbacks.length).toBe(5);
    expect(postbacks).not.toContain('cap_my_account');
  });

  it('action=require override → capabilities still render correctly (prompt independent of skipIf)', async () => {
    const ctx = buildCtx({
      capabilities: FIVE_CAPS,
      tableCounts: FIVE_CAPS_BACKING,
    });
    // Simulate: skipIf() was NOT called (override bypassed it)
    delete ctx.session.session_data._filtered_capabilities;
    delete ctx.session.session_data._capability_custom_labels;

    const result = await step.prompt!(ctx);
    const msg = result![0];
    expect(msg.type).toBe('list');
    expect(getItems(msg).length).toBe(5);
    expect(getPostbacks(msg)).toContain('cap_chat');
  });

  it('missing backing data removes only the affected capability', async () => {
    const ctx = buildCtx({
      capabilities: ['ordering', 'chat', 'appointment'],
      tableCounts: { products: 0, appointments: 0 },
    });

    const result = await step.prompt!(ctx);
    const msg = result![0];
    expect(msg.type).toBe('buttons');
    const postbacks = getPostbacks(msg);
    expect(postbacks).toEqual(['cap_chat']);
  });

  it('4+ options use WhatsApp list path', async () => {
    const ctx = buildCtx({
      capabilities: ['payment', 'ordering', 'chat', 'giving'],
      tableCounts: { products: 5, services: 3 },
    });

    const result = await step.prompt!(ctx);
    expect(result![0].type).toBe('list');
    expect(getItems(result![0]).length).toBe(4);
  });

  it('2-3 options use buttons', async () => {
    const ctx = buildCtx({ capabilities: ['payment', 'chat'] });

    const result = await step.prompt!(ctx);
    expect(result![0].type).toBe('buttons');
    expect(getItems(result![0]).length).toBe(2);
  });

  it('zero valid options + no history → safe fallback text (never empty payload)', async () => {
    const ctx = buildCtx({
      capabilities: ['ordering'],
      tableCounts: { products: 0 },
    });

    const result = await step.prompt!(ctx);
    expect(result![0].type).toBe('text');
    expect((result![0] as any).text).toContain('still setting up');
  });

  it('single valid capability auto-skips via skipIf', async () => {
    const ctx = buildCtx({ capabilities: ['chat'] });

    const shouldSkip = await step.skipIf!(ctx);
    expect(shouldSkip).toBe(true);
    expect(ctx.session.session_data.active_capability).toBe('chat');
  });

  it('skipIf with _force_capability_menu still prepares capabilities', async () => {
    const ctx = buildCtx({
      capabilities: FIVE_CAPS,
      tableCounts: FIVE_CAPS_BACKING,
      forceMenu: true,
    });

    const shouldSkip = await step.skipIf!(ctx);
    expect(shouldSkip).toBe(false);
    expect(ctx.session.session_data._filtered_capabilities).toBeDefined();
    expect((ctx.session.session_data._filtered_capabilities as string[]).length).toBeGreaterThan(0);
  });
});

// ── My Account behavior ──

describe('My Account behavior', () => {
  it('returning customer + zero create-new capabilities → My Account still available', async () => {
    const ctx = buildCtx({
      capabilities: ['ordering'],
      tableCounts: { products: 0 }, // no backing → zero create-new
      profileId: 'profile-1',
      hasHistory: true,
    });

    const result = await step.prompt!(ctx);
    const msg = result![0];
    // My Account should be present even with zero business capabilities
    expect(msg.type).toBe('buttons');
    const postbacks = getPostbacks(msg);
    expect(postbacks).toContain('cap_my_account');
    expect(postbacks.length).toBe(1);
  });

  it('brand-new customer + zero capabilities → safe fallback text (no My Account)', async () => {
    const ctx = buildCtx({
      capabilities: ['ordering'],
      tableCounts: { products: 0 },
      // No profileId, no history
    });

    const result = await step.prompt!(ctx);
    expect(result![0].type).toBe('text');
    expect((result![0] as any).text).toContain('still setting up');
  });
});

// ── Stale cache rejection ──

describe('stale cache rejection', () => {
  it('stale _filtered_capabilities cannot override a newly refreshed capability set', async () => {
    // Session has stale cache from a previous turn showing only ['chat']
    // But capabilities were refreshed to include 3 caps with backing data
    const ctx = buildCtx({
      capabilities: ['payment', 'ordering', 'chat'],
      tableCounts: { products: 5 },
      staleCachedCaps: ['chat'], // stale: only had chat before
      staleCachedLabels: {},
    });

    const result = await step.prompt!(ctx);
    const msg = result![0];
    // Must show all 3 current capabilities, not the stale ['chat']
    const postbacks = getPostbacks(msg);
    expect(postbacks.length).toBe(3);
    expect(postbacks).toContain('cap_payment');
    expect(postbacks).toContain('cap_ordering');
    expect(postbacks).toContain('cap_chat');
  });

  it('disabled capability cached from earlier turn is not rendered', async () => {
    // Stale cache includes 'giving' but current capabilities no longer include it
    const ctx = buildCtx({
      capabilities: ['payment', 'chat'], // giving was disabled
      staleCachedCaps: ['payment', 'chat', 'giving'], // stale cache still has it
      staleCachedLabels: {},
    });

    const result = await step.prompt!(ctx);
    const postbacks = getPostbacks(result![0]);
    expect(postbacks).not.toContain('cap_giving');
    expect(postbacks).toContain('cap_payment');
    expect(postbacks).toContain('cap_chat');
  });

  it('newly enabled capability appears even if older cached list lacks it', async () => {
    // Stale cache has ['chat'] but owner just enabled ordering with products
    const ctx = buildCtx({
      capabilities: ['chat', 'ordering'],
      tableCounts: { products: 10 },
      staleCachedCaps: ['chat'], // stale: ordering wasn't there before
      staleCachedLabels: {},
    });

    const result = await step.prompt!(ctx);
    const postbacks = getPostbacks(result![0]);
    expect(postbacks).toContain('cap_ordering');
    expect(postbacks).toContain('cap_chat');
  });

  it('changed backing data is respected on menu reconstruction', async () => {
    // Stale cache had ordering (products existed), but now products are deleted
    const ctx = buildCtx({
      capabilities: ['ordering', 'chat'],
      tableCounts: { products: 0 }, // products deleted since last turn
      staleCachedCaps: ['ordering', 'chat'], // stale: ordering was valid before
      staleCachedLabels: {},
    });

    const result = await step.prompt!(ctx);
    const postbacks = getPostbacks(result![0]);
    expect(postbacks).not.toContain('cap_ordering'); // no backing data
    expect(postbacks).toContain('cap_chat');
  });
});

// ── Canonical filter ──

describe('canonical filter', () => {
  it('uses getUserFacingCapabilities as the filter for menu preparation', async () => {
    // Non-user-facing capabilities must never appear in the menu
    const ctx = buildCtx({
      capabilities: ['chat', 'reminders', 'feedback', 'staff', 'broadcast', 'auto_reply'],
    });

    const result = await step.prompt!(ctx);
    const postbacks = getPostbacks(result![0]);
    // Only chat is user-facing
    expect(postbacks).toContain('cap_chat');
    expect(postbacks).not.toContain('cap_reminders');
    expect(postbacks).not.toContain('cap_feedback');
    expect(postbacks).not.toContain('cap_staff');
    expect(postbacks).not.toContain('cap_broadcast');
    expect(postbacks).not.toContain('cap_auto_reply');
  });

  it('scheduling presence hides payment and invoice from menu', async () => {
    const ctx = buildCtx({
      capabilities: ['scheduling', 'payment', 'invoice', 'chat'],
      tableCounts: { services: 3 },
    });

    const result = await step.prompt!(ctx);
    const postbacks = getPostbacks(result![0]);
    expect(postbacks).toContain('cap_scheduling');
    expect(postbacks).toContain('cap_chat');
    expect(postbacks).not.toContain('cap_payment');
    expect(postbacks).not.toContain('cap_invoice');
  });
});

// ── Integration: skipIf → prompt sequence ──

describe('skipIf → prompt integration', () => {
  it('ordering + zero products + no history → skipIf=false, then safe fallback text', async () => {
    const ctx = buildCtx({
      capabilities: ['ordering'],
      tableCounts: { products: 0 },
    });

    const skip = await step.skipIf!(ctx);
    expect(skip).toBe(false);
    expect(ctx.session.session_data.active_capability).toBeUndefined();

    const result = await step.prompt!(ctx);
    expect(result![0].type).toBe('text');
    expect((result![0] as any).text).toContain('still setting up');
  });

  it('ordering + zero products + returning history → skipIf=false, then My Account', async () => {
    const ctx = buildCtx({
      capabilities: ['ordering'],
      tableCounts: { products: 0 },
      profileId: 'profile-1',
      hasHistory: true,
    });

    const skip = await step.skipIf!(ctx);
    expect(skip).toBe(false);
    expect(ctx.session.session_data.active_capability).toBeUndefined();

    const result = await step.prompt!(ctx);
    const msg = result![0];
    expect(msg.type).toBe('buttons');
    const postbacks = getPostbacks(msg);
    expect(postbacks).toContain('cap_my_account');
    expect(postbacks).not.toContain('cap_ordering');
  });

  it('exactly one genuinely renderable capability → skipIf=true and that capability is selected', async () => {
    const ctx = buildCtx({
      capabilities: ['ordering', 'chat'],
      tableCounts: { products: 0 }, // ordering removed by backing check, only chat remains
    });

    const skip = await step.skipIf!(ctx);
    expect(skip).toBe(true);
    expect(ctx.session.session_data.active_capability).toBe('chat');
  });

  it('zero renderable capabilities never sets active_capability', async () => {
    const ctx = buildCtx({
      capabilities: ['ordering'],
      tableCounts: { products: 0 },
    });

    await step.skipIf!(ctx);
    expect(ctx.session.session_data.active_capability).toBeUndefined();
  });
});
