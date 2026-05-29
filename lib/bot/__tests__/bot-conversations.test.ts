import { describe, it, expect } from 'vitest';
import { createCaptureSender, createMockDb, FIXTURES } from './bot-harness';
import { schedulingFlow } from '../flows/scheduling.flow';
import { ticketingFlow } from '../flows/ticketing.flow';
import { appointmentFlow } from '../flows/appointment.flow';
import { crowdfundingFlow } from '../flows/crowdfunding.flow';
import { capabilitySelectionFlow, getCapabilityLabel } from '../flows/capability-selection.flow';
import { orderingFlow } from '../flows/ordering.flow';
import type { FlowContext } from '../flows/types';

// Helper: build a FlowContext for a given flow step
function buildCtx(
  overrides: Partial<FlowContext> & {
    sessionData?: Record<string, unknown>;
    businessOverrides?: Record<string, unknown>;
  } = {},
) {
  const sender = createCaptureSender();
  const db = createMockDb();
  const business = { ...FIXTURES.business, ...overrides.businessOverrides } as FlowContext['business'];

  return {
    ctx: {
      supabase: db as any,
      sender: sender as any,
      standalone: {} as any,
      intelligence: {} as any,
      from: '+12025551234',
      session: {
        id: 'test-session',
        user_id: 'test-user',
        business_id: business!.id,
        current_step: '',
        session_data: {
          business_id: business!.id,
          business_name: business!.name,
          business_category: business!.category,
          capabilities: FIXTURES.capabilities.salon,
          ...overrides.sessionData,
        },
        conversation_log: [],
      },
      business,
      ...overrides,
    } as FlowContext,
    sender,
    db,
  };
}

function getStep(flow: { steps: Array<{ id: string }> }, id: string) {
  const step = flow.steps.find(s => s.id === id);
  if (!step) throw new Error(`Step "${id}" not found`);
  return step as FlowContext extends never ? never : any;
}

// ═══════════════════════════════════════════════════════════
// CAPABILITY SELECTION
// ═══════════════════════════════════════════════════════════

describe('Capability Selection Flow', () => {
  const step = getStep(capabilitySelectionFlow, 'select_capability');

  it('shows capability menu when multiple user-facing capabilities', async () => {
    const { ctx } = buildCtx({
      sessionData: {
        capabilities: ['scheduling', 'ordering', 'ticketing', 'chat'],
      },
      businessOverrides: { category: 'other' },
    });

    const messages = await step.prompt(ctx);
    expect(messages).toHaveLength(1);
    // Could be list (4+) or buttons (<=3) depending on how many pass the non-UF filter
    expect(['list', 'buttons']).toContain(messages[0].type);
  });

  it('validates cap_ prefix input', async () => {
    const { ctx } = buildCtx({
      sessionData: {
        capabilities: ['scheduling', 'ordering', 'ticketing', 'chat'],
      },
    });

    const result = await step.validate('cap_scheduling', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.active_capability).toBe('scheduling');
  });

  it('rejects unknown capability', async () => {
    const { ctx } = buildCtx({
      sessionData: {
        capabilities: ['scheduling'],
      },
    });

    const result = await step.validate('cap_nonexistent', ctx);
    expect(result.valid).toBe(false);
  });

  it('getCapabilityLabel returns Give for giving capability', () => {
    const label = getCapabilityLabel('giving' as any, 'church');
    expect(label.toLowerCase()).toContain('give');
  });
});

// ═══════════════════════════════════════════════════════════
// SCHEDULING FLOW
// ═══════════════════════════════════════════════════════════

describe('Scheduling Flow — Step Chain', () => {
  it('select_service shows empty message when no services', async () => {
    const { ctx } = buildCtx();

    const step = getStep(schedulingFlow, 'select_service');
    const messages = await step.prompt(ctx);

    // With mock DB returning null, should show "no services" message
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].type).toBe('text');
  });

  it('confirmation step returns confirm/cancel buttons', async () => {
    const { ctx } = buildCtx({
      sessionData: {
        service_name: 'Haircut',
        service_price: 3000,
        date: '2026-07-01',
        time: '10:00',
        party_size: 1,
        first_name: 'John',
      },
    });

    const step = getStep(schedulingFlow, 'confirmation');
    const messages = await step.prompt(ctx);

    expect(messages.length).toBeGreaterThan(0);
    const btnMsg = messages.find((m: any) => m.type === 'buttons');
    expect(btnMsg).toBeDefined();
    expect(btnMsg.buttons.some((b: any) => b.title.includes('Confirm'))).toBe(true);
  });

  it('confirmation validate("confirm") returns valid', async () => {
    const { ctx } = buildCtx({ sessionData: { service_price: 0 } });

    const step = getStep(schedulingFlow, 'confirmation');
    const result = await step.validate('confirm', ctx);

    expect(result.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// TICKETING FLOW
// ═══════════════════════════════════════════════════════════

describe('Ticketing Flow', () => {
  it('select_event shows available events', async () => {
    const { ctx, db } = buildCtx();

    db.from.mockImplementation((table: string) => {
      if (table === 'events') {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                gte: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: FIXTURES.events, error: null }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return createMockDb().from(table);
    });

    const step = getStep(ticketingFlow, 'select_event');
    const messages = await step.prompt(ctx);

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('list');
    expect(messages[0].items[0].title).toBe('Summer Concert');
  });

  it('select_event rejects sold-out events', async () => {
    const soldOut = { ...FIXTURES.events[0], tickets_sold: 100 };
    const { ctx, db } = buildCtx();

    db.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: soldOut, error: null }),
          }),
        }),
      }),
    }));

    const step = getStep(ticketingFlow, 'select_event');
    const result = await step.validate('evt-001', ctx);

    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('sold out');
  });

  it('select_event filters out sold-out from list', async () => {
    const soldOut = { ...FIXTURES.events[0], tickets_sold: 100, total_tickets: 100 };
    const { ctx, db } = buildCtx();

    db.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            gte: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [soldOut], error: null }),
              }),
            }),
          }),
        }),
      }),
    }));

    const step = getStep(ticketingFlow, 'select_event');
    const messages = await step.prompt(ctx);

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('text');
    expect((messages[0] as any).text).toContain('No upcoming events');
  });
});

// ═══════════════════════════════════════════════════════════
// APPOINTMENT FLOW
// ═══════════════════════════════════════════════════════════

describe('Appointment Flow', () => {
  it('sets _is_appointment flag on validation', async () => {
    const { ctx, db } = buildCtx({
      businessOverrides: { category: 'church' },
    });

    db.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: FIXTURES.appointments[0], error: null }),
            }),
          }),
        }),
      }),
    }));

    const step = getStep(appointmentFlow, 'select_appointment');
    const result = await step.validate('apt-001', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._is_appointment).toBe(true);
    expect(result.data?.service_id).toBe('apt-001');
  });

  it('routes to select_date after appointment selection', async () => {
    const step = getStep(appointmentFlow, 'select_appointment');
    const { ctx } = buildCtx();
    const next = await step.next(ctx);
    expect(next).toBe('select_date');
  });
});

// ═══════════════════════════════════════════════════════════
// CROWDFUNDING FLOW
// ═══════════════════════════════════════════════════════════

describe('Crowdfunding Flow', () => {
  it('campaign_view shows progress bar and donate button', async () => {
    const { ctx } = buildCtx({
      sessionData: {
        campaign_id: 'camp-001',
        campaign_title: 'Building Fund',
        campaign_goal: 100000,
        campaign_raised: 25000,
        campaign_donors: 15,
      },
    });

    const step = getStep(crowdfundingFlow, 'campaign_view');
    const messages = await step.prompt(ctx);

    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('text');
    expect((messages[0] as any).text).toContain('Building Fund');
    expect(messages[1].type).toBe('buttons');
    expect(messages[1].buttons.some((b: any) => b.id === 'donate_yes')).toBe(true);
  });

  it('donate_yes routes to enter_donation_amount (not giving flow)', async () => {
    const { ctx } = buildCtx();

    const step = getStep(crowdfundingFlow, 'campaign_view');
    const result = await step.validate('donate_yes', ctx);
    expect(result.valid).toBe(true);

    const next = await step.next(ctx);
    expect(next).toBe('enter_donation_amount');
  });

  it('donate_back routes back to select_campaign', async () => {
    const { ctx } = buildCtx();

    const step = getStep(crowdfundingFlow, 'campaign_view');
    const result = await step.validate('donate_back', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.go_back).toBe(true);

    Object.assign(ctx.session.session_data, result.data);
    const next = await step.next(ctx);
    expect(next).toBe('select_campaign');
  });

  it('validates donation amount with min/max', async () => {
    const { ctx } = buildCtx({
      sessionData: {
        campaign_min_donation: 100,
        campaign_max_donation: 50000,
      },
      businessOverrides: { country_code: 'US' },
    });

    const step = getStep(crowdfundingFlow, 'enter_donation_amount');

    // Too low
    const low = await step.validate('50', ctx);
    expect(low.valid).toBe(false);

    // Valid
    const ok = await step.validate('500', ctx);
    expect(ok.valid).toBe(true);
    expect(ok.data?.donation_amount).toBe(500);

    // Too high
    const high = await step.validate('60000', ctx);
    expect(high.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// ORDERING FLOW
// ═══════════════════════════════════════════════════════════

describe('Ordering Flow', () => {
  it('browse_catalog shows empty message when no products', async () => {
    const { ctx } = buildCtx({
      businessOverrides: { flow_type: 'ordering' },
    });

    const step = getStep(orderingFlow, 'browse_catalog');
    const messages = await step.prompt(ctx);

    // With mock DB returning null, should show "no products" message
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].type).toBe('text');
  });
});

// ═══════════════════════════════════════════════════════════
// CROSS-FLOW: Step chain integrity
// ═══════════════════════════════════════════════════════════

describe('Step Chain Integrity', () => {
  const allFlows = [
    { name: 'scheduling', flow: schedulingFlow },
    { name: 'ticketing', flow: ticketingFlow },
    { name: 'ordering', flow: orderingFlow },
    { name: 'crowdfunding', flow: crowdfundingFlow },
    { name: 'appointment', flow: appointmentFlow },
    { name: 'capability-selection', flow: capabilitySelectionFlow },
  ];

  for (const { name, flow } of allFlows) {
    it(`${name} flow has no duplicate step IDs`, () => {
      const ids = flow.steps.map(s => s.id);
      const unique = new Set(ids);
      expect(ids.length).toBe(unique.size);
    });

    it(`${name} flow steps all have prompt, validate, next`, () => {
      for (const step of flow.steps) {
        expect(typeof step.prompt).toBe('function');
        expect(typeof step.validate).toBe('function');
        expect(typeof step.next).toBe('function');
      }
    });
  }
});
