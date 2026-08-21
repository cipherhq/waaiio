/**
 * Capability menu correctness tests.
 *
 * Proves that prompt() always renders the correct capability menu
 * regardless of whether skipIf() ran, and that zero-capability
 * edge cases never produce an empty WhatsApp interactive payload.
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
    const self = () => chain;
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

    // profiles.maybeSingle returns the profile for returning customer checks
    if (table === 'profiles') {
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: profileId ? { id: profileId } : null,
        error: null,
      });
    } else {
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    }

    // For count queries (select with { count: 'exact', head: true })
    // The mock's select() needs to eventually resolve to { count }
    // Override the terminal chain resolution to return count
    const originalSelect = chain.select;
    chain.select = vi.fn((...args: any[]) => {
      if (args[1]?.count === 'exact') {
        // Return a chain where terminal methods resolve with { count }
        const countChain: Record<string, any> = {};
        const countSelf = () => countChain;
        countChain.eq = vi.fn().mockReturnValue(countChain);
        countChain.neq = vi.fn().mockReturnValue(countChain);
        countChain.or = vi.fn().mockReturnValue(countChain);
        countChain.is = vi.fn().mockReturnValue(countChain);
        countChain.not = vi.fn().mockReturnValue(countChain);
        countChain.limit = vi.fn().mockReturnValue(countChain);
        // resolve to { count } for any terminal access
        countChain.then = (fn: any) => fn({ count, data: [], error: null });
        // Make it thenable so await works
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
  filteredCapabilities?: string[]; // pre-set to test cache behavior
}): FlowContext {
  // Merge history table counts if returning customer
  const counts = { ...(opts.tableCounts || {}) };
  if (opts.hasHistory) {
    counts['bookings'] = (counts['bookings'] || 0) + 1;
  }

  const supabase = mockSupabase(counts, opts.profileId);

  const session_data: Record<string, unknown> = {
    capabilities: opts.capabilities,
  };
  if (opts.forceMenu) session_data._force_capability_menu = true;
  if (opts.filteredCapabilities) session_data._filtered_capabilities = opts.filteredCapabilities;

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

// ── Tests ──

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
    expect(result).toBeDefined();
    expect(result!.length).toBe(1);
    const msg = result![0];

    // 5 capabilities + My Account = 6 items → WhatsApp list (not buttons)
    expect(msg.type).toBe('list');
    const items = (msg as any).items;
    expect(items.length).toBe(6);

    // All 5 business capabilities present
    const titles = items.map((i: any) => i.postbackText || i.id);
    expect(titles).toContain('cap_payment');
    expect(titles).toContain('cap_ordering');
    expect(titles).toContain('cap_chat');
    expect(titles).toContain('cap_giving');
    expect(titles).toContain('cap_appointment');
    expect(titles).toContain('cap_my_account');
  });

  it('five backed capabilities + new customer → five business actions, no My Account', async () => {
    const ctx = buildCtx({
      capabilities: FIVE_CAPS,
      tableCounts: FIVE_CAPS_BACKING,
      // No profileId → not a returning customer
    });

    const result = await step.prompt!(ctx);
    const msg = result![0];
    expect(msg.type).toBe('list'); // 5 items → list
    const items = (msg as any).items;
    expect(items.length).toBe(5);

    // No My Account
    const titles = items.map((i: any) => i.postbackText || i.id);
    expect(titles).not.toContain('cap_my_account');
    expect(titles).toContain('cap_payment');
    expect(titles).toContain('cap_ordering');
    expect(titles).toContain('cap_chat');
    expect(titles).toContain('cap_giving');
    expect(titles).toContain('cap_appointment');
  });

  it('action=require override → capabilities still render correctly (prompt independent of skipIf)', async () => {
    // Simulate: skipIf() was NOT called (override action=require bypasses it)
    // _filtered_capabilities is NOT in session_data
    const ctx = buildCtx({
      capabilities: FIVE_CAPS,
      tableCounts: FIVE_CAPS_BACKING,
    });
    // Explicitly ensure NO cached _filtered_capabilities
    delete ctx.session.session_data._filtered_capabilities;
    delete ctx.session.session_data._capability_custom_labels;

    const result = await step.prompt!(ctx);
    const msg = result![0];

    // prompt() should have called prepareCapabilityMenu() internally
    expect(msg.type).toBe('list');
    const items = (msg as any).items;
    expect(items.length).toBe(5); // 5 capabilities, no history
    expect(items.map((i: any) => i.postbackText)).toContain('cap_chat');
  });

  it('missing backing data removes only the affected capability', async () => {
    const ctx = buildCtx({
      capabilities: ['ordering', 'chat', 'appointment'],
      tableCounts: {
        // ordering has no products → should be removed
        products: 0,
        // appointment has no appointments → should be removed
        appointments: 0,
      },
    });

    const result = await step.prompt!(ctx);
    const msg = result![0];

    // Only chat remains (always available, no backing data required)
    // With 1 item → buttons
    expect(msg.type).toBe('buttons');
    const buttons = (msg as any).buttons;
    expect(buttons.length).toBe(1);
    expect(buttons[0].id).toBe('cap_chat');
  });

  it('4+ options use WhatsApp list path', async () => {
    const ctx = buildCtx({
      capabilities: ['payment', 'ordering', 'chat', 'giving'],
      tableCounts: { products: 5, services: 3 },
    });

    const result = await step.prompt!(ctx);
    const msg = result![0];
    expect(msg.type).toBe('list');
    expect((msg as any).items.length).toBe(4);
    expect((msg as any).buttonLabel).toBe('View Options');
  });

  it('2-3 options use buttons', async () => {
    const ctx = buildCtx({
      capabilities: ['payment', 'chat'],
      tableCounts: {},
    });

    const result = await step.prompt!(ctx);
    const msg = result![0];
    expect(msg.type).toBe('buttons');
    expect((msg as any).buttons.length).toBe(2);
  });

  it('zero valid options never produces empty buttons/list — sends safe fallback text', async () => {
    const ctx = buildCtx({
      capabilities: ['ordering'],
      tableCounts: { products: 0 }, // no backing data
    });
    // Ensure no cached data
    delete ctx.session.session_data._filtered_capabilities;

    const result = await step.prompt!(ctx);
    const msg = result![0];
    // Must be plain text, not buttons/list with zero items
    expect(msg.type).toBe('text');
    expect((msg as any).text).toContain('still setting up');
  });

  it('single valid capability auto-skips via skipIf', async () => {
    const ctx = buildCtx({
      capabilities: ['chat'],
      tableCounts: {},
    });

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
    // _filtered_capabilities should be populated even though menu is forced
    expect(ctx.session.session_data._filtered_capabilities).toBeDefined();
    expect((ctx.session.session_data._filtered_capabilities as string[]).length).toBeGreaterThan(0);
  });
});
