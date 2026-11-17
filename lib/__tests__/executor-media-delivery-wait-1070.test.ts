/**
 * #1070: in a prompt batch, an image/document followed by another message is
 * awaited (bounded) until WhatsApp delivered it, so product/event images reach the
 * phone before the option list. Real FlowExecutor and real delivery-wait module;
 * the flow registry, guard counters and Supabase are faked.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetFlowStep } = vi.hoisted(() => ({ mockGetFlowStep: vi.fn() }));

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@/lib/bot/flows/analytics-flush', () => ({ flushExecutionAnalytics: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({ translateBotResponse: vi.fn(async (t: string) => t) }));
vi.mock('@/lib/bot/language-policy', () => ({
  getEffectiveLanguages: vi.fn(() => ({ tier: 'free', allowed: ['en'] })),
  loadBusinessLanguages: vi.fn(async () => null),
}));
vi.mock('@/lib/bot/conversation-guard', () => ({
  checkConversationLimit: vi.fn(async () => ({ allowed: true })),
  trackOutboundMessage: vi.fn(() => Promise.resolve()),
  getConversationLimitMessage: vi.fn(() => 'Limit reached'),
  checkSpendThresholds: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/lib/messaging/low-balance-alerts', () => ({ checkLowBalanceAlerts: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/bot/step-overrides', () => ({ loadOverrides: vi.fn(async () => new Map()), evaluateBranchConditions: vi.fn() }));
vi.mock('@/lib/bot/flow-analytics', () => ({ logDropoff: vi.fn() }));
vi.mock('@/lib/bot/flows/registry', () => ({
  getFlowStep: mockGetFlowStep,
  getFlowStepAcrossFlows: vi.fn(() => null),
  getFlowDefinition: vi.fn(),
  getExtendedFlowDefinition: vi.fn(),
}));

let FlowExecutor: typeof import('@/lib/bot/flows/executor').FlowExecutor;
beforeAll(async () => {
  ({ FlowExecutor } = await import('@/lib/bot/flows/executor'));
}, 60_000);

/** Ordered record of sends and delivery-wait database calls. */
let events: string[];

/** Supabase: CAS saves succeed; whatsapp_delivery_waits is in memory and reports
 *  'sent' on the first read of a WAMID and 'delivered' on the next (webhook arrived). */
function fakeSupabase() {
  const reads = new Map<string, number>();
  return {
    rpc: vi.fn((_fn: string, args: { p_expected_version: number }) =>
      Promise.resolve({ data: { success: true, version: (args?.p_expected_version ?? 0) + 1 }, error: null })),
    from: vi.fn((table: string) => {
      if (table !== 'whatsapp_delivery_waits') {
        return { update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: null, error: null })) })) };
      }
      return {
        upsert: (row: { wamid: string }) => { events.push(`register:${row.wamid}`); return Promise.resolve({ error: null }); },
        select: () => ({
          in: (_c: string, ids: string[]) => {
            const data = ids.map(id => {
              const n = (reads.get(id) || 0) + 1;
              reads.set(id, n);
              return { wamid: id, status: n === 1 ? 'sent' : 'delivered' };
            });
            events.push(`poll:${ids.join(',')}:${data.map(d => d.status).join(',')}`);
            return Promise.resolve({ data, error: null });
          },
        }),
        delete: () => ({ in: (_c: string, ids: string[]) => { events.push(`cleanup:${ids.join(',')}`); return Promise.resolve({ error: null }); } }),
      };
    }),
  };
}

/** Sender returning Meta-style WAMIDs (or none, like a non-Meta/preview sender). */
function sender(withWamids = true) {
  let n = 0;
  const reply = (kind: string) => async () => {
    n++;
    events.push(`send:${kind}`);
    return withWamids ? { success: true, messageId: `wamid.${kind}${n}` } : { success: true };
  };
  return {
    sendText: vi.fn(reply('text')),
    sendButtons: vi.fn(reply('buttons')),
    sendList: vi.fn(reply('list')),
    sendImage: vi.fn(reply('image')),
    sendDocument: vi.fn(reply('document')),
  };
}

const business = {
  id: 'biz-1', name: 'TestBiz', slug: 'testbiz', category: 'general' as never, flow_type: 'ordering' as never,
  subscription_tier: 'starter', trial_ends_at: null, metadata: {}, country_code: 'NG' as never,
};
function session() {
  return {
    id: 'sess-1070', user_id: null, business_id: 'biz-1', current_step: 'pick', version: 1,
    session_data: { active_capability: 'ordering', capabilities: ['ordering'] } as Record<string, unknown>,
    conversation_log: [{ role: 'user' as const, content: 'Hi', timestamp: '2026-11-16T00:00:00.000Z' }],
  };
}
function promptStep(messages: unknown[]) {
  mockGetFlowStep.mockImplementation((_f: string, id: string) => id === 'pick' ? {
    id: 'pick',
    async prompt() { return messages; },
    async validate() { return { valid: true }; },
    async next() { return null; },
  } : null);
}

const IMG = { type: 'image', imageUrl: 'https://cdn.example.com/p.png', caption: 'Red shirt' };
const DOC = { type: 'document', url: 'https://cdn.example.com/menu.pdf', filename: 'menu.pdf' };
const LIST = { type: 'list', title: 'Sizes', body: 'Pick a size', buttonLabel: 'Sizes', items: [{ title: 'M', postbackText: 'm' }] };

beforeEach(() => {
  vi.clearAllMocks();
  events = [];
});

describe('#1070 executor waits for media delivery before the next message', () => {
  it('product images are delivered before the option list (each image awaited in turn)', async () => {
    promptStep([IMG, IMG, LIST]);
    const ex = new FlowExecutor(fakeSupabase() as never, sender() as never, {} as never, {} as never);
    await ex.execute('+2348000000001', '', session(), business);
    expect(events).toEqual([
      'send:image',
      'register:wamid.image1', 'poll:wamid.image1:sent', 'poll:wamid.image1:delivered', 'cleanup:wamid.image1',
      'send:image',
      'register:wamid.image2', 'poll:wamid.image2:sent', 'poll:wamid.image2:delivered', 'cleanup:wamid.image2',
      'send:list',
    ]);
  });

  it('a document followed by text is awaited too', async () => {
    promptStep([DOC, { type: 'text', text: 'Anything else?' }]);
    const ex = new FlowExecutor(fakeSupabase() as never, sender() as never, {} as never, {} as never);
    await ex.execute('+2348000000001', '', session(), business);
    expect(events[0]).toBe('send:document');
    expect(events.at(-1)).toBe('send:text');
    expect(events).toContain('cleanup:wamid.document1');
  });

  it('does not wait when the media message is the last one', async () => {
    promptStep([LIST, IMG]);
    const ex = new FlowExecutor(fakeSupabase() as never, sender() as never, {} as never, {} as never);
    await ex.execute('+2348000000001', '', session(), business);
    expect(events).toEqual(['send:list', 'send:image']);
  });

  it('does not wait for senders that return no WhatsApp message id (non-Meta channels)', async () => {
    promptStep([IMG, LIST]);
    const ex = new FlowExecutor(fakeSupabase() as never, sender(false) as never, {} as never, {} as never);
    await ex.execute('+2348000000001', '', session(), business);
    expect(events).toEqual(['send:image', 'send:list']);
  });

  it('does not wait after text/interactive messages', async () => {
    promptStep([{ type: 'text', text: 'Hello' }, LIST]);
    const ex = new FlowExecutor(fakeSupabase() as never, sender() as never, {} as never, {} as never);
    await ex.execute('+2348000000001', '', session(), business);
    expect(events).toEqual(['send:text', 'send:list']);
  });
});
