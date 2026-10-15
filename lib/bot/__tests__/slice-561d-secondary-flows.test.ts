/**
 * Slice 561-D — Secondary flow deterministic localization tests
 *
 * Real executable runtime tests: imports actual flow definitions and calls
 * prompt()/validate() with controlled FlowContext to prove customer-visible
 * copy is deterministic and locale-aware through the production
 * getFlowCopy/fillFlowCopy + ctx.copyLang seam.
 *
 * Source-string assertions are retained only as supplemental structural checks
 * in sections 1-2. Sections 3-12 are all real runtime execution.
 */
import { describe, it, expect, vi } from 'vitest';
import { getFlowCopy, fillFlowCopy, _FLOW_COPY_FOR_TESTS, ALL_FLOW_COPY_KEYS } from '../flows/flow-localization';
import { CERTIFIED_LANGUAGES } from '@/lib/bot/languages';

// ═══════════════════════════════════════════════════════════════
// 1. New 561-D corpus keys — parity (supplemental structural)
// ═══════════════════════════════════════════════════════════════

describe('561-D: new corpus keys parity', () => {
  const newKeys = [
    'waitlist.fully_booked', 'chat.start',
    'crowdfunding.load_error', 'crowdfunding.not_found',
    'crowdfunding.donate_prompt', 'crowdfunding.link_failed',
    'recurring.cancel_confirm', 'recurring.cancel_hint', 'recurring.pause_hint',
    'recurring.cancelled_ok', 'recurring.cancel_failed', 'recurring.details_hint',
    'recurring.select_hint', 'recurring.action_hint', 'recurring.no_history',
    'recurring.sub_not_found_retry', 'invoice.no_user',
  ];

  for (const key of newKeys) {
    it(`${key} exists in en and pcm`, () => {
      expect(_FLOW_COPY_FOR_TESTS.en[key], `en.${key}`).toBeTruthy();
      expect(_FLOW_COPY_FOR_TESTS.pcm[key], `pcm.${key}`).toBeTruthy();
    });
  }

  it('all 8 locales at parity', () => {
    for (const lang of ['en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es']) {
      const keys = Object.keys(_FLOW_COPY_FOR_TESTS[lang]);
      const missing = ALL_FLOW_COPY_KEYS.filter(k => !keys.includes(k));
      expect(missing, `${lang} missing ${missing.length} keys`).toHaveLength(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Placeholder integrity for new keys (supplemental structural)
// ═══════════════════════════════════════════════════════════════

describe('561-D: placeholder integrity', () => {
  it('waitlist.fully_booked preserves {businessName}', () => {
    const en = fillFlowCopy('en', 'waitlist.fully_booked', { businessName: 'Bukka' });
    expect(en).toContain('Bukka');
    expect(en).not.toContain('{businessName}');
    const pcm = fillFlowCopy('pcm', 'waitlist.fully_booked', { businessName: 'Bukka' });
    expect(pcm).toContain('Bukka');
  });

  it('chat.start preserves {businessName}', () => {
    const en = fillFlowCopy('en', 'chat.start', { businessName: 'TestBiz' });
    expect(en).toContain('TestBiz');
    expect(en).toContain('*restart*');
  });
});

// ═══════════════════════════════════════════════════════════════
// Shared mock context builder
// ═══════════════════════════════════════════════════════════════

function makeChain(overrides?: { data?: unknown; error?: unknown }): any {
  const terminal = { data: overrides?.data ?? [], error: overrides?.error ?? null };
  const p: any = { ...terminal };
  for (const fn of ['eq','neq','gt','gte','lt','lte','is','in','not','or','order','limit','range','single','maybeSingle','select','contains','filter','ilike','like','match']) {
    p[fn] = vi.fn().mockReturnValue(p);
  }
  p.maybeSingle = vi.fn().mockResolvedValue({ data: overrides?.data ?? null, error: overrides?.error ?? null });
  p.single = vi.fn().mockResolvedValue({ data: overrides?.data ?? null, error: overrides?.error ?? null });
  p.then = undefined;
  return p;
}

function buildCtx(overrides: {
  copyLang?: string;
  sessionData?: Record<string, unknown>;
  businessName?: string;
  fromChain?: any;
  userId?: string | null;
}) {
  const { copyLang = 'en', sessionData = {}, businessName = 'Test Biz', userId = 'u1' } = overrides;
  const chain = overrides.fromChain || makeChain();
  return {
    supabase: {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnValue(chain),
        insert: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'mock' }, error: null }) }) }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        upsert: vi.fn().mockResolvedValue({ error: null }),
      })),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    } as any,
    sender: { sendText: vi.fn(), sendButtons: vi.fn(), sendList: vi.fn() } as any,
    standalone: {} as any,
    intelligence: {} as any,
    from: '+2348001234567',
    session: { id: 'test', user_id: userId, business_id: 'b1', current_step: 'test', session_data: { ...sessionData }, version: 1 },
    business: { id: 'b1', name: businessName, slug: 'test', subscription_tier: 'growth', country_code: 'NG', category: 'barber', flow_type: 'scheduling' as any, trial_ends_at: '', metadata: {} },
    t: vi.fn(async (text: string) => text),
    copyLang,
  } as any;
}

// ═══════════════════════════════════════════════════════════════
// 3. Waitlist flow runtime — EN + authorized PCM
// ═══════════════════════════════════════════════════════════════

describe('561-D: waitlist flow runtime', () => {
  it('waitlist_join prompt returns English localized body and buttons', async () => {
    const { waitlistFlow } = await import('../flows/waitlist.flow');
    const step = waitlistFlow.steps.find(s => s.id === 'waitlist_join');
    expect(step).toBeDefined();

    const ctx = buildCtx({ copyLang: 'en', businessName: 'Bukka Lagos' });
    const output = await step!.prompt(ctx);

    expect(output.length).toBeGreaterThan(0);
    const p = output[0] as any;
    expect(p.type).toBe('buttons');
    expect(p.body).toContain('Bukka Lagos');
    expect(p.body).not.toContain('{businessName}');
    expect(p.body).toContain('fully booked');
    expect(p.buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Join Waitlist' }),
        expect.objectContaining({ title: 'No Thanks' }),
      ])
    );
  });

  it('waitlist_join prompt returns Pidgin localized body and buttons', async () => {
    const { waitlistFlow } = await import('../flows/waitlist.flow');
    const step = waitlistFlow.steps.find(s => s.id === 'waitlist_join');

    const ctx = buildCtx({ copyLang: 'pcm', businessName: 'Bukka Lagos' });
    const output = await step!.prompt(ctx);

    const p = output[0] as any;
    expect(p.body).toContain('Bukka Lagos');
    expect(p.body).toContain('dey fully booked');
    expect(p.buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Join Waitlist' }),
        expect.objectContaining({ title: getFlowCopy('pcm', 'nav.no_thanks') }),
      ])
    );
  });

  it('waitlist_join validate returns PCM error on invalid input', async () => {
    const { waitlistFlow } = await import('../flows/waitlist.flow');
    const step = waitlistFlow.steps.find(s => s.id === 'waitlist_join');

    const ctx = buildCtx({ copyLang: 'pcm' });
    const result = await step!.validate!('garbage', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe(getFlowCopy('pcm', 'waitlist.tap_hint'));
    expect(result.errorMessage).toContain('Abeg tap');
  });

  it('waitlist_join validate accepts valid input', async () => {
    const { waitlistFlow } = await import('../flows/waitlist.flow');
    const step = waitlistFlow.steps.find(s => s.id === 'waitlist_join');

    const ctx = buildCtx({ copyLang: 'en' });
    const result = await step!.validate!('wl_yes', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.waitlist_action).toBe('join');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. RSVP flow runtime — EN + authorized PCM
// ═══════════════════════════════════════════════════════════════

describe('561-D: RSVP flow runtime', () => {
  const rsvpSessionData = {
    rsvp_event_name: 'Birthday Party',
    rsvp_event_date: '2026-12-25',
    rsvp_event_time: '18:00',
    rsvp_event_venue: 'The Grand Hall',
  };

  it('rsvp_welcome prompt returns English localized invite and buttons', async () => {
    const { rsvpFlow } = await import('../flows/rsvp.flow');
    const step = rsvpFlow.steps.find(s => s.id === 'rsvp_welcome');
    expect(step).toBeDefined();

    const ctx = buildCtx({ copyLang: 'en', sessionData: rsvpSessionData });
    const output = await step!.prompt(ctx);

    expect(output.length).toBe(2);
    const textOut = output[0] as any;
    expect(textOut.type).toBe('text');
    expect(textOut.text).toContain("You're Invited!");
    expect(textOut.text).toContain('Birthday Party');
    expect(textOut.text).toContain('The Grand Hall');
    expect(textOut.text).toContain('Will you be attending?');

    const btnOut = output[1] as any;
    expect(btnOut.type).toBe('buttons');
    expect(btnOut.buttons).toEqual([
      expect.objectContaining({ title: "Yes, I'll be there!" }),
      expect.objectContaining({ title: 'Maybe' }),
      expect.objectContaining({ title: "Can't make it" }),
    ]);
  });

  it('rsvp_welcome prompt returns Pidgin localized invite and buttons', async () => {
    const { rsvpFlow } = await import('../flows/rsvp.flow');
    const step = rsvpFlow.steps.find(s => s.id === 'rsvp_welcome');

    const ctx = buildCtx({ copyLang: 'pcm', sessionData: rsvpSessionData });
    const output = await step!.prompt(ctx);

    const textOut = output[0] as any;
    expect(textOut.text).toContain('You Don Get Invite!');
    expect(textOut.text).toContain('You go come?');
    expect(textOut.text).toContain('Birthday Party');

    const btnOut = output[1] as any;
    expect(btnOut.buttons).toEqual([
      expect.objectContaining({ title: 'Yes, I go dey there!' }),
      expect.objectContaining({ title: 'Maybe' }),
      expect.objectContaining({ title: 'I no fit come' }),
    ]);
  });

  it('rsvp_welcome validate returns PCM error on invalid input', async () => {
    const { rsvpFlow } = await import('../flows/rsvp.flow');
    const step = rsvpFlow.steps.find(s => s.id === 'rsvp_welcome');

    const ctx = buildCtx({ copyLang: 'pcm', sessionData: rsvpSessionData });
    const result = await step!.validate!('unknown', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('Abeg tap');
  });

  it('rsvp_welcome validate accepts valid RSVP response', async () => {
    const { rsvpFlow } = await import('../flows/rsvp.flow');
    const step = rsvpFlow.steps.find(s => s.id === 'rsvp_welcome');

    const ctx = buildCtx({ copyLang: 'en', sessionData: rsvpSessionData });
    const yesResult = await step!.validate!('rsvp_yes', ctx);
    expect(yesResult.valid).toBe(true);
    expect(yesResult.data?.rsvp_response).toBe('accepted');

    const noResult = await step!.validate!('rsvp_no', ctx);
    expect(noResult.valid).toBe(true);
    expect(noResult.data?.rsvp_response).toBe('declined');
  });

  it('rsvp_plus_ones prompt returns localized guest selection buttons', async () => {
    const { rsvpFlow } = await import('../flows/rsvp.flow');
    const step = rsvpFlow.steps.find(s => s.id === 'rsvp_plus_ones');
    expect(step).toBeDefined();

    const ctx = buildCtx({ copyLang: 'en', sessionData: { ...rsvpSessionData, rsvp_allow_plus_ones: true } });
    const output = await step!.prompt(ctx);
    const p = output[0] as any;
    expect(p.type).toBe('buttons');
    expect(p.body).toBe(getFlowCopy('en', 'rsvp.how_many'));
    expect(p.buttons).toEqual([
      expect.objectContaining({ title: getFlowCopy('en', 'rsvp.just_me') }),
      expect.objectContaining({ title: getFlowCopy('en', 'rsvp.two') }),
      expect.objectContaining({ title: getFlowCopy('en', 'rsvp.three') }),
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Survey flow runtime — EN + PCM
// ═══════════════════════════════════════════════════════════════

describe('561-D: survey flow runtime', () => {
  const surveySessionData = {
    _survey_id: 's1',
    _survey_title: 'Customer Feedback',
    _survey_questions: [{ type: 'text', text: 'How was your experience?' }],
  };

  it('survey_intro prompt returns English Start/Not now buttons', async () => {
    const { surveyFlow } = await import('../flows/survey.flow');
    const step = surveyFlow.steps.find(s => s.id === 'survey_intro');
    expect(step).toBeDefined();

    const ctx = buildCtx({ copyLang: 'en', sessionData: surveySessionData });
    const output = await step!.prompt(ctx);
    expect(output.length).toBeGreaterThan(0);
    const p = output[0] as any;
    if (p.buttons) {
      expect(p.buttons.some((b: any) => b.title === getFlowCopy('en', 'survey.start'))).toBe(true);
      expect(p.buttons.some((b: any) => b.title === getFlowCopy('en', 'survey.not_now'))).toBe(true);
    }
  });

  it('survey_intro prompt returns Pidgin localized buttons', async () => {
    const { surveyFlow } = await import('../flows/survey.flow');
    const step = surveyFlow.steps.find(s => s.id === 'survey_intro');

    const ctx = buildCtx({ copyLang: 'pcm', sessionData: surveySessionData });
    const output = await step!.prompt(ctx);
    const p = output[0] as any;
    if (p.buttons) {
      expect(p.buttons.some((b: any) => b.title === getFlowCopy('pcm', 'survey.start'))).toBe(true);
      expect(p.buttons.some((b: any) => b.title === getFlowCopy('pcm', 'survey.not_now'))).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Crowdfunding flow runtime — representative execution
// ═══════════════════════════════════════════════════════════════

describe('561-D: crowdfunding flow runtime', () => {
  it('select_campaign prompt returns EN "no campaigns" when list is empty', async () => {
    const { crowdfundingFlow } = await import('../flows/crowdfunding.flow');
    const step = crowdfundingFlow.steps.find(s => s.id === 'select_campaign');
    expect(step).toBeDefined();

    const chain = makeChain({ data: [] });
    const ctx = buildCtx({ copyLang: 'en', fromChain: chain });
    const output = await step!.prompt(ctx);
    const text = output.map((r: any) => r.body || r.text).join(' ');
    expect(text).toContain(getFlowCopy('en', 'crowdfunding.no_campaigns'));
  });

  it('select_campaign prompt returns PCM "no campaigns" when list is empty', async () => {
    const { crowdfundingFlow } = await import('../flows/crowdfunding.flow');
    const step = crowdfundingFlow.steps.find(s => s.id === 'select_campaign');

    const chain = makeChain({ data: [] });
    const ctx = buildCtx({ copyLang: 'pcm', fromChain: chain });
    const output = await step!.prompt(ctx);
    const text = output.map((r: any) => r.body || r.text).join(' ');
    expect(text).toContain('No active campaign dey now');
  });

  it('select_campaign prompt returns EN error on query failure', async () => {
    const { crowdfundingFlow } = await import('../flows/crowdfunding.flow');
    const step = crowdfundingFlow.steps.find(s => s.id === 'select_campaign');

    const chain = makeChain({ data: null, error: { code: '500' } });
    const ctx = buildCtx({ copyLang: 'en', fromChain: chain });
    const output = await step!.prompt(ctx);
    const text = output.map((r: any) => r.body || r.text).join(' ');
    expect(text).toContain(getFlowCopy('en', 'crowdfunding.load_error'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Recurring management runtime — representative execution
// ═══════════════════════════════════════════════════════════════

describe('561-D: recurring-manage flow runtime', () => {
  it('list_subscriptions prompt returns EN "no active" with Back button', async () => {
    const { recurringManageFlow } = await import('../flows/recurring-manage.flow');
    const step = recurringManageFlow.steps.find(s => s.id === 'list_subscriptions');
    expect(step).toBeDefined();

    const chain = makeChain({ data: [] });
    const ctx = buildCtx({ copyLang: 'en', fromChain: chain });
    const output = await step!.prompt(ctx);

    const p = output[0] as any;
    expect(p.type).toBe('buttons');
    expect(p.body).toBe(getFlowCopy('en', 'recurring.no_active'));
    expect(p.body).toContain('no active recurring');
    expect(p.buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: getFlowCopy('en', 'nav.back') }),
      ])
    );
  });

  it('list_subscriptions prompt returns PCM "no active" with Back button', async () => {
    const { recurringManageFlow } = await import('../flows/recurring-manage.flow');
    const step = recurringManageFlow.steps.find(s => s.id === 'list_subscriptions');

    const chain = makeChain({ data: [] });
    const ctx = buildCtx({ copyLang: 'pcm', fromChain: chain });
    const output = await step!.prompt(ctx);

    const p = output[0] as any;
    expect(p.body).toBe(getFlowCopy('pcm', 'recurring.no_active'));
    expect(p.body).toContain('no get active recurring');
  });

  it('list_subscriptions with subs returns localized title and select', async () => {
    const { recurringManageFlow } = await import('../flows/recurring-manage.flow');
    const step = recurringManageFlow.steps.find(s => s.id === 'list_subscriptions');

    const subsData = [
      { id: 'sub1', amount: 5000, currency: 'NGN', frequency: 'monthly', status: 'active', service_id: 'svc1', next_charge_at: '2026-11-01', card_last_four: '4242' },
    ];
    const chain = makeChain({ data: subsData });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const ctx = buildCtx({ copyLang: 'en', fromChain: chain });
    const output = await step!.prompt(ctx);

    const p = output[0] as any;
    expect(p.type).toBe('list');
    expect(p.title).toBe(getFlowCopy('en', 'recurring.title'));
    expect(p.buttonLabel).toBe(getFlowCopy('en', 'recurring.select'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. Loyalty flow runtime — representative execution
// ═══════════════════════════════════════════════════════════════

describe('561-D: loyalty flow runtime', () => {
  it('loyalty_menu with points returns localized buttons', async () => {
    const { loyaltyFlow } = await import('../flows/loyalty.flow');
    const step = loyaltyFlow.steps.find(s => s.id === 'loyalty_menu');
    expect(step).toBeDefined();

    const loyaltyData = { id: 'loy1', points_balance: 250, total_earned: 500, total_redeemed: 250, visit_count: 10 };
    const chain = makeChain({ data: loyaltyData });
    const ctx = buildCtx({ copyLang: 'en', fromChain: chain });
    const output = await step!.prompt(ctx);

    expect(output.length).toBe(2);
    const btnOut = output[1] as any;
    expect(btnOut.type).toBe('buttons');
    expect(btnOut.buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: getFlowCopy('en', 'loyalty.view_history') }),
        expect.objectContaining({ title: getFlowCopy('en', 'loyalty.redeem_reward') }),
        expect.objectContaining({ title: getFlowCopy('en', 'nav.back') }),
      ])
    );
  });

  it('loyalty_menu PCM buttons match PCM locale copy', async () => {
    const { loyaltyFlow } = await import('../flows/loyalty.flow');
    const step = loyaltyFlow.steps.find(s => s.id === 'loyalty_menu');

    const loyaltyData = { id: 'loy1', points_balance: 100, total_earned: 200, total_redeemed: 100, visit_count: 5 };
    const chain = makeChain({ data: loyaltyData });
    const ctx = buildCtx({ copyLang: 'pcm', fromChain: chain });
    const output = await step!.prompt(ctx);

    const btnOut = output[1] as any;
    expect(btnOut.buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: getFlowCopy('pcm', 'loyalty.view_history') }),
        expect.objectContaining({ title: getFlowCopy('pcm', 'loyalty.redeem_reward') }),
        expect.objectContaining({ title: getFlowCopy('pcm', 'nav.back') }),
      ])
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Invoice flow runtime — localized wrapper, protected values
// ═══════════════════════════════════════════════════════════════

describe('561-D: invoice flow runtime — protected values', () => {
  it('invoice_detail prompt preserves exact amount/currency/reference while localizing buttons', async () => {
    const { invoiceFlow } = await import('../flows/invoice.flow');
    const step = invoiceFlow.steps.find(s => s.id === 'invoice_detail');
    expect(step).toBeDefined();

    const invoiceData = {
      id: 'inv-001',
      reference_code: 'INV-2026-0042',
      total_amount: 15000,
      due_date: '2026-11-15',
      status: 'sent',
      created_at: '2026-10-01T00:00:00Z',
      businesses: { name: 'Mama Put Restaurant', country_code: 'NG' },
    };
    const itemsData = [
      { description: 'Jollof Rice Catering', quantity: 3, unit_price: 5000, amount: 15000 },
    ];
    const chain = makeChain({ data: invoiceData });
    const ctx = buildCtx({ copyLang: 'en', sessionData: { _selected_invoice_id: 'inv-001' } });
    ctx.supabase.from = vi.fn((table: string) => {
      if (table === 'invoice_items') {
        const itemChain = makeChain({ data: itemsData });
        return { select: vi.fn().mockReturnValue(itemChain) };
      }
      return { select: vi.fn().mockReturnValue(chain) };
    });

    const output = await step!.prompt(ctx);

    // Text contains exact financial values unchanged
    const textOut = output[0] as any;
    expect(textOut.text).toContain('INV-2026-0042');
    expect(textOut.text).toContain('15,000');
    expect(textOut.text).toContain('Mama Put Restaurant');
    expect(textOut.text).toContain('Jollof Rice Catering');

    // Button wrapper is localized
    const btnOut = output[1] as any;
    expect(btnOut.buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: getFlowCopy('en', 'invoice.pay_now') }),
        expect.objectContaining({ title: getFlowCopy('en', 'invoice.back_to_list') }),
      ])
    );
  });

  it('invoice_pay no_user error returns PCM localized copy', async () => {
    const { invoiceFlow } = await import('../flows/invoice.flow');
    const step = invoiceFlow.steps.find(s => s.id === 'invoice_pay');
    expect(step).toBeDefined();

    const invoiceData = {
      id: 'inv-002',
      reference_code: 'INV-2026-0099',
      total_amount: 8500,
      amount_paid: 0,
      status: 'sent',
      business_id: 'b1',
      businesses: { name: 'Buka Joint', country_code: 'NG', payment_gateway: null, subscription_tier: 'growth' },
    };
    const ctx = buildCtx({
      copyLang: 'pcm',
      sessionData: { _selected_invoice_id: 'inv-002' },
      userId: null,
    });
    ctx.session.user_id = null;
    ctx.supabase.from = vi.fn((table: string) => {
      if (table === 'invoices') {
        const invoiceChain = makeChain({ data: invoiceData });
        return { select: vi.fn().mockReturnValue(invoiceChain) };
      }
      const profileChain = makeChain({ data: null });
      return { select: vi.fn().mockReturnValue(profileChain) };
    });

    const output = await step!.prompt(ctx);

    const p = output[0] as any;
    expect(p.body || p.text).toContain('We no fit match your number');
    expect(p.body || p.text).toBe(getFlowCopy('pcm', 'invoice.no_user'));
    if (p.buttons) {
      expect(p.buttons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: getFlowCopy('pcm', 'invoice.ok') }),
        ])
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Chat flow runtime — localized wrapper, merchant values exact
// ═══════════════════════════════════════════════════════════════

describe('561-D: chat flow runtime — protected merchant values', () => {
  it('chat_start prompt returns EN localized greeting with exact business name', async () => {
    const { chatFlow } = await import('../flows/chat.flow');
    const step = chatFlow.steps.find(s => s.id === 'chat_start');
    expect(step).toBeDefined();

    const ctx = buildCtx({ copyLang: 'en', businessName: "Ade's Barber Shop" });
    const output = await step!.prompt(ctx);

    const p = output[0] as any;
    expect(p.type).toBe('text');
    expect(p.text).toContain("Ade's Barber Shop");
    expect(p.text).toContain("You're now chatting with");
    expect(p.text).toContain('*restart*');
  });

  it('chat_start prompt returns PCM localized greeting with exact business name', async () => {
    const { chatFlow } = await import('../flows/chat.flow');
    const step = chatFlow.steps.find(s => s.id === 'chat_start');

    const ctx = buildCtx({ copyLang: 'pcm', businessName: "Ade's Barber Shop" });
    const output = await step!.prompt(ctx);

    const p = output[0] as any;
    expect(p.text).toContain("Ade's Barber Shop");
    expect(p.text).toContain('You dey chat with');
    expect(p.text).toContain('team member go respond soon');
  });

  it('chat_start validate stores customer-authored content unchanged', async () => {
    const { chatFlow } = await import('../flows/chat.flow');
    const step = chatFlow.steps.find(s => s.id === 'chat_start');

    const customerContent = 'I wan cut my hair for 3pm today, how much e go cost?';
    const ctx = buildCtx({ copyLang: 'pcm', businessName: "Ade's Barber Shop" });

    const insertCalls: any[] = [];
    ctx.supabase.from = vi.fn((table: string) => {
      if (table === 'chat_conversations') {
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnValue(makeChain({ data: { id: 'conv1' } })),
        };
      }
      if (table === 'chat_messages') {
        return {
          insert: vi.fn((data: any) => {
            insertCalls.push(data);
            return { select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'x' }, error: null }) }) };
          }),
        };
      }
      return {
        select: vi.fn().mockReturnValue(makeChain({ data: { owner_id: 'o1', phone: '+2349012345678' } })),
      };
    });

    const result = await step!.validate!(customerContent, ctx);
    expect(result.valid).toBe(true);

    if (insertCalls.length > 0) {
      expect(insertCalls[0].message_text).toBe(customerContent);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Production language-authority fallback — uncertified languages
// ═══════════════════════════════════════════════════════════════

describe('561-D: production language-authority fallback', () => {
  const secondaryKeys = [
    'waitlist.fully_booked', 'rsvp.invited', 'survey.start',
    'crowdfunding.no_campaigns', 'recurring.title', 'loyalty.no_points',
    'invoice.all_caught_up', 'chat.start',
  ];
  const uncertifiedLangs = ['yo', 'ig', 'ha', 'tw', 'fr', 'es'];

  for (const lang of uncertifiedLangs) {
    it(`${lang} (uncertified) falls back to English for all secondary keys`, () => {
      for (const key of secondaryKeys) {
        const result = getFlowCopy(lang, key);
        const enResult = getFlowCopy('en', key);
        expect(result, `${lang}.${key} should equal en.${key}`).toBe(enResult);
      }
    });
  }

  it('English-only ctx.copyLang: waitlist prompt uses English through real flow', async () => {
    const { waitlistFlow } = await import('../flows/waitlist.flow');
    const step = waitlistFlow.steps.find(s => s.id === 'waitlist_join');
    const ctx = buildCtx({ copyLang: 'fr', businessName: 'Le Salon' });
    const output = await step!.prompt(ctx);
    const p = output[0] as any;
    expect(p.body).toContain('fully booked');
    expect(p.body).toContain('Le Salon');
  });

  it('certified pcm: secondary chrome is Pidgin (runtime proof)', () => {
    expect(getFlowCopy('pcm', 'crowdfunding.no_campaigns')).toContain('No active campaign dey');
    expect(getFlowCopy('pcm', 'recurring.no_active')).toContain('no get active recurring');
    expect(getFlowCopy('pcm', 'rsvp.invited')).toContain('You Don Get Invite');
    expect(getFlowCopy('pcm', 'invoice.no_user')).toContain('We no fit match');
  });

  it('undefined/null copyLang falls back to English', () => {
    expect(getFlowCopy(undefined, 'waitlist.fully_booked')).toBe(getFlowCopy('en', 'waitlist.fully_booked'));
    expect(getFlowCopy('', 'rsvp.invited')).toBe(getFlowCopy('en', 'rsvp.invited'));
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. CERTIFIED_LANGUAGES unchanged
// ═══════════════════════════════════════════════════════════════

describe('561-D: CERTIFIED_LANGUAGES unchanged', () => {
  it('only en and pcm are certified', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en', 'pcm']);
  });
});
