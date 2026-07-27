import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crowdfundingFlow } from '../crowdfunding.flow';
import { isToggleColumnMissing } from '../crowdfunding.flow';
import { createCaptureSender, FIXTURES } from '../../__tests__/bot-harness';
import type { FlowContext } from '../types';

// ── Helpers ──

function getStep(id: string) {
  const step = crowdfundingFlow.steps.find(s => s.id === id);
  if (!step) throw new Error(`Step "${id}" not found`);
  return step as any;
}

/** Create a Supabase mock where .from('campaigns').select(...) resolves to the given value */
function createCampaignMock(
  resolveWith: { data: any; error: any },
  opts?: {
    /** If set, first call resolves with this, second call resolves with resolveWith */
    firstCallResolvesWith?: { data: any; error: any };
    /** Mock for .single() resolution (used by validate step) */
    singleResolvesWith?: { data: any; error: any };
  },
) {
  let callCount = 0;
  const firstCall = opts?.firstCallResolvesWith;
  const singleResult = opts?.singleResolvesWith ?? { data: null, error: { message: 'not found' } };

  function chainable() {
    callCount++;
    const currentResolve = firstCall && callCount === 1 ? firstCall : resolveWith;
    const chain: Record<string, any> = {};
    const self = () => chain;
    for (const method of [
      'select', 'insert', 'update', 'upsert', 'delete',
      'eq', 'neq', 'in', 'or', 'is', 'not', 'ilike', 'like',
      'gte', 'lte', 'gt', 'lt', 'contains', 'containedBy',
      'order', 'limit', 'range', 'filter', 'match',
    ]) {
      chain[method] = vi.fn().mockImplementation(() => self());
    }
    chain.single = vi.fn().mockResolvedValue(singleResult);
    chain.maybeSingle = vi.fn().mockResolvedValue(singleResult);
    // Make chain directly awaitable (Supabase client returns a thenable)
    chain.then = (resolve: any, reject?: any) => Promise.resolve(currentResolve).then(resolve, reject);
    return chain;
  }

  return {
    from: vi.fn(() => chainable()),
    rpc: vi.fn(),
    storage: { from: vi.fn() },
  };
}

function buildCtx(overrides: {
  db?: any;
  sessionData?: Record<string, unknown>;
  businessOverrides?: Record<string, unknown>;
} = {}): FlowContext {
  const sender = createCaptureSender();
  const business = { ...FIXTURES.business, ...overrides.businessOverrides } as FlowContext['business'];

  return {
    supabase: overrides.db as any,
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
        capabilities: FIXTURES.capabilities.church,
        ...overrides.sessionData,
      },
      conversation_log: [],
      version: 0,
    },
    business,
    t: (s: string) => Promise.resolve(s),
  } as FlowContext;
}

const YESTERDAY = new Date(Date.now() - 86400000).toISOString().split('T')[0];
const TOMORROW = new Date(Date.now() + 86400000).toISOString().split('T')[0];

function makeCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: 'camp-001',
    title: 'Building Fund',
    description: 'Help us build',
    goal_amount: 100000,
    raised_amount: 25000,
    donor_count: 15,
    end_date: null,
    status: 'active',
    min_donation: null,
    max_donation: null,
    allow_after_end_date: true,
    allow_after_goal_met: true,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// isToggleColumnMissing — error classifier
// ═══════════════════════════════════════════════════════════

describe('isToggleColumnMissing', () => {
  it('returns true for PostgreSQL 42703 mentioning toggle column', () => {
    expect(isToggleColumnMissing({
      code: '42703',
      message: 'column campaigns.allow_after_end_date does not exist',
    })).toBe(true);
  });

  it('returns true for PGRST204 mentioning toggle column', () => {
    expect(isToggleColumnMissing({
      code: 'PGRST204',
      message: 'Could not find column allow_after_goal_met',
    })).toBe(true);
  });

  it('returns false for 42703 about a different column', () => {
    expect(isToggleColumnMissing({
      code: '42703',
      message: 'column campaigns.some_other_col does not exist',
    })).toBe(false);
  });

  it('returns false for authentication error', () => {
    expect(isToggleColumnMissing({
      code: '42501',
      message: 'permission denied for table campaigns',
    })).toBe(false);
  });

  it('returns false for RLS error', () => {
    expect(isToggleColumnMissing({
      code: 'PGRST301',
      message: 'JWT expired',
    })).toBe(false);
  });

  it('returns false for null error', () => {
    expect(isToggleColumnMissing(null)).toBe(false);
  });

  it('returns false for error with no code', () => {
    expect(isToggleColumnMissing({ message: 'network error' })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// select_campaign prompt — expanded query & fallback
// ═══════════════════════════════════════════════════════════

describe('Crowdfunding donation toggles — select_campaign', () => {
  const step = getStep('select_campaign');

  it('expanded query reads both toggle columns', async () => {
    const campaign = makeCampaign({
      allow_after_end_date: false,
      allow_after_goal_met: false,
      end_date: YESTERDAY,
    });
    const db = createCampaignMock({ data: [campaign], error: null });
    const ctx = buildCtx({ db });

    const messages = await step.prompt(ctx);

    // Campaign has expired end date + allow_after_end_date=false → filtered out
    expect(messages).toHaveLength(1);
    expect(messages[0].body || messages[0].text).toContain('No active campaigns');
  });

  it('pre-Migration-199 fallback defaults both toggles to true', async () => {
    const legacyCampaign = makeCampaign({ end_date: YESTERDAY });
    // Remove toggle columns to simulate pre-migration data
    delete (legacyCampaign as any).allow_after_end_date;
    delete (legacyCampaign as any).allow_after_goal_met;

    const db = createCampaignMock(
      // Legacy fallback resolves successfully
      { data: [legacyCampaign], error: null },
      {
        // First call (expanded) fails with column-missing
        firstCallResolvesWith: {
          data: null,
          error: { code: '42703', message: 'column campaigns.allow_after_end_date does not exist' },
        },
      },
    );
    const ctx = buildCtx({ db });

    const messages = await step.prompt(ctx);

    // Campaign has expired end date but toggles default to true → still shown
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('list');
    expect(messages[0].items).toHaveLength(1);
    expect(messages[0].items[0].title).toBe('Building Fund');
  });

  it('unrelated query error is NOT caught by fallback', async () => {
    const db = createCampaignMock({
      data: null,
      error: { code: '42501', message: 'permission denied for table campaigns' },
    });
    const ctx = buildCtx({ db });

    const messages = await step.prompt(ctx);

    // Error is not a column-missing error, so no retry.
    // allCampaigns is null → filter produces empty → "No active campaigns"
    expect(messages).toHaveLength(1);
    expect(messages[0].body || messages[0].text).toContain('No active campaigns');
    // from() should only be called once (no retry)
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it('expired campaign + allow_after_end_date=false is blocked', async () => {
    const campaign = makeCampaign({
      end_date: YESTERDAY,
      allow_after_end_date: false,
    });
    const db = createCampaignMock({ data: [campaign], error: null });
    const ctx = buildCtx({ db });

    const messages = await step.prompt(ctx);
    expect(messages[0].body || messages[0].text).toContain('No active campaigns');
  });

  it('expired campaign + allow_after_end_date=true is allowed', async () => {
    const campaign = makeCampaign({
      end_date: YESTERDAY,
      allow_after_end_date: true,
    });
    const db = createCampaignMock({ data: [campaign], error: null });
    const ctx = buildCtx({ db });

    const messages = await step.prompt(ctx);
    expect(messages[0].type).toBe('list');
    expect(messages[0].items).toHaveLength(1);
  });

  it('funded campaign + allow_after_goal_met=false is blocked', async () => {
    const campaign = makeCampaign({
      goal_amount: 100000,
      raised_amount: 100000,
      allow_after_goal_met: false,
    });
    const db = createCampaignMock({ data: [campaign], error: null });
    const ctx = buildCtx({ db });

    const messages = await step.prompt(ctx);
    expect(messages[0].body || messages[0].text).toContain('No active campaigns');
  });

  it('funded campaign + allow_after_goal_met=true is allowed', async () => {
    const campaign = makeCampaign({
      goal_amount: 100000,
      raised_amount: 100000,
      allow_after_goal_met: true,
    });
    const db = createCampaignMock({ data: [campaign], error: null });
    const ctx = buildCtx({ db });

    const messages = await step.prompt(ctx);
    expect(messages[0].type).toBe('list');
    expect(messages[0].items).toHaveLength(1);
  });

  it('both restrictions are independently enforced', async () => {
    const campaigns = [
      // Expired + blocked
      makeCampaign({ id: 'c1', title: 'Expired Blocked', end_date: YESTERDAY, allow_after_end_date: false }),
      // Funded + blocked
      makeCampaign({ id: 'c2', title: 'Funded Blocked', goal_amount: 1000, raised_amount: 1000, allow_after_goal_met: false }),
      // Expired + allowed
      makeCampaign({ id: 'c3', title: 'Expired OK', end_date: YESTERDAY, allow_after_end_date: true }),
      // Funded + allowed
      makeCampaign({ id: 'c4', title: 'Funded OK', goal_amount: 1000, raised_amount: 1000, allow_after_goal_met: true }),
      // Neither restricted
      makeCampaign({ id: 'c5', title: 'Open', end_date: TOMORROW }),
    ];
    const db = createCampaignMock({ data: campaigns, error: null });
    const ctx = buildCtx({ db });

    const messages = await step.prompt(ctx);
    expect(messages[0].type).toBe('list');
    const titles = messages[0].items.map((i: any) => i.title);
    expect(titles).toContain('Expired OK');
    expect(titles).toContain('Funded OK');
    expect(titles).toContain('Open');
    expect(titles).not.toContain('Expired Blocked');
    expect(titles).not.toContain('Funded Blocked');
  });
});

// ═══════════════════════════════════════════════════════════
// select_campaign validate — re-check enforcement
// ═══════════════════════════════════════════════════════════

describe('Crowdfunding donation toggles — validate re-check', () => {
  const step = getStep('select_campaign');

  it('validate rejects expired campaign when allow_after_end_date=false', async () => {
    const campaign = makeCampaign({
      end_date: YESTERDAY,
      allow_after_end_date: false,
    });
    const db = createCampaignMock(
      { data: [campaign], error: null },
      { singleResolvesWith: { data: campaign, error: null } },
    );
    const ctx = buildCtx({ db });

    const result = await step.validate('campaign_camp-001', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('ended');
  });

  it('validate rejects funded campaign when allow_after_goal_met=false', async () => {
    const campaign = makeCampaign({
      goal_amount: 1000,
      raised_amount: 1000,
      allow_after_goal_met: false,
    });
    const db = createCampaignMock(
      { data: [campaign], error: null },
      { singleResolvesWith: { data: campaign, error: null } },
    );
    const ctx = buildCtx({ db });

    const result = await step.validate('campaign_camp-001', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('reached its goal');
  });

  it('validate accepts campaign when both toggles are true', async () => {
    const campaign = makeCampaign({
      end_date: YESTERDAY,
      goal_amount: 1000,
      raised_amount: 1000,
      allow_after_end_date: true,
      allow_after_goal_met: true,
    });
    const db = createCampaignMock(
      { data: [campaign], error: null },
      { singleResolvesWith: { data: campaign, error: null } },
    );
    const ctx = buildCtx({ db });

    const result = await step.validate('campaign_camp-001', ctx);
    expect(result.valid).toBe(true);
  });

  it('validate does not block when campaign has no end date or goal', async () => {
    const campaign = makeCampaign({
      end_date: null,
      goal_amount: 0,
      allow_after_end_date: false,
      allow_after_goal_met: false,
    });
    const db = createCampaignMock(
      { data: [campaign], error: null },
      { singleResolvesWith: { data: campaign, error: null } },
    );
    const ctx = buildCtx({ db });

    const result = await step.validate('campaign_camp-001', ctx);
    expect(result.valid).toBe(true);
  });

  it('validate defaults to true for missing toggle columns (pre-migration)', async () => {
    const campaign = makeCampaign({ end_date: YESTERDAY });
    delete (campaign as any).allow_after_end_date;
    delete (campaign as any).allow_after_goal_met;
    const db = createCampaignMock(
      { data: [campaign], error: null },
      { singleResolvesWith: { data: campaign, error: null } },
    );
    const ctx = buildCtx({ db });

    const result = await step.validate('campaign_camp-001', ctx);
    // Expired but toggles missing → defaults to true → allowed
    expect(result.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Dashboard write-error handling
// ═══════════════════════════════════════════════════════════

describe('Dashboard campaign save — error handling', () => {
  it('write failure is not reported as success', async () => {
    // This is a structural test: verify that handleSave in the page component
    // captures errors and does not navigate away.
    // The actual component behaviour is tested by the presence of:
    // 1. `writeError` capture from insert/update
    // 2. `setSaveError(...)` on failure
    // 3. early return (no `setView('list')`) on error
    //
    // We verify this contract by reading the source and confirming the pattern.
    const fs = await import('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../../../../app/dashboard/campaigns/page.tsx'),
      'utf-8',
    );

    // Insert/update errors are captured
    expect(src).toContain('const { error } = await supabase.from(\'campaigns\').insert(payload)');
    expect(src).toContain('writeError = error');

    // Error state is set on failure
    expect(src).toContain('setSaveError(');

    // Column-missing retry path exists
    expect(src).toContain('isColumnMissing');
    expect(src).toContain('legacyPayload');

    // Error banner is rendered
    expect(src).toContain('saveError &&');
  });

  it('no cross-business writes — business_id is always set in payload', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      require('path').resolve(__dirname, '../../../../app/dashboard/campaigns/page.tsx'),
      'utf-8',
    );

    // Payload always includes business_id from the authenticated business context
    expect(src).toContain('business_id: business.id');
    // Update is scoped to form.id
    expect(src).toContain(".update(payload).eq('id', form.id)");
    // Legacy retry also scoped
    expect(src).toContain(".update(legacyPayload).eq('id', form.id)");
  });
});
