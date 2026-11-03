/** Single-item response regressions: real executor/flows, mocked persistence and sender. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlowExecutor } from '../executor';

// Mock Sentry (imported by executor)
vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

// Mock the promotions entry helper
vi.mock('@/lib/promotions/entry', () => ({
  getActivePromoEntryCampaigns: vi.fn().mockResolvedValue([
    { id: 'camp-1', name: 'TROPHY Promo', keyword: 'TROPHY', code_entry_mode: 'keyword', accept_bare_codes: false },
  ]),
  hasActivePromoCampaigns: vi.fn().mockResolvedValue(true),
  renderPromoEntryMessage: vi.fn().mockReturnValue('🎰 *TROPHY Promo*\n\nSend: *TROPHY <your code>*'),
}));

// Mock supabase service client (used by getCapabilityCustomLabels)
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }),
}));

// Track what messages are sent and what steps are visited
let sentMessages: PromptMessage[] = [];
let visitedSteps: string[] = [];

type PromptMessage = { type: string; text?: string; body?: string; [key: string]: unknown };

// Build mock supabase for FlowExecutor (needs CAS, overrides, etc.)
function buildExecutorSupabase() {
  const chain = (): Record<string, any> => {
    const c: Record<string, any> = {};
    c.select = vi.fn().mockReturnValue(c);
    c.insert = vi.fn().mockReturnValue(c);
    c.update = vi.fn().mockReturnValue(c);
    c.delete = vi.fn().mockReturnValue(c);
    c.eq = vi.fn().mockReturnValue(c);
    c.neq = vi.fn().mockReturnValue(c);
    c.or = vi.fn().mockReturnValue(c);
    c.is = vi.fn().mockReturnValue(c);
    c.not = vi.fn().mockReturnValue(c);
    c.in = vi.fn().mockReturnValue(c);
    c.ilike = vi.fn().mockReturnValue(c);
    c.like = vi.fn().mockReturnValue(c);
    c.gt = vi.fn().mockReturnValue(c);
    c.gte = vi.fn().mockReturnValue(c);
    c.lt = vi.fn().mockReturnValue(c);
    c.lte = vi.fn().mockReturnValue(c);
    c.order = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockReturnValue(c);
    c.range = vi.fn().mockReturnValue(c);
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  };

  return {
    from: vi.fn((table: string) => {
      const c = chain();
      if (table === 'bot_step_overrides') {
        // No overrides
      }
      if (table === 'appointments') { c.order = vi.fn().mockResolvedValue({ data: [{ id: 'appt-1', name: 'Test appointment', price: 100, duration_minutes: 30 }] }); }
      if (table === 'profiles') {
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      }
      return c;
    }),
    rpc: vi.fn().mockImplementation(async (name: string) => {
      if (name === 'update_session_cas') {
        return { data: { success: true, version: 2 }, error: null };
      }
      if (name === 'get_upcoming_class_sessions') return { data: [{ id: 'session-one', session_date: '2099-01-01', start_time: '10:00', end_time: '11:00', capacity: 10, booked_count: 0, available_spots: 10 }], error: null };
      if (name === 'deactivate_session_atomic') {
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }),
  };
}

function buildSender() {
  return {
    sendText: vi.fn(async (opts: { to: string; text: string }) => {
      sentMessages.push({ type: 'text', text: opts.text });
      return {};
    }),
    sendButtons: vi.fn(async (opts: any) => {
      sentMessages.push({ type: 'buttons', body: opts.body, ...opts });
      return {};
    }),
    sendList: vi.fn(async (opts: any) => {
      sentMessages.push({ type: 'list', body: opts.body, ...opts });
      return {};
    }),
    sendDocument: vi.fn().mockResolvedValue({}),
    sendImage: vi.fn().mockResolvedValue({}),
    markAsRead: vi.fn().mockResolvedValue({}),
  };
}

beforeEach(() => {
  sentMessages = [];
  visitedSteps = [];
});

describe('Appointment singleton reproduction', () => {
  it('emits a prompt when advancing into singleton appointment selection', async () => {
    const sb = buildExecutorSupabase();
    const sender = buildSender();
    const executor = new FlowExecutor(sb as any, sender as any, {} as any, {} as any);
    const session = { id: 'repro', user_id: 'user-1', business_id: 'biz-1', current_step: 'select_capability', session_data: { active_capability: 'appointment' }, version: 1 };
    const business = { id: 'biz-1', name: 'Test', country_code: 'NG', flow_type: 'scheduling' };
    const ctx = { session, business, supabase: sb };
    await (executor as any).advanceToStep(session, 'select_appointment', '+2341234567890', ctx, {}, sender);
    expect(session.session_data).toMatchObject({ service_id: 'appt-1', skip_service: true });
    expect(sentMessages.length).toBeGreaterThan(0);
    expect(session.current_step).toBe('select_date');
  });
});

import { appointmentFlow } from '../appointment.flow';
describe('appointment selection boundaries', () => {
  it.each([0, 2])('preserves selection with %i active appointments despite stale skip flag', async (count) => {
    const rows = Array.from({ length: count }, (_, i) => ({ id: `appt-${i}`, name: `Appointment ${i}`, price: 100 }));
    const chain: any = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockResolvedValue({ data: rows }) };
    const ctx: any = { business: { id: 'biz-1', name: 'Test', country_code: 'NG' }, session: { session_data: { skip_service: true } }, supabase: { from: vi.fn().mockReturnValue(chain) } };
    const step = appointmentFlow.steps[0];
    expect(await step.skipIf!(ctx)).toBe(false);
    const messages = await step.prompt(ctx);
    expect(messages[0].type).toBe(count === 0 ? 'buttons' : 'list');
    expect(chain.eq).toHaveBeenCalledWith('business_id', 'biz-1');
    expect(chain.eq).toHaveBeenCalledWith('is_active', true);
  });
});

describe('other singleton capability executor responses', () => {
  it.each([
    ['rsvp', 'rsvp_welcome', 'unused', 'rsvp_welcome'],
    ['ordering', 'select_variant', 'product_variants', 'select_variant'],
    ['ticketing', 'select_ticket_type', 'event_ticket_types', 'select_ticket_type'],
    ['scheduling', 'select_service', 'services', 'select_date'],
    ['class_booking', 'select_service', 'services', 'select_class_session'],
    ['payment', 'select_category', 'services', 'select_category'],
    ['ticketing', 'select_event', 'events', 'select_event'],
    ['reservation', 'select_apartment', 'properties', 'select_checkin'],
    ['crowdfunding', 'select_campaign', 'campaigns', 'select_campaign'],
    ['invoice', 'invoice_list', 'invoices', 'invoice_list'],
    ['recurring', 'list_subscriptions', 'customer_subscriptions', 'list_subscriptions'],
    ['survey', 'survey_question', 'unused', 'survey_question'],
    ['poll', 'poll_question', 'unused', 'poll_question'],
    ['chat', 'chat_start', 'unused', 'chat_start'],
    ['feedback', 'feedback_rating', 'unused', 'feedback_rating'],
    ['waitlist', 'waitlist_join', 'unused', 'waitlist_join'],
    ['queue', 'queue_start', 'queue_entries', 'queue_start'],
    ['loyalty', 'loyalty_menu', 'loyalty_points', 'loyalty_menu'],
    ['promo_verification', 'promo_entry', 'unused', 'promo_entry'],
    ['ordering', 'browse_catalog', 'products', 'browse_catalog'],
    ['giving', 'select_category', 'services', 'select_category'],
    ['table_reservation', 'select_table', 'seating_resources', 'select_date'],
  ])('%s emits a response for one item', async (capability, step, table, expectedStep) => {
    const sb = buildExecutorSupabase();
    const originalFrom = sb.from;
    sb.from = vi.fn((name: string) => {
      if (name !== table) return originalFrom(name);
      const c: any = {};
      for (const method of ['select', 'eq', 'neq', 'is', 'order', 'limit', 'or', 'in', 'gte', 'lt']) c[method] = vi.fn().mockReturnValue(c);
      c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'one', points_balance: 100, queue_number: 1, status: 'waiting' } });
      c.then = (resolve: any) => resolve({ data: [{ label: 'Only variant', stock_quantity: 10, is_active: true, title: 'Only campaign', goal_amount: 1000, raised_amount: 0, total_amount: 100, reference_code: 'INV-1', amount: 100, frequency: 'monthly', date: '2099-01-01', total_tickets: 10, tickets_sold: 0, is_class: capability === 'class_booking', class_schedule: [], id: 'one', name: 'Only item', price: 100, capacity: 4, min_party_size: 1, resource_type: 'table', reservation_duration_minutes: 60, track_inventory: false, has_variants: false }], error: null });
      return c;
    });
    const sender = buildSender();
    const executor = new FlowExecutor(sb as any, sender as any, {} as any, {} as any);
    const session = { id: 'singleton', user_id: 'user', business_id: 'biz', current_step: 'select_capability', session_data: { current_product_id: 'one', current_product_name: 'Only product', event_id: 'one', active_capability: capability, survey_questions: [{ id: 'q1', type: 'choice', text: 'One question', options: ['One option'] }], poll_question: 'One poll', poll_options: ['One option'] }, version: 1 };
    const business = { id: 'biz', name: 'Test', country_code: 'NG', flow_type: 'scheduling', metadata: {} };
    await (executor as any).advanceToStep(session, step, '+2341234567890', { session, business, supabase: sb, copyLang: 'en', from: '+2341234567890', sender, t: async (text: string) => text }, {}, sender);
    expect(sentMessages.length).toBeGreaterThan(0);
    expect(session.current_step).toBe(expectedStep);
  });
});

import { getExtendedFlowDefinition } from '../registry';
describe('single waiver inline response', () => {
  it('sends a signing link during capability validation', async () => {
    const chain: any = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockResolvedValue({ data: [{ id: 'one', title: 'Only waiver', token: 'test-token' }] }) };
    const sender = buildSender();
    const ctx: any = { business: { id: 'biz', category: 'other' }, session: { session_data: { capabilities: ['waiver'] } }, supabase: { from: vi.fn().mockReturnValue(chain) }, from: '+2341234567890', sender, t: async (s: string) => s, copyLang: 'en' };
    const step = getExtendedFlowDefinition('capability-selection')!.steps[0];
    expect((await step.validate('cap_waiver', ctx)).valid).toBe(true);
    expect(sentMessages.some(m => m.text?.includes('/w/test-token'))).toBe(true);
  });
});
