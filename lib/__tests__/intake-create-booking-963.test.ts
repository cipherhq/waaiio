/**
 * #963 lane 3: the intake hooks inside the bot's create_booking step, run on the
 * real step with a mock database (harness pattern from bot-unavailable-dates-919).
 *  - a submitted before-booking intake is linked to the new booking, and only then;
 *  - a prepared after-booking message goes before the next-steps menu, protected
 *    from translation.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowContext, PromptText } from '@/lib/bot/flows/types';
import { getStep } from '@/lib/bot/flows/__tests__/helpers';

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
const intake = vi.hoisted(() => ({
  link: vi.fn(async () => undefined),
  deliver: vi.fn(async () => ({ status: 'skipped', reason: 'no_after_intake' }) as Record<string, unknown>),
  sync: vi.fn(async () => undefined),
}));
vi.mock('@/lib/intake/send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/intake/send')>()),
  linkIntakeToBooking: intake.link,
  deliverAfterBookingIntake: intake.deliver,
  syncIntakeExpiry: intake.sync,
}));

const SAT = '2026-11-07';
const COMMITTED = {
  id: 'bk-new', service_id: 'svc-cut', appointment_id: null, party_size: 1, date: SAT, time: '10:00:00',
  class_session_id: null, staff_id: null, total_amount: 0, deposit_amount: 0,
};

function mockDb() {
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'or', 'in', 'is', 'not', 'gt', 'gte', 'lt', 'lte', 'order', 'limit', 'range']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.single = vi.fn(async () => ({ data: table === 'bookings' ? COMMITTED : null, error: null }));
    chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
    return chain;
  });
  const rpc = vi.fn((name: string) => {
    if (name === 'reschedule_booking_atomic') return Promise.resolve({ data: { rescheduled: true }, error: null });
    if (name === 'book_slot_authoritative_604') {
      return { single: async () => ({ data: { booking_id: 'bk-new', reference_code: 'REF12', slot_available: true }, error: null }) };
    }
    return Promise.resolve({ data: null, error: null });
  });
  return { from, rpc };
}

function ctxFor(sessionData: Record<string, unknown> = {}): FlowContext {
  return {
    supabase: mockDb() as never,
    sender: { sendText: vi.fn() } as never,
    standalone: {
      getBotTemplates: vi.fn(async () => ({})),
      checkTierLimits: vi.fn(async () => ({ allowed: true })),
      fillTemplate: vi.fn((t: string) => t),
    } as never,
    intelligence: { resetAbuse: vi.fn() } as never,
    t: async (s: string) => s,
    copyLang: 'en',
    from: '+2348000000000',
    session: {
      id: 'sess-963', user_id: 'user-1', business_id: 'biz-963', current_step: 'create_booking', version: 1,
      session_data: {
        first_name: 'Ada', last_name: 'Obi', party_size: 1, active_capability: 'scheduling',
        service_id: 'svc-cut', service_name: 'Assessment', service_price: 0, service_deposit: 0,
        service_duration: 60, _service_max_capacity: 1, _service_buffer_minutes: 0,
        _service_available_days: [], _service_requires_staff: false,
        date: SAT, time: '10:00', _action: 'confirm', ...sessionData,
      },
    },
    business: {
      id: 'biz-963', name: 'Healing Labs', slug: 'healing', category: 'salon' as never,
      flow_type: 'scheduling' as never, subscription_tier: 'growth', trial_ends_at: '',
      country_code: 'NG', operating_hours: {}, metadata: { require_terms_before_payment: false },
    },
  };
}

async function createStep() {
  const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
  return getStep(schedulingFlow, 'create_booking');
}

beforeAll(async () => { await import('@/lib/bot/flows/registry'); }, 60_000);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
  intake.link.mockClear();
  intake.deliver.mockClear();
  intake.sync.mockClear();
  intake.deliver.mockResolvedValue({ status: 'skipped', reason: 'no_after_intake' });
  vi.spyOn(await import('@/lib/capabilities/service'), 'getEnabledCapabilities').mockResolvedValue([]);
  vi.spyOn(await import('@/lib/tier-limits'), 'checkTierLimit').mockResolvedValue({ allowed: true } as never);
  vi.spyOn(await import('@/lib/bot/flows/shared/capability-guard'), 'requireCurrentCapability').mockResolvedValue({ allowed: true } as never);
  vi.spyOn(await import('@/lib/integrations/google-calendar'), 'syncBookingToCalendar').mockResolvedValue(undefined as never);
  vi.spyOn(await import('@/lib/bot/automation/rules-engine'), 'evaluateRules').mockResolvedValue(undefined as never);
  vi.spyOn(await import('@/lib/bot/automation/sequence-service'), 'triggerSequences').mockResolvedValue(undefined as never);
  vi.spyOn(await import('@/lib/bot/flows/shared/notifications'), 'createNotification').mockResolvedValue(undefined as never);
  vi.spyOn(await import('@/lib/bot/flows/shared/notify-owner'), 'notifyOwnerNewBooking').mockResolvedValue(undefined as never);
  vi.spyOn(await import('@/lib/bot/flows/shared/post-completion'), 'handlePostCompletion').mockResolvedValue(undefined as never);
  const { savedPaymentAdapter } = await import('@/lib/payments/saved-payment-adapter');
  vi.spyOn(savedPaymentAdapter, 'getSavedMethods').mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('before-booking intake: linking the answers to the booking', () => {
  it('links a submitted intake of this service and form to the new booking', async () => {
    const create = await createStep();
    await create.prompt(ctxFor({ _intake_id: 'in-1', _intake_key: 'svc-cut:f1', _intake_done_key: 'svc-cut:f1' }));
    expect(intake.link).toHaveBeenCalledTimes(1);
    expect(intake.link).toHaveBeenCalledWith(expect.anything(), 'biz-963', 'in-1', 'bk-new', 'svc-cut');
  });

  it.each([
    ['not submitted in this session', { _intake_id: 'in-1', _intake_key: 'svc-cut:f1' }],
    ['submitted for another service or form', { _intake_id: 'in-1', _intake_key: 'svc-cut:f2', _intake_done_key: 'svc-cut:f1' }],
    ['answered for service A, then service B booked', { _intake_id: 'in-1', _intake_key: 'svc-other:f1', _intake_done_key: 'svc-other:f1' }],
    ['no intake at all', {}],
  ])('does not link: %s', async (_n, data) => {
    const create = await createStep();
    await create.prompt(ctxFor(data));
    expect(intake.link).not.toHaveBeenCalled();
  });
});

describe('after-booking intake: the bot reply', () => {
  it('puts the intake message before the next-steps menu and protects the link from translation', async () => {
    const url = 'https://www.waaiio.com/intake/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd';
    const finalize = vi.fn(async () => true);
    intake.deliver.mockResolvedValue({ status: 'prepared', text: `📋 Healing Labs needs a few answers: ${url}`, url, finalize });
    const create = await createStep();
    const messages = await create.prompt(ctxFor());
    expect(intake.deliver).toHaveBeenCalledWith(expect.anything(), 'bk-new', { prepareOnly: true });
    const last = messages[messages.length - 1] as PromptText & { _localization?: { protectedValues?: string[] } };
    expect(last.type).toBe('text');
    // The next-steps menu stays last (bot completion rule); the intake sits just above it.
    const blocks = last.text.split('\n\n');
    expect(blocks[blocks.length - 1]).toContain('Type *menu*');
    expect(blocks[blocks.length - 2]).toContain(url);
    expect(last._localization?.protectedValues).toEqual(expect.arrayContaining([url, 'Healing Labs']));
    // Saved only after delivery: the executor runs _afterSend once the reply reaches WhatsApp.
    expect((last as { _afterSend?: unknown })._afterSend).toBe(finalize);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('adds nothing when no intake was prepared', async () => {
    const create = await createStep();
    const messages = await create.prompt(ctxFor());
    const last = messages[messages.length - 1] as PromptText & { _localization?: unknown };
    expect(last.text).not.toContain('/intake/');
    expect(last._localization).toBeUndefined();
  });
});

describe('bot reschedule', () => {
  it('moves the pending after-booking link to the new start, and opens no new intake', async () => {
    const create = await createStep();
    await create.prompt(ctxFor({ _reschedule_booking_id: 'bk-old' }));
    expect(intake.sync).toHaveBeenCalledWith(expect.anything(), 'biz-963', 'bk-old');
    expect(intake.deliver).not.toHaveBeenCalled();
    expect(intake.link).not.toHaveBeenCalled();
  });
});
