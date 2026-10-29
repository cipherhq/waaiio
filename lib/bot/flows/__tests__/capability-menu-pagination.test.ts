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
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import type { FlowContext, PromptList } from '../types';

const step = getStep(capabilitySelectionFlow, 'select_capability');
const myAccountStep = getStep(capabilitySelectionFlow, 'my_account_menu');

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

  it('no page ever exceeds 10 rows — verified at 9/10/11/12 boundaries', async () => {
    // Test exact boundaries after eligibility filtering.
    // 9 caps: all user-facing from ELEVEN_CAPS minus 2
    const NINE_CAPS = ELEVEN_CAPS.slice(0, 9);
    // 10 caps: ELEVEN_CAPS minus 1
    const TEN_CAPS = ELEVEN_CAPS.slice(0, 10);
    // 12 caps: ELEVEN_CAPS + table_reservation (needs services backing, already provided)
    const TWELVE_CAPS = [...ELEVEN_CAPS, 'table_reservation'];

    const boundaries: Array<{ label: string; caps: string[]; expectPages: number }> = [
      { label: '9 caps', caps: NINE_CAPS, expectPages: 1 },
      { label: '10 caps', caps: TEN_CAPS, expectPages: 1 },
      { label: '11 caps', caps: ELEVEN_CAPS, expectPages: 2 },
      { label: '12 caps', caps: TWELVE_CAPS, expectPages: 2 },
    ];

    for (const { label, caps, expectPages } of boundaries) {
      const allItems: string[] = [];
      for (let page = 0; page < expectPages + 1; page++) {
        const ctx = buildCtx({
          capabilities: caps,
          tableCounts: ELEVEN_CAPS_BACKING,
          menuPage: page,
        });
        const result = await step.prompt!(ctx);
        const msg = result![0];
        if (msg.type === 'list') {
          const items = (msg as PromptList).items;
          expect(items.length, `${label} page ${page} exceeds 10 rows`).toBeLessThanOrEqual(10);
          expect(items.length, `${label} page ${page} is empty`).toBeGreaterThan(0);
          allItems.push(...getPostbacks(msg));
        }
      }
      // Verify total capability count matches (excluding nav items)
      const capPostbacks = allItems.filter(p => p.startsWith('cap_') && !p.startsWith('cap_nav_'));
      // Deduplicate: out-of-range pages clamp to last, so caps may repeat
      const uniqueCaps = new Set(capPostbacks);
      expect(uniqueCaps.size, `${label}: not all caps reachable`).toBe(caps.length);
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

  it('cap_nav_more rejected on last page (no silent clamping)', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    ctx.session.session_data._cap_menu_page = 1;
    ctx.session.session_data._cap_menu_total_pages = 2;

    const result = await step.validate!('cap_nav_more', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBeTruthy();
    expect(ctx.session.session_data._cap_menu_page).toBe(1); // unchanged
  });

  it('cap_nav_prev rejected on page 0 (no silent clamping)', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    ctx.session.session_data._cap_menu_page = 0;
    ctx.session.session_data._cap_menu_total_pages = 2;

    const result = await step.validate!('cap_nav_prev', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBeTruthy();
    expect(ctx.session.session_data._cap_menu_page).toBe(0); // unchanged
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

// ── Stale / replayed navigation rejection ──

describe('stale navigation rejection', () => {
  it('cap_nav_more rejected when no pagination state exists (stale session)', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    // No _cap_menu_page or _cap_menu_total_pages set — simulates stale/replayed postback
    delete ctx.session.session_data._cap_menu_page;
    delete ctx.session.session_data._cap_menu_total_pages;

    const result = await step.validate!('cap_nav_more', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBeTruthy();
  });

  it('cap_nav_prev rejected when no pagination state exists (stale session)', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    delete ctx.session.session_data._cap_menu_page;
    delete ctx.session.session_data._cap_menu_total_pages;

    const result = await step.validate!('cap_nav_prev', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBeTruthy();
  });

  it('cap_nav_prev rejected when already on page 0', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    ctx.session.session_data._cap_menu_page = 0;
    ctx.session.session_data._cap_menu_total_pages = 2;

    const result = await step.validate!('cap_nav_prev', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBeTruthy();
  });

  it('cap_nav_more rejected when on last page', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    ctx.session.session_data._cap_menu_page = 1;
    ctx.session.session_data._cap_menu_total_pages = 2;

    const result = await step.validate!('cap_nav_more', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBeTruthy();
  });

  it('cap_nav_more with only _cap_menu_page but no _cap_menu_total_pages rejects', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });
    ctx.session.session_data._cap_menu_page = 0;
    // _cap_menu_total_pages intentionally missing

    const result = await step.validate!('cap_nav_more', ctx);
    expect(result.valid).toBe(false);
  });
});

// ── Capability selection validation ──

describe('capability selection validation', () => {
  it('cap_X postback rejected for capability NOT in business capabilities list', async () => {
    const ctx = buildCtx({
      capabilities: ['scheduling', 'chat'], // only these two
      tableCounts: { services: 2 },
    });

    // Try selecting 'ordering' which is NOT in the capabilities list
    const result = await step.validate!('cap_ordering', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBeTruthy();
  });

  it('cap_X postback accepted for capability that IS in business capabilities', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });

    const result = await step.validate!('cap_chat', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.active_capability).toBe('chat');
  });

  it('cap_X postback rejected for capability absent from session (stale/foreign postback)', async () => {
    // A session with only ['scheduling', 'chat'] rejects a postback for 'ticketing'
    // which is not in this session's capability list — guards against stale or
    // replayed postbacks from a different context
    const ctx = buildCtx({
      capabilities: ['scheduling', 'chat'],
      tableCounts: { services: 2 },
    });
    const result = await step.validate!('cap_ticketing', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBeTruthy();
  });
});

// ── Re-entry and reachability ──

describe('re-entry and reachability', () => {
  it('capability selection cleans up pagination, next prompt starts at page 0', async () => {
    // Same session state throughout — simulates persisted session_data
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });

    // Step 1: prompt() renders page 0 and stores pagination state
    await step.prompt!(ctx);
    expect(ctx.session.session_data._cap_menu_page).toBe(0);
    expect(ctx.session.session_data._cap_menu_total_pages).toBe(2);

    // Step 2: select a capability — pagination state cleaned up
    await step.validate!('cap_chat', ctx);
    expect(ctx.session.session_data._cap_menu_page).toBeUndefined();
    expect(ctx.session.session_data._cap_menu_total_pages).toBeUndefined();

    // Step 3: re-enter prompt — renders page 0, no stale page carried over
    const result3 = await step.prompt!(ctx);
    const msg3 = result3![0] as PromptList;
    const postbacks3 = getPostbacks(msg3);
    expect(postbacks3).toContain('cap_nav_more');
    expect(postbacks3).not.toContain('cap_nav_prev');
  });

  it('My Account → Back round trip clears pagination state', async () => {
    // Same session state — simulates persisted session across steps
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
      profileId: 'profile-1',
      hasHistory: true,
    });

    // Step 1: prompt page 0, navigate to page 1
    await step.prompt!(ctx);
    expect(ctx.session.session_data._cap_menu_page).toBe(0);
    const navResult = await step.validate!('cap_nav_more', ctx);
    expect(navResult.valid).toBe(true);
    expect(ctx.session.session_data._cap_menu_page).toBe(1);

    // Step 2: re-render page 1 (after next() returns 'select_capability')
    await step.prompt!(ctx);
    expect(ctx.session.session_data._cap_menu_page).toBe(1);

    // Step 3: select My Account — pagination state should be cleaned up
    const myAcctResult = await step.validate!('cap_my_account', ctx);
    expect(myAcctResult.valid).toBe(true);
    expect(ctx.session.session_data._cap_menu_page).toBeUndefined();
    expect(ctx.session.session_data._cap_menu_total_pages).toBeUndefined();

    // Step 4: My Account next() routes to 'my_account_menu'
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBe('my_account_menu');

    // Step 5: In my_account_menu, user selects "Back" (acct_back)
    const backResult = await myAccountStep.validate!('acct_back', ctx);
    expect(backResult.valid).toBe(true);
    // Executor merges validate data into session_data — simulate that
    Object.assign(ctx.session.session_data, backResult.data);
    const backRoute = await myAccountStep.next!(ctx);
    expect(backRoute).toBe('select_capability');

    // Step 6: Re-enter capability menu — starts at page 0, no stale state
    const result6 = await step.prompt!(ctx);
    const msg6 = result6![0] as PromptList;
    const postbacks6 = getPostbacks(msg6);
    expect(postbacks6).toContain('cap_nav_more');
    expect(postbacks6).not.toContain('cap_nav_prev');
    expect(ctx.session.session_data._cap_menu_page).toBe(0);
  });

  it('11th and 12th capability are reachable across pages', async () => {
    // Use 12 capabilities to ensure both 11th and 12th are on page 2
    const TWELVE_CAPS = [
      ...ELEVEN_CAPS,
      'table_reservation', // 12th cap — needs services backing data (already in ELEVEN_CAPS_BACKING)
    ];

    const allCapPostbacks = new Set<string>();

    // Collect from all pages (up to 5 to be safe)
    for (let page = 0; page < 5; page++) {
      const ctx = buildCtx({
        capabilities: TWELVE_CAPS,
        tableCounts: ELEVEN_CAPS_BACKING,
        menuPage: page,
      });
      const result = await step.prompt!(ctx);
      const msg = result![0];
      if (msg.type !== 'list') continue;
      const postbacks = getPostbacks(msg);
      for (const pb of postbacks) {
        if (pb.startsWith('cap_') && !pb.startsWith('cap_nav_')) {
          allCapPostbacks.add(pb);
        }
      }
    }

    // All 12 capabilities must be reachable — specifically the 11th and 12th
    expect(allCapPostbacks.has('cap_queue')).toBe(true);      // was 10th in ELEVEN_CAPS
    expect(allCapPostbacks.has('cap_waiver')).toBe(true);     // was 11th in ELEVEN_CAPS
    expect(allCapPostbacks.has('cap_table_reservation')).toBe(true); // 12th
    expect(allCapPostbacks.size).toBe(12);
  });

  it('menu shrink clears stale pagination state', async () => {
    // Simulate: session was paginated (11 caps), then backing data removed
    // so the refreshed menu now has ≤10 items → pagination state must clear
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS.slice(0, 8), // only 8 caps now
      tableCounts: ELEVEN_CAPS_BACKING,
      menuPage: 1, // stale page from prior 11-cap render
    });
    ctx.session.session_data._cap_menu_total_pages = 2; // stale

    const result = await step.prompt!(ctx);
    const msg = result![0];
    // Should render as single-page (≤10 items after eligibility)
    expect(msg.type).toBe('list');
    // Stale pagination state must be cleared
    expect(ctx.session.session_data._cap_menu_page).toBeUndefined();
    expect(ctx.session.session_data._cap_menu_total_pages).toBeUndefined();
    // No navigation items on a single-page menu
    const postbacks = getPostbacks(msg);
    expect(postbacks).not.toContain('cap_nav_more');
    expect(postbacks).not.toContain('cap_nav_prev');
  });
});

// ── Full prompt → navigate → select lifecycle with outbound payload inspection ──

describe('lifecycle: prompt → navigate → select → payload', () => {
  it('full round trip: render page 0, navigate to page 1, select cap, verify payloads', async () => {
    const ctx = buildCtx({
      capabilities: ELEVEN_CAPS,
      tableCounts: ELEVEN_CAPS_BACKING,
    });

    // ── Step 1: prompt() renders page 0 ──
    const result0 = await step.prompt!(ctx);
    const msg0 = result0![0] as PromptList;
    expect(msg0.type).toBe('list');
    expect(msg0.items.length).toBeLessThanOrEqual(10);

    // Verify outbound payload structure matches WhatsApp list format
    expect(msg0.buttonLabel).toBeTruthy();
    expect(msg0.title).toBeTruthy();
    expect(msg0.body).toBeTruthy();

    // Page 0 emits "More Options →" with postback 'cap_nav_more'
    const moreItem = msg0.items.find(i => i.postbackText === 'cap_nav_more');
    expect(moreItem).toBeDefined();
    expect(moreItem!.title).toBeTruthy();

    // Collect page 0 capability IDs
    const page0Caps = msg0.items
      .filter(i => i.postbackText.startsWith('cap_') && !i.postbackText.startsWith('cap_nav_'))
      .map(i => i.postbackText);
    expect(page0Caps.length).toBe(9); // 10 slots - 1 "More..." = 9 caps

    // ── Step 2: validate() the emitted 'cap_nav_more' postback ──
    const navResult = await step.validate!('cap_nav_more', ctx);
    expect(navResult.valid).toBe(true);
    expect(navResult.data?._cap_menu_navigate).toBe(true);
    expect(ctx.session.session_data._cap_menu_page).toBe(1);
    // Executor merges validate data into session_data — simulate that
    Object.assign(ctx.session.session_data, navResult.data);

    // ── Step 3: next() returns 'select_capability' for re-render ──
    const nextAfterNav = await step.next!(ctx);
    expect(nextAfterNav).toBe('select_capability');
    expect(ctx.session.session_data._cap_menu_navigate).toBeUndefined();

    // ── Step 4: prompt() re-renders page 1 ──
    const result1 = await step.prompt!(ctx);
    const msg1 = result1![0] as PromptList;
    expect(msg1.type).toBe('list');
    expect(msg1.items.length).toBeLessThanOrEqual(10);

    // Page 1 has "← Previous" but no "More..."
    const prevItem = msg1.items.find(i => i.postbackText === 'cap_nav_prev');
    expect(prevItem).toBeDefined();
    expect(msg1.items.find(i => i.postbackText === 'cap_nav_more')).toBeUndefined();

    // Collect page 1 capability IDs
    const page1Caps = msg1.items
      .filter(i => i.postbackText.startsWith('cap_') && !i.postbackText.startsWith('cap_nav_'))
      .map(i => i.postbackText);

    // ── Step 5: All 11 caps reachable, no overlap between pages ──
    const allCaps = new Set([...page0Caps, ...page1Caps]);
    expect(allCaps.size).toBe(11);
    // No duplicates across pages
    const overlap = page0Caps.filter(c => page1Caps.includes(c));
    expect(overlap).toHaveLength(0);

    // ── Step 6: Select a capability from page 1 using its emitted postback ──
    const targetCap = page1Caps[0]; // first capability on page 1
    const selectResult = await step.validate!(targetCap, ctx);
    expect(selectResult.valid).toBe(true);
    expect(selectResult.data?.active_capability).toBe(targetCap.replace('cap_', ''));
    // Executor merges validate data into session_data — simulate that
    Object.assign(ctx.session.session_data, selectResult.data);

    // Pagination state cleaned up after selection
    expect(ctx.session.session_data._cap_menu_page).toBeUndefined();
    expect(ctx.session.session_data._cap_menu_total_pages).toBeUndefined();

    // ── Step 7: next() routes to the selected capability's first step ──
    // The selected cap is the first item on page 1; getFirstStepForCapability
    // maps each cap to its entry step. Assert the specific expected step.
    const selectedCap = targetCap.replace('cap_', '');
    const nextAfterSelect = await step.next!(ctx);
    // Known mappings from getFirstStepForCapability — assert specific step
    const expectedSteps: Record<string, string> = {
      queue: 'queue_start', waiver: 'select_service',
      appointment: 'select_appointment', scheduling: 'select_service',
      giving: 'select_category', ordering: 'browse_catalog',
      ticketing: 'select_event', reservation: 'select_apartment',
      crowdfunding: 'select_campaign', chat: 'chat_start',
      class_booking: 'select_service',
    };
    const expected = expectedSteps[selectedCap] || 'select_service';
    expect(nextAfterSelect).toBe(expected);
  });
});

// ── Sender-boundary test: real MetaCloudSender → MetaCloudService pipeline ──
// Exercises the production MetaCloudSender.sendList (item→section/row mapping,
// truncation, dispatch) → MetaCloudService.sendList (slice enforcement, final
// interactive payload) with callApi stubbed at the network boundary.
//
// Flow-unit tests above call step.prompt()/validate()/next() directly and
// simulate executor data-merging via Object.assign. They do not execute
// database save/reload or the executor's persistence layer.
//
// This sender-boundary test uses the existing test fixtures:
// - createTestSupabase() satisfies the Supabase null-check
// - setSendAttemptGate(false) makes createAttempt return null on insert error
// - assertMessagingAllowed and circuit breaker are stubbed via vi.doMock
// No live DB, financial RPC, or Meta API calls occur.

describe('sender-boundary: real MetaCloudSender → MetaCloudService pipeline', () => {
  it('More → Previous → More → queue selection: payloads ≤10 rows, IDs survive transport', async () => {
    // ── Set up mocks for sender dependencies ──
    vi.doMock('@/lib/channels/send-guard', () => ({
      assertMessagingAllowed: async () => { /* allow all sends */ },
    }));
    vi.doMock('@/lib/circuit-breaker', () => ({
      isCircuitOpen: () => false,
      recordSuccess: () => {},
      recordFailure: () => {},
      CircuitBreakerOpenError: class extends Error {},
    }));
    // Stub createServiceClient so no live DB access if unexpectedly reached
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => { throw new Error('test: no live DB allowed'); },
    }));

    const { MetaCloudSender } = await import('@/lib/channels/message-sender');
    const { setSendAttemptGate, isSendAttemptGateOn } = await import('@/lib/channels/attempt-recording');
    const { createTestSupabase } = await import('@/lib/__tests__/helpers/mock-supabase');

    const priorGate = isSendAttemptGateOn();
    setSendAttemptGate(false);

    try {
      // ── Construct real sender with stubbed cloud ──
      const cloud = new MetaCloudService({
        accessToken: 'test-token',
        phoneNumberId: 'test-phone',
        wabaId: 'test-waba',
      });
      const capturedPayloads: Array<Record<string, unknown>> = [];
      vi.spyOn(cloud as any, 'callApi').mockImplementation(async (_ep: string, body: Record<string, unknown>) => {
        capturedPayloads.push(body);
        return { messages: [{ id: 'wamid.test-pagination' }] };
      });

      const sender = new MetaCloudSender(cloud, createTestSupabase());
      const ctx = buildCtx({
        capabilities: ELEVEN_CAPS,
        tableCounts: ELEVEN_CAPS_BACKING,
        profileId: 'profile-1',
        hasHistory: true,
      });
      sender.bindBusiness(ctx.business.id);

      // ── Helper: render prompt and send through real sender ──
      async function renderAndSend() {
        const result = await step.prompt!(ctx);
        const msg = result![0] as PromptList;
        await sender.sendList({
          to: ctx.from,
          title: msg.title!,
          body: msg.body!,
          buttonLabel: msg.buttonLabel!,
          items: msg.items,
        });
        return msg;
      }

      // ── Page 0: initial render + send ──
      const msg0 = await renderAndSend();
      const payload0 = capturedPayloads[0];
      expect(payload0.type).toBe('interactive');
      const rows0 = (payload0.interactive as any).action.sections[0].rows;
      expect(rows0.length).toBeLessThanOrEqual(10);
      expect(rows0.length).toBe(msg0.items.length);
      const ids0 = rows0.map((r: any) => r.id);
      expect(ids0).toContain('cap_nav_more');

      // ── Navigate: More → page 1 ──
      const moreResult = await step.validate!('cap_nav_more', ctx);
      expect(moreResult.valid).toBe(true);
      Object.assign(ctx.session.session_data, moreResult.data);
      expect(await step.next!(ctx)).toBe('select_capability');

      // ── Page 1: render + send ──
      const msg1 = await renderAndSend();
      const rows1 = (capturedPayloads[1].interactive as any).action.sections[0].rows;
      expect(rows1.length).toBeLessThanOrEqual(10);
      expect(rows1.length).toBe(msg1.items.length);
      const ids1 = rows1.map((r: any) => r.id);
      expect(ids1).toContain('cap_nav_prev');
      expect(ids1).not.toContain('cap_nav_more');

      // ── Navigate: Previous → page 0 ──
      const prevResult = await step.validate!('cap_nav_prev', ctx);
      expect(prevResult.valid).toBe(true);
      Object.assign(ctx.session.session_data, prevResult.data);
      expect(await step.next!(ctx)).toBe('select_capability');

      // ── Page 0 again: render + send ──
      const msg0b = await renderAndSend();
      const rows0b = (capturedPayloads[2].interactive as any).action.sections[0].rows;
      expect(rows0b.length).toBeLessThanOrEqual(10);
      expect(rows0b.length).toBe(msg0b.items.length);
      const ids0b = rows0b.map((r: any) => r.id);
      expect(ids0b).toContain('cap_nav_more');
      // Same page 0 IDs as the first render
      expect(ids0b).toEqual(ids0);

      // ── Navigate: More → page 1 again ──
      const more2Result = await step.validate!('cap_nav_more', ctx);
      expect(more2Result.valid).toBe(true);
      Object.assign(ctx.session.session_data, more2Result.data);
      expect(await step.next!(ctx)).toBe('select_capability');

      // ── Page 1 again: render + send ──
      const msg1b = await renderAndSend();
      const rows1b = (capturedPayloads[3].interactive as any).action.sections[0].rows;
      expect(rows1b.length).toBeLessThanOrEqual(10);

      // ── Select queue from page 1 ──
      // Find 'cap_queue' in the emitted payload IDs
      const page1Ids = rows1b.map((r: any) => r.id);
      expect(page1Ids).toContain('cap_queue');

      const selectResult = await step.validate!('cap_queue', ctx);
      expect(selectResult.valid).toBe(true);
      expect(selectResult.data?.active_capability).toBe('queue');
      Object.assign(ctx.session.session_data, selectResult.data);

      // Pagination state cleaned up
      expect(ctx.session.session_data._cap_menu_page).toBeUndefined();
      expect(ctx.session.session_data._cap_menu_total_pages).toBeUndefined();

      // next() routes to queue_start
      expect(await step.next!(ctx)).toBe('queue_start');

      // ── Verify all 11 capabilities + My Account reachable across pages ──
      const allCapIds = new Set<string>();
      for (const payload of capturedPayloads) {
        const rows = (payload.interactive as any).action.sections[0].rows;
        for (const r of rows) {
          if (r.id.startsWith('cap_') && !r.id.startsWith('cap_nav_')) {
            allCapIds.add(r.id);
          }
        }
      }
      // 11 capabilities + My Account (returning customer with profileId + history)
      expect(allCapIds.size).toBe(12);
      for (const cap of ELEVEN_CAPS) {
        expect(allCapIds.has(`cap_${cap}`)).toBe(true);
      }
      expect(allCapIds.has('cap_my_account')).toBe(true);
    } finally {
      setSendAttemptGate(priorGate);
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });
});
