/**
 * Customer updates opt-in on a first-time customer's welcome menu (Owner
 * decision 2026-11-06). Calls the real select_capability prompt against an
 * in-memory database.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createMemoryDb } from './helpers/memory-db';
import { createMockContext, getStep } from '@/lib/bot/flows/__tests__/helpers';

vi.mock('@/lib/promotions/history', () => ({ hasPromoHistory: vi.fn().mockResolvedValue(false) }));

const BIZ = '11111111-1111-4111-8111-111111111111';
const PHONE = '2348012345678';

async function welcome(opts: { greeting?: boolean; returning?: boolean; caps?: string[]; consents?: Array<Record<string, unknown>> } = {}) {
  const db: any = createMemoryDb({
    profiles: [], capability_custom_labels: [], customer_consents: opts.consents ?? [],
    messaging_opt_outs: [], launch_subscribers: [], bot_sessions: [], customer_profiles: [],
  });
  const { capabilitySelectionFlow } = await import('@/lib/bot/flows/capability-selection.flow');
  const ctx = createMockContext({ supabase: db });
  ctx.from = PHONE;
  ctx.session.business_id = BIZ;
  ctx.business = { ...ctx.business!, id: BIZ, name: 'Mama Put Kitchen', subscription_tier: 'growth', is_whitelabel: false };
  ctx.session.session_data = {
    capabilities: opts.caps ?? ['chat', 'queue'],
    ...(opts.greeting === false ? {} : { _greeting: 'Welcome to Mama Put Kitchen!' }),
    ...(opts.returning ? { _customer_history: { totalVisits: 3 } } : {}),
  };
  const step = getStep(capabilitySelectionFlow, 'select_capability');
  return step.prompt(ctx);
}

describe('Welcome menu: updates opt-in for first-time customers', () => {
  // Cold import of this module is slow on a busy machine; load it once up front.
  beforeAll(async () => { await import('@/lib/bot/flows/capability-selection.flow'); }, 120_000);

  it('first-time customer → menu is a list ending with the opt-in row (capabilities first, unchanged)', async () => {
    const [msg] = await welcome();
    expect(msg.type).toBe('list');
    if (msg.type !== 'list') return;
    expect(msg.body).toContain('Welcome to Mama Put Kitchen!');
    expect(msg.items.map(i => i.postbackText)).toEqual(['cap_chat', 'cap_queue', `updates_yes:welcome:${BIZ}`]);
    expect(msg.items[2].description).toBe('Offers & updates from Mama Put Kitchen and Waaiio. Stop anytime.');
    expect(msg._localization?.protectedValues).toEqual(expect.arrayContaining(['Mama Put Kitchen', 'Waaiio']));
  });

  it('returning customer → no opt-in on the welcome (they get it after their next transaction)', async () => {
    const [msg] = await welcome({ returning: true });
    expect(msg.type).toBe('buttons');
    if (msg.type === 'buttons') expect(msg.buttons.map(b => b.id)).toEqual(['cap_chat', 'cap_queue']);
  });

  it('menu shown again later in the chat (no greeting) → no opt-in', async () => {
    const [msg] = await welcome({ greeting: false });
    expect(msg.type).toBe('buttons');
  });

  it('already agreed → original buttons', async () => {
    const [msg] = await welcome({ consents: [{ id: 'c1', business_id: BIZ, phone: `+${PHONE}`, channel: 'whatsapp', purpose: 'marketing', status: 'granted', created_at: '2026-11-01T00:00:00Z' }] });
    expect(msg.type).toBe('buttons');
  });
});
