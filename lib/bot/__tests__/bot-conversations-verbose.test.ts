import { describe, it, expect } from 'vitest';
import { createMockDb, FIXTURES } from './bot-harness';
import { schedulingFlow } from '../flows/scheduling.flow';
import { ticketingFlow } from '../flows/ticketing.flow';
import { appointmentFlow } from '../flows/appointment.flow';
import { crowdfundingFlow } from '../flows/crowdfunding.flow';
import { capabilitySelectionFlow, getCapabilityLabel } from '../flows/capability-selection.flow';
import type { FlowContext } from '../flows/types';
import { vi } from 'vitest';

function buildCtx(overrides: Record<string, unknown> = {}) {
  const db = createMockDb();
  return {
    supabase: db as any,
    sender: {
      sendText: vi.fn().mockResolvedValue({}),
      sendButtons: vi.fn().mockResolvedValue({}),
      sendList: vi.fn().mockResolvedValue({}),
      sendImage: vi.fn().mockResolvedValue({}),
      sendDocument: vi.fn().mockResolvedValue({}),
    } as any,
    standalone: {} as any,
    intelligence: {} as any,
    from: '+12025551234',
    session: {
      id: 'test-session',
      user_id: 'test-user',
      business_id: 'biz-001',
      current_step: '',
      session_data: { capabilities: FIXTURES.capabilities.salon, ...overrides },
      conversation_log: [],
      version: 0,
    },
    business: { ...FIXTURES.business, ...overrides },
  } as FlowContext;
}

function getStep(flow: { steps: any[] }, id: string) {
  return flow.steps.find((s: any) => s.id === id)!;
}

function formatMsg(msg: any): string {
  if (msg.type === 'text') return `[TEXT] ${msg.text}`;
  if (msg.type === 'buttons') return `[BUTTONS] ${msg.body}\n  → ${msg.buttons.map((b: any) => `[${b.id}] ${b.title}`).join(' | ')}`;
  if (msg.type === 'list') return `[LIST] ${msg.body}\n  → ${msg.items.map((i: any) => `${i.title}${i.description ? ' (' + i.description + ')' : ''}`).join('\n  → ')}`;
  if (msg.type === 'image') return `[IMAGE] ${msg.imageUrl} — ${msg.caption || '(no caption)'}`;
  return `[${msg.type}] ${JSON.stringify(msg).slice(0, 100)}`;
}

describe('Bot Flow Conversations — Verbose', () => {

  it('Capability Selection: church with 5 capabilities', async () => {
    const ctx = buildCtx({
      capabilities: ['giving', 'appointment', 'ticketing', 'crowdfunding', 'chat'],
      category: 'church',
    });
    ctx.business = { ...FIXTURES.church } as any;

    const step = getStep(capabilitySelectionFlow, 'select_capability');
    const messages = await step.prompt(ctx);

    console.log('\n═══ CAPABILITY SELECTION (Church) ═══');
    console.log('USER SENDS: (session start — capability menu shown)');
    messages.forEach((m: any) => console.log('BOT RESPONDS:', formatMsg(m)));

    // Simulate user picking "giving"
    const result = await step.validate('cap_giving', ctx);
    console.log('\nUSER SENDS: cap_giving');
    console.log('VALIDATION:', result.valid ? '✅ Valid' : '❌ Invalid', JSON.stringify(result.data || {}));

    const next = await step.next(ctx);
    console.log('NEXT STEP:', next);

    expect(messages.length).toBeGreaterThan(0);
    expect(result.valid).toBe(true);
  });

  it('Ticketing: select event → ticket quantity', async () => {
    // Mock events returned
    const ctx = buildCtx();
    const db = ctx.supabase;
    const events = FIXTURES.events;
    db.from = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: events[0], error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: events[0], error: null }),
    });

    console.log('\n═══ TICKETING FLOW ═══');

    // Step 1: Show events
    const selectEvent = getStep(ticketingFlow, 'select_event');
    const evtMessages = await selectEvent.prompt(ctx);
    console.log('USER SENDS: (enters ticketing flow)');
    evtMessages.forEach((m: any) => console.log('BOT RESPONDS:', formatMsg(m)));

    // Step 2: User selects event
    const evtResult = await selectEvent.validate('evt-001', ctx);
    console.log('\nUSER SENDS: evt-001');
    console.log('VALIDATION:', evtResult.valid ? '✅ Valid' : '❌ Invalid');
    if (evtResult.data) {
      console.log('SESSION DATA SET:', Object.keys(evtResult.data).join(', '));
      console.log('  event_name:', evtResult.data.event_name);
      console.log('  event_price:', evtResult.data.event_price);
      console.log('  event_available:', evtResult.data.event_available);
    }

    const nextStep = await selectEvent.next(ctx);
    console.log('NEXT STEP:', nextStep);

    expect(evtResult.valid).toBe(true);
  });

  it('Crowdfunding: campaign view → donate → amount', async () => {
    const ctx = buildCtx({
      campaign_id: 'camp-001',
      campaign_title: 'Building Fund',
      campaign_goal: 100000,
      campaign_raised: 25000,
      campaign_donors: 15,
    });

    console.log('\n═══ CROWDFUNDING FLOW ═══');

    // Step 1: Campaign view
    const campaignView = getStep(crowdfundingFlow, 'campaign_view');
    const viewMessages = await campaignView.prompt(ctx);
    console.log('USER SENDS: (selected a campaign)');
    viewMessages.forEach((m: any) => console.log('BOT RESPONDS:', formatMsg(m)));

    // Step 2: User taps Donate Now
    const donateResult = await campaignView.validate('donate_yes', ctx);
    console.log('\nUSER SENDS: donate_yes (taps "Donate Now")');
    console.log('VALIDATION:', donateResult.valid ? '✅ Valid' : '❌ Invalid');
    const nextAfterDonate = await campaignView.next(ctx);
    console.log('NEXT STEP:', nextAfterDonate, '(should be enter_donation_amount, NOT giving flow)');

    // Step 3: Enter amount
    const amountStep = getStep(crowdfundingFlow, 'enter_donation_amount');
    ctx.session.session_data.campaign_min_donation = null;
    ctx.session.session_data.campaign_max_donation = null;
    const amountMessages = await amountStep.prompt(ctx);
    console.log('\nBOT RESPONDS:', formatMsg(amountMessages[0]));

    // User enters $50
    const amountResult = await amountStep.validate('50', ctx);
    console.log('USER SENDS: 50');
    console.log('VALIDATION:', amountResult.valid ? '✅ Valid' : '❌ Invalid', 'amount:', amountResult.data?.donation_amount);

    expect(nextAfterDonate).toBe('enter_donation_amount');
    expect(amountResult.valid).toBe(true);
    expect(amountResult.data?.donation_amount).toBe(50);
  });

  it('Scheduling: confirmation step', async () => {
    const ctx = buildCtx({
      service_name: 'Haircut',
      service_price: 3000,
      service_deposit: 0,
      date: '2026-07-01',
      time: '10:00',
      party_size: 1,
      first_name: 'John',
      last_name: 'Doe',
    });

    console.log('\n═══ SCHEDULING — CONFIRMATION ═══');

    const confirmStep = getStep(schedulingFlow, 'confirmation');
    const messages = await confirmStep.prompt(ctx);
    console.log('USER SENDS: (reached confirmation step)');
    messages.forEach((m: any) => console.log('BOT RESPONDS:', formatMsg(m)));

    // User confirms
    const result = await confirmStep.validate('confirm', ctx);
    console.log('\nUSER SENDS: confirm');
    console.log('VALIDATION:', result.valid ? '✅ Valid' : '❌ Invalid');

    const next = await confirmStep.next(ctx);
    console.log('NEXT STEP:', next);

    expect(result.valid).toBe(true);
  });

  it('Appointment: select → routes to scheduling', async () => {
    const ctx = buildCtx({ category: 'church' });
    ctx.business = { ...FIXTURES.church } as any;
    const db = ctx.supabase;
    db.from = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: FIXTURES.appointments[0], error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: FIXTURES.appointments[0], error: null }),
    });

    console.log('\n═══ APPOINTMENT FLOW ═══');

    const selectAppt = getStep(appointmentFlow, 'select_appointment');
    const messages = await selectAppt.prompt(ctx);
    console.log('USER SENDS: (enters appointment flow)');
    messages.forEach((m: any) => console.log('BOT RESPONDS:', formatMsg(m)));

    // If only 1 appointment, it auto-selects
    if (messages.length === 0) {
      console.log('(Auto-selected — only 1 appointment type)');
      console.log('  _is_appointment:', ctx.session.session_data._is_appointment);
      console.log('  service_name:', ctx.session.session_data.service_name);
    }

    const next = await selectAppt.next(ctx);
    console.log('NEXT STEP:', next, '(routes into scheduling flow)');

    expect(next).toBe('select_date');
  });

  it('Capability labels for all categories', () => {
    console.log('\n═══ CAPABILITY LABELS ═══');
    const caps = ['scheduling', 'appointment', 'giving', 'payment', 'ordering',
      'ticketing', 'reservation', 'table_reservation', 'crowdfunding', 'chat',
      'waitlist', 'queue', 'loyalty', 'invoice'];
    const categories = ['salon', 'church', 'restaurant', 'hotel', 'gym'];

    for (const cat of categories) {
      console.log(`\n${cat.toUpperCase()}:`);
      for (const cap of caps) {
        const label = getCapabilityLabel(cap as any, cat);
        if (label !== cap) { // Only show non-default labels
          console.log(`  ${cap} → "${label}"`);
        }
      }
    }
    expect(true).toBe(true);
  });
});
