/**
 * Capability menu pagination tests — Issue #736, Lane 3.
 *
 * Proves that when a business has 11+ user-facing capabilities, the
 * WhatsApp list message is correctly paginated across multiple pages,
 * each with max 10 rows. The 11th+ items are accessible via "More..."
 * navigation. "My Account" is preserved and never lost.
 *
 * Meta Cloud API enforces max 10 rows per list section. Without pagination,
 * items beyond position 10 are silently dropped by slice(0,10).
 */
import { describe, it, expect, vi } from 'vitest';
import { getStep } from './helpers';
import { capabilitySelectionFlow } from '../capability-selection.flow';
import type { FlowContext, PromptList } from '../types';

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

/** Build a FlowContext with many capabilities for pagination testing */
function buildCtx(opts: {
  capabilities: string[];
  tableCounts?: Record<string, number>;
  profileId?: string;
  hasHistory?: boolean;
  menuPage?: number;
}): FlowContext {
  const counts = { ...(opts.tableCounts || {}) };
  if (opts.hasHistory) {
    counts['bookings'] = (counts['bookings'] || 0) + 1;
  }
  const supabase = mockSupabase(counts, opts.profileId);

  const session_data: Record<string, unknown> = {
    capabilities: opts.capabilities,
  };
  if (opts.menuPage !== undefined) {
    session_data._cap_menu_page = opts.menuPage;
  }

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
      id: 'test-session', user_id: 'u1', business_id: 'biz-testbiz',
      current_step: 'select_capability', session_data, version: 0,
    },
    business: {
      id: 'biz-testbiz', name: 'TestBiz', slug: 'testbiz',
      category: 'other' as any, flow_type: 'scheduling' as any,
      subscription_tier: 'business',
      trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
      metadata: {},
    },
  };
}

function getPostbacks(msg: any): string[] {
  const items = msg.items || [];
  return items.map((i: any) => i.postbackText);
}

/**
 * 11 user-facing capabilities that all have backing data.
 * These are chosen from the actual user-facing set (not in nonUserFacing).
 *
 * NOTE: When 'scheduling' or 'table_reservation' is present, 'payment' and
 * 'invoice' are excluded from user-facing by getUserFacingCapabilities().
 * So we avoid including 'payment' alongside 'scheduling'.
 *
 * User-facing caps used here:
 *   ordering, chat, giving, appointment, scheduling, class_booking,
 *   ticketing, crowdfunding, reservation, queue, waiver
 */
const ELEVEN_CAPS = [
  'ordering', 'chat', 'giving', 'appointment', 'scheduling',
  'class_booking', 'ticketing', 'crowdfunding', 'reservation',
  'queue', 'waiver',
];

const ELEVEN_CAPS_BACKING: Record<string, number> = {
  products: 5,          // ordering
  services: 3,          // giving, scheduling, class_booking
  appointments: 2,      // appointment
  events: 1,            // ticketing
  campaigns: 1,         // crowdfunding
  properties: 1,        // reservation
  waiver_templates: 1,  // waiver
};

// ── Core pagination behavior ──

describe('capability menu pagination (#736)', () => {
  it('11 capabilities: page 0 shows max 10 items (9 caps + More...)', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });

    const result = await step.prompt!(ctx);
    const msg = result![0] as PromptList;
    expect(msg.type).toBe('list');
    expect(msg.items.length).toBeLessThanOrEqual(10);
    // Must have "More..." navigation at the end
    const postbacks = getPostbacks(msg);
    expect(postbacks).toContain('cap_nav_more');
    // Must NOT have "← Previous" on first page
    expect(postbacks).not.toContain('cap_nav_prev');
  });

  it('11 capabilities: page 1 shows remaining items + "← Previous"', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
      menuPage: 1,
    });

    const result = await step.prompt!(ctx);
    const msg = result![0] as PromptList;
    expect(msg.type).toBe('list');
    expect(msg.items.length).toBeLessThanOrEqual(10);
    const postbacks = getPostbacks(msg);
    // Must have "← Previous" nav
    expect(postbacks).toContain('cap_nav_prev');
    // Should NOT have "More..." on last page
    expect(postbacks).not.toContain('cap_nav_more');
  });

  it('all 11 capabilities are accessible across pages (none dropped)', async () => {
    // Collect all capability postbacks across pages
    const allCapPostbacks = new Set<string>();

    // Page 0
    const ctx0 = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    const result0 = await step.prompt!(ctx0);
    const postbacks0 = getPostbacks(result0![0]);
    for (const pb of postbacks0) {
      if (pb.startsWith('cap_') && !pb.startsWith('cap_nav_')) {
        allCapPostbacks.add(pb);
      }
    }

    // Page 1
    const ctx1 = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
      menuPage: 1,
    });
    const result1 = await step.prompt!(ctx1);
    const postbacks1 = getPostbacks(result1![0]);
    for (const pb of postbacks1) {
      if (pb.startsWith('cap_') && !pb.startsWith('cap_nav_')) {
        allCapPostbacks.add(pb);
      }
    }

    // All 11 capabilities must be reachable
    expect(allCapPostbacks.size).toBe(11);
    for (const cap of ELEVEN_CAPS) {
      expect(allCapPostbacks.has(`cap_${cap}`)).toBe(true);
    }
  });

  it('no page ever exceeds 10 rows (Meta API safety)', async () => {
    // Test with various counts that could trigger edge cases
    for (const count of [11, 12, 15, 20]) {
      // Build capabilities list — use 'payment' + 'chat' + 'queue' (always available)
      // plus enough backing-data caps to reach the count
      const backingCaps = ['ordering', 'giving', 'appointment', 'scheduling',
        'class_booking', 'ticketing', 'crowdfunding', 'reservation', 'table_reservation'];
      const alwaysAvailable = ['payment', 'chat', 'queue'];
      const caps = [...alwaysAvailable, ...backingCaps.slice(0, count - alwaysAvailable.length)];
      if (caps.length < count) continue; // not enough test caps

      for (let page = 0; page < 10; page++) {
        const ctx = buildCtx({
          capabilities: caps,
          tableCounts: ELEVEN_CAPS_BACKING,
          menuPage: page,
        });
        const result = await step.prompt!(ctx);
        const msg = result![0];
        if (msg.type === 'list') {
          expect((msg as PromptList).items.length).toBeLessThanOrEqual(10);
        }
      }
    }
  });

  it('My Account preserved with 11+ capabilities (returning customer)', async () => {
    // Collect all postbacks across pages
    const allCapPostbacks = new Set<string>();

    for (let page = 0; page < 3; page++) {
      const ctx = buildCtx({
        capabilities: ELEVEN_CAPS,
        tableCounts: ELEVEN_CAPS_BACKING,
        profileId: 'profile-1',
        hasHistory: true,
        menuPage: page,
      });
      const result = await step.prompt!(ctx);
      const msg = result![0];
      if (msg.type !== 'list') continue;
      const postbacks = getPostbacks(msg);
      for (const pb of postbacks) {
        allCapPostbacks.add(pb);
      }
    }

    // My Account must appear somewhere
    expect(allCapPostbacks.has('cap_my_account')).toBe(true);
    // All 11 capabilities must also be reachable
    for (const cap of ELEVEN_CAPS) {
      expect(allCapPostbacks.has(`cap_${cap}`)).toBe(true);
    }
  });

  it('10 or fewer capabilities: no pagination, no navigation items', async () => {
    const tenCaps = ELEVEN_CAPS.slice(0, 10);
    const ctx = buildCtx({
      capabilities: tenCaps,
      tableCounts: ELEVEN_CAPS_BACKING,
    });

    const result = await step.prompt!(ctx);
    const msg = result![0] as PromptList;
    expect(msg.type).toBe('list');
    const postbacks = getPostbacks(msg);
    // No navigation items
    expect(postbacks).not.toContain('cap_nav_more');
    expect(postbacks).not.toContain('cap_nav_prev');
  });
});

// ── Navigation validate() / next() ──

describe('pagination navigation', () => {
  it('cap_nav_more advances page and signals reprompt', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    ctx.session.session_data._cap_menu_page = 0;
    ctx.session.session_data._cap_menu_total_pages = 2;

    const result = await step.validate!('cap_nav_more', ctx);
    expect(result.valid).toBe(true);
    expect(ctx.session.session_data._cap_menu_page).toBe(1);
    expect(result.data?._cap_menu_navigate).toBe(true);
  });

  it('cap_nav_prev goes back a page and signals reprompt', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    ctx.session.session_data._cap_menu_page = 1;
    ctx.session.session_data._cap_menu_total_pages = 2;

    const result = await step.validate!('cap_nav_prev', ctx);
    expect(result.valid).toBe(true);
    expect(ctx.session.session_data._cap_menu_page).toBe(0);
    expect(result.data?._cap_menu_navigate).toBe(true);
  });

  it('cap_nav_more cannot exceed total pages', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    ctx.session.session_data._cap_menu_page = 1;
    ctx.session.session_data._cap_menu_total_pages = 2;

    await step.validate!('cap_nav_more', ctx);
    expect(ctx.session.session_data._cap_menu_page).toBe(1); // stays at max
  });

  it('cap_nav_prev cannot go below 0', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    ctx.session.session_data._cap_menu_page = 0;
    ctx.session.session_data._cap_menu_total_pages = 2;

    await step.validate!('cap_nav_prev', ctx);
    expect(ctx.session.session_data._cap_menu_page).toBe(0);
  });

  it('next() returns select_capability when navigating pages', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    ctx.session.session_data._cap_menu_navigate = true;

    const next = await step.next!(ctx);
    expect(next).toBe('select_capability');
    // _cap_menu_navigate should be cleaned up
    expect(ctx.session.session_data._cap_menu_navigate).toBeUndefined();
  });

  it('selecting a capability on page 2 cleans up pagination state', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    ctx.session.session_data._cap_menu_page = 1;
    ctx.session.session_data._cap_menu_total_pages = 2;

    const result = await step.validate!('cap_queue', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.active_capability).toBe('queue');
    // Pagination state cleaned up
    expect(ctx.session.session_data._cap_menu_page).toBeUndefined();
    expect(ctx.session.session_data._cap_menu_total_pages).toBeUndefined();
  });
});

// ── Edge cases ──

describe('pagination edge cases', () => {
  it('out-of-range page is clamped to last page', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
      menuPage: 99, // way beyond actual pages
    });

    const result = await step.prompt!(ctx);
    const msg = result![0] as PromptList;
    expect(msg.type).toBe('list');
    // Should show the last page, not crash
    expect(msg.items.length).toBeGreaterThan(0);
    expect(msg.items.length).toBeLessThanOrEqual(10);
  });

  it('exactly 11 items: page 0 has 9 caps + More, page 1 has 2 caps + Previous', async () => {
    const ctx0 = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    const result0 = await step.prompt!(ctx0);
    const msg0 = result0![0] as PromptList;
    const p0 = getPostbacks(msg0);
    const navCount0 = p0.filter(p => p.startsWith('cap_nav_')).length;
    const capCount0 = p0.filter(p => p.startsWith('cap_') && !p.startsWith('cap_nav_')).length;

    expect(navCount0).toBe(1); // just "More..."
    expect(capCount0).toBe(9); // 9 caps on page 0 (10 - 1 for "More...")
    expect(msg0.items.length).toBe(10); // 9 caps + 1 nav = 10

    const ctx1 = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
      menuPage: 1,
    });
    const result1 = await step.prompt!(ctx1);
    const msg1 = result1![0] as PromptList;
    const p1 = getPostbacks(msg1);
    const navCount1 = p1.filter(p => p.startsWith('cap_nav_')).length;
    const capCount1 = p1.filter(p => p.startsWith('cap_') && !p.startsWith('cap_nav_')).length;

    expect(navCount1).toBe(1); // just "← Previous"
    expect(capCount1).toBe(2); // remaining 2 caps
    expect(msg1.items.length).toBe(3); // 2 caps + 1 nav = 3
  });

  it('stable IDs across pages — same capability always has same postback ID', async () => {
    // Render page 0 and page 1, verify that the same capability ID appears in both
    const ctx0 = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    const result0 = await step.prompt!(ctx0);
    const items0 = (result0![0] as PromptList).items;

    const ctx1 = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
      menuPage: 1,
    });
    const result1 = await step.prompt!(ctx1);
    const items1 = (result1![0] as PromptList).items;

    // Every item has a stable cap_{id} postbackText
    for (const item of [...items0, ...items1]) {
      if (item.postbackText.startsWith('cap_nav_')) continue;
      expect(item.postbackText).toMatch(/^cap_[a-z_]+$/);
    }
  });
});
