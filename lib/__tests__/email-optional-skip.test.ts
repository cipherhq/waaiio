/**
 * The bot's email question is optional everywhere (Owner decision 2026-11-26).
 *
 * Ordering, booking (scheduling) and table/restaurant reservation all ask
 * "Want a copy by email?" with a Skip button. A Skip tap (button id
 * `skip_email`) or a typed "skip" saves no email and moves the flow on.
 *
 * Runs the real FlowExecutor with the real flow definitions, so the button id
 * travels the same path as a WhatsApp button reply: collect_email is a
 * FREE_TEXT_STEP, so the id reaches the step's validate() untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlowExecutor } from '@/lib/bot/flows/executor';
import { createMockContext, getStep } from '@/lib/bot/flows/__tests__/helpers';
import { orderingFlow } from '@/lib/bot/flows/ordering.flow';
import { schedulingFlow } from '@/lib/bot/flows/scheduling.flow';
import { reservationFlow } from '@/lib/bot/flows/reservation.flow';
import { getFlowCopy } from '@/lib/bot/flows/flow-localization';
import type { FlowDefinition } from '@/lib/bot/flows/types';

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

type Sent = { kind: string; payload: Record<string, unknown> };
let sent: Sent[] = [];
let casCalls: Array<Record<string, unknown>> = [];
let writes: Array<{ table: string; op: string; row: unknown }> = [];

function buildExecutorSupabase() {
  const chain = (table: string): Record<string, any> => {
    const c: Record<string, any> = {};
    for (const m of ['select', 'delete', 'eq', 'neq', 'or', 'is', 'not', 'in', 'ilike', 'like', 'gt', 'gte', 'lt', 'lte', 'order', 'limit', 'range']) {
      c[m] = vi.fn().mockReturnValue(c);
    }
    for (const op of ['insert', 'update', 'upsert']) {
      c[op] = vi.fn((row: unknown) => { writes.push({ table, op, row }); return c; });
    }
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
    return c;
  };
  return {
    from: vi.fn((table: string) => chain(table)),
    rpc: vi.fn(async (name: string, params: Record<string, unknown>) => {
      if (name === 'update_session_cas') {
        casCalls.push(params);
        return { data: { success: true, version: casCalls.length + 1 }, error: null };
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

const cases: Array<{ name: string; flow: FlowDefinition; flowType: string; capability: string; next: string }> = [
  { name: 'ordering', flow: orderingFlow, flowType: 'ordering', capability: 'ordering', next: 'review_order_summary' },
  { name: 'scheduling', flow: schedulingFlow, flowType: 'scheduling', capability: 'scheduling', next: 'create_booking' },
  { name: 'reservation', flow: reservationFlow, flowType: 'reservation', capability: 'reservation', next: 'create_reservation' },
];

function businessFor(c: typeof cases[number], suffix: string) {
  return {
    id: `biz-email-${c.name}-${suffix}`, name: 'Email Test Biz', slug: 'email-test',
    category: 'restaurant', flow_type: c.flowType,
    subscription_tier: 'growth', trial_ends_at: null,
    metadata: {}, country_code: 'NG',
  };
}

function sessionAtCollectEmail(c: typeof cases[number], businessId: string) {
  return {
    id: `sess-email-${c.name}`,
    user_id: 'user-1',
    business_id: businessId,
    current_step: 'collect_email',
    session_data: {
      active_capability: c.capability,
      capabilities: [c.capability],
      first_name: 'Ada',
      last_name: 'Okafor',
      _step_history: ['collect_name', 'collect_email'],
    } as Record<string, unknown>,
    conversation_log: [],
    version: 1,
  };
}

beforeEach(() => {
  sent = [];
  casCalls = [];
  writes = [];
});

describe('collect_email prompt offers a Skip button in every flow', () => {
  it.each(cases)('$name: buttons prompt with skip_email id and optional copy', async ({ flow }) => {
    const ctx = createMockContext();
    const messages = await getStep(flow, 'collect_email').prompt(ctx);
    expect(messages).toHaveLength(1);
    const [msg] = messages as Array<Record<string, any>>;
    expect(msg.type).toBe('buttons');
    expect(msg.body).toMatch(/Want a copy by email\? Type your email or tap \*Skip\*/);
    expect(msg.buttons).toEqual([{ id: 'skip_email', title: 'Skip' }]);
  });

  it.each(['en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es'])('%s: copy names the same Skip button title it shows', lang => {
    const skipTitle = getFlowCopy(lang, 'booking.skip');
    expect(skipTitle.length).toBeLessThanOrEqual(20);
    for (const key of ['booking.collect_email', 'ordering.collect_email', 'booking.invalid_email', 'ordering.invalid_email']) {
      expect(getFlowCopy(lang, key), `${lang}.${key}`).toContain(`*${skipTitle}*`);
    }
  });
});

describe('collect_email skip through the real executor', () => {
  for (const c of cases) {
    for (const [label, input] of [['Skip button tap', 'skip_email'], ['typed skip', 'skip'], ['typed SKIP with spaces', '  SKIP ']] as const) {
      it(`${c.name}: ${label} saves no email and moves on to ${c.next}`, async () => {
        const business = businessFor(c, label.replace(/\W+/g, '-'));
        const executor = new FlowExecutor(buildExecutorSupabase() as any, buildSender() as any, {} as any, {} as any);
        const session = sessionAtCollectEmail(c, business.id);

        await executor.execute('+2348000000001', input, session as any, business as any);

        // No email kept in the session and nothing written to the store customer profile.
        expect(session.session_data.email).toBeUndefined();
        expect(session.session_data.customer_email).toBeUndefined();
        expect(writes.filter(w => w.table === 'customer_profiles')).toEqual([]);
        // Not re-asked: no invalid-email error went out.
        expect(JSON.stringify(sent)).not.toMatch(/valid email/i);
        // The flow left collect_email for the next step.
        const steps = casCalls.map(call => call.p_current_step);
        expect(steps).toContain(c.next);
        expect(steps.at(-1)).not.toBe('collect_email');
      });
    }
  }
});

describe('collect_email still accepts a real email and rejects a bad one', () => {
  it.each(cases)('$name: valid email is saved', async c => {
    const ctx = createMockContext({
      session: { id: 's', user_id: 'u', business_id: 'b1', current_step: 'collect_email', version: 1, session_data: {} },
      business: { id: 'b1' },
    } as any);
    const result = await getStep(c.flow, 'collect_email').validate(' Ada@Example.com ', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.email).toBe('ada@example.com');
    if (c.flow === orderingFlow) expect(result.data?.customer_email).toBe('ada@example.com');
    expect(await getStep(c.flow, 'collect_email').next(ctx)).toBe(c.next);
  });

  it.each(cases)('$name: invalid email re-asks with the Skip button again', async c => {
    const business = businessFor(c, 'invalid');
    const executor = new FlowExecutor(buildExecutorSupabase() as any, buildSender() as any, {} as any, {} as any);
    const session = sessionAtCollectEmail(c, business.id);

    await executor.execute('+2348000000001', 'not-an-email', session as any, business as any);

    expect(session.current_step).toBe('collect_email');
    expect(session.session_data.email).toBeUndefined();
    const all = JSON.stringify(sent);
    expect(all).toContain("That doesn't look like a valid email. Type it again or tap *Skip*.");
    expect(all).toContain('skip_email');
  });
});
