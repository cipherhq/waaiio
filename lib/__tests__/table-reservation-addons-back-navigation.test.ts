/**
 * Table reservations: pressing "back" onto an old add-ons step must not crash.
 *
 * A customer can reach the add-ons step in an ordinary booking, switch to a
 * table reservation by keyword (the switch keeps _step_history), and then press
 * "back" until that old select_addons entry comes up. The executor's back
 * command re-shows a step's prompt without running its skipIf, and the table
 * skip in select_addons has already deleted _available_addons. The prompt must
 * not assume the list exists, and a table must never be offered add-ons.
 *
 * Runs through the real FlowExecutor and the real scheduling flow.
 * Review finding P2-1 on PR #850.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlowExecutor } from '@/lib/bot/flows/executor';
import { createMockContext, getStep } from '@/lib/bot/flows/__tests__/helpers';
import { schedulingFlow } from '@/lib/bot/flows/scheduling.flow';

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

type Sent = { kind: string; payload: Record<string, unknown> };
let sent: Sent[] = [];
let casCalls: Array<Record<string, unknown>> = [];

function buildExecutorSupabase(stepOverrides: Array<Record<string, unknown>> = []) {
  const chain = (table: string): Record<string, any> => {
    const c: Record<string, any> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'or', 'is', 'not', 'in', 'ilike', 'like', 'gt', 'gte', 'lt', 'lte', 'order', 'limit', 'range']) {
      c[m] = vi.fn().mockReturnValue(c);
    }
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const rows = table === 'bot_step_overrides' ? stepOverrides : [];
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null, count: 0 });
    return c;
  };
  return {
    from: vi.fn((table: string) => chain(table)),
    rpc: vi.fn(async (name: string, params: Record<string, unknown>) => {
      if (name === 'update_session_cas') {
        casCalls.push(params);
        return { data: { success: true, version: 2 }, error: null };
      }
      return { data: null, error: null };
    }),
  };
}

function buildSender() {
  const record = (kind: string) => vi.fn(async (payload: Record<string, unknown>) => {
    sent.push({ kind, payload });
    return {};
  });
  return {
    sendText: record('text'),
    sendButtons: record('buttons'),
    sendList: record('list'),
    sendDocument: vi.fn().mockResolvedValue({}),
    sendImage: vi.fn().mockResolvedValue({}),
    markAsRead: vi.fn().mockResolvedValue({}),
  };
}

const business = {
  id: 'biz-table', name: 'Table Bistro', slug: 'table-bistro',
  category: 'restaurant', flow_type: 'scheduling',
  subscription_tier: 'growth', trial_ends_at: null,
  metadata: {}, country_code: 'NG',
};

/** Session after: ordinary booking reached add-ons → keyword switch to a table → back presses. */
function tableSessionBackOntoOldAddons(extra: Record<string, unknown> = {}) {
  return {
    id: 'sess-table-back',
    user_id: 'user-1',
    business_id: 'biz-table',
    current_step: 'select_table',
    session_data: {
      active_capability: 'table_reservation',
      capabilities: ['scheduling', 'table_reservation'],
      _is_table_reservation: true,
      seating_resource_id: 'seat-1',
      seating_resource_name: 'Patio Table 3',
      _seating_min_party: 2,
      _seating_capacity: 6,
      _seating_deposit: 5000,
      // The table skip already deleted _available_addons; a stale selection may remain.
      _selected_addons: [{ id: 'a1', name: 'Cake', price: 5000 }],
      _step_history: ['select_service', 'select_date', 'select_time', 'select_addons', 'select_table'],
      ...extra,
    },
    conversation_log: [],
    version: 1,
  };
}

const textOf = (v: unknown) => JSON.stringify(v);
const GENERIC_ERROR = /something went wrong|went wrong/i;

beforeEach(() => {
  sent = [];
  casCalls = [];
});

describe('table reservation: back onto an old add-ons step (real executor)', () => {
  it('does not crash and shows the party-size prompt instead of add-ons', async () => {
    const executor = new FlowExecutor(buildExecutorSupabase() as any, buildSender() as any, {} as any, {} as any);
    const session = tableSessionBackOntoOldAddons();

    await executor.execute('+2348000000001', 'back', session as any, business as any);

    const all = textOf(sent);
    expect(all).not.toMatch(GENERIC_ERROR);
    // The customer sees the table party-size prompt, never an add-ons list.
    expect(all).toContain('How many guests will be dining?');
    expect(all).not.toContain('skip_addons');
    expect(all).not.toContain('Cake');
    // Add-on state carried over from the earlier booking is cleared.
    expect(session.session_data).not.toHaveProperty('_available_addons');
    expect(session.session_data).not.toHaveProperty('_selected_addons');
    // Back popped history onto select_addons, which was persisted.
    expect(casCalls.at(-1)?.p_current_step).toBe('select_addons');
  });

  it('the next reply moves the table on to party size without add-ons', async () => {
    const executor = new FlowExecutor(buildExecutorSupabase() as any, buildSender() as any, {} as any, {} as any);
    const session = tableSessionBackOntoOldAddons();
    session.current_step = 'select_addons';
    session.session_data._step_history = ['select_service', 'select_date', 'select_time', 'select_addons'];

    await executor.execute('+2348000000001', '4', session as any, business as any);

    const all = textOf(sent);
    expect(all).not.toMatch(GENERIC_ERROR);
    expect(all).toContain('How many guests will be dining?');
    expect(all).not.toContain('skip_addons');
    expect(casCalls.at(-1)?.p_current_step).toBe('select_quantity');
  });

  it("a merchant 'require' override on select_addons (bypasses skipIf) still gives a table no add-ons", async () => {
    const overrides = [{ step_id: 'select_addons', action: 'require', custom_prompt: null, custom_options: null, branch_conditions: null }];
    const executor = new FlowExecutor(buildExecutorSupabase(overrides) as any, buildSender() as any, {} as any, {} as any);
    // Distinct business id: loadOverrides caches per business and flow type.
    const requireBusiness = { ...business, id: 'biz-table-require' };
    const session = tableSessionBackOntoOldAddons();
    session.business_id = 'biz-table-require';
    session.current_step = 'select_addons';

    await executor.execute('+2348000000001', '', session as any, requireBusiness as any);

    const all = textOf(sent);
    expect(all).not.toMatch(GENERIC_ERROR);
    expect(all).toContain('How many guests will be dining?');
    expect(all).not.toContain('skip_addons');
    expect(session.session_data).not.toHaveProperty('_selected_addons');
    // nextAfterPrompt moves the session on, so the reply is read as party size.
    expect(casCalls.at(-1)?.p_current_step).toBe('select_quantity');
  });

  it("'require' override + back + reply: a table moves on to party size instead of looping on add-ons", async () => {
    const overrides = [{ step_id: 'select_addons', action: 'require', custom_prompt: null, custom_options: null, branch_conditions: null }];
    const executor = new FlowExecutor(buildExecutorSupabase(overrides) as any, buildSender() as any, {} as any, {} as any);
    const requireBusiness = { ...business, id: 'biz-table-require-back' };
    const session = tableSessionBackOntoOldAddons();
    session.business_id = 'biz-table-require-back';
    // Back left current_step on select_addons (back does not apply nextAfterPrompt).
    session.current_step = 'select_addons';
    session.session_data._step_history = ['select_service', 'select_date', 'select_time', 'select_addons'];

    await executor.execute('+2348000000001', '4', session as any, requireBusiness as any);

    const all = textOf(sent);
    expect(all).not.toMatch(GENERIC_ERROR);
    expect(all).not.toMatch(/select an add-on/i);
    expect(all).toContain('How many guests will be dining?');
    expect(casCalls.at(-1)?.p_current_step).toBe('select_quantity');
  });
});

describe('select_addons prompt guards', () => {
  it('table reservation: moves on to select_quantity after the prompt', () => {
    const ctx = createMockContext();
    ctx.session.session_data = { _is_table_reservation: true };
    const nap = getStep(schedulingFlow, 'select_addons').nextAfterPrompt;
    expect(typeof nap === 'function' ? nap(ctx) : nap).toBe('select_quantity');
  });

  it('ordinary booking: keeps current_step on select_addons after the prompt', () => {
    const ctx = createMockContext();
    ctx.session.session_data = { _available_addons: [] };
    const nap = getStep(schedulingFlow, 'select_addons').nextAfterPrompt;
    expect(typeof nap === 'function' ? nap(ctx) : nap).toBeUndefined();
  });

  it('ordinary booking with no add-on list in session: shows only the no-add-ons choice, no crash', async () => {
    const ctx = createMockContext();
    ctx.session.session_data = { service_id: 'svc-1' };
    const msgs = await getStep(schedulingFlow, 'select_addons').prompt(ctx);
    expect(msgs).toHaveLength(1);
    const list = msgs[0] as { type: string; items: Array<{ postbackText: string }> };
    expect(list.type).toBe('list');
    expect(list.items.map(i => i.postbackText)).toEqual(['skip_addons']);
  });

  it('ordinary booking with optional add-ons: unchanged list', async () => {
    const ctx = createMockContext();
    ctx.session.session_data = {
      _available_addons: [
        { id: 'a1', name: 'Cake', price: 5000, is_required: false },
        { id: 'a2', name: 'Wash', price: 1000, is_required: true },
      ],
    };
    const msgs = await getStep(schedulingFlow, 'select_addons').prompt(ctx);
    const list = msgs[0] as { type: string; items: Array<{ postbackText: string }> };
    expect(list.items.map(i => i.postbackText)).toEqual(['a1', 'skip_addons']);
  });
});
