import { describe, expect, it, vi } from 'vitest';
import type { FlowContext } from '../types';
import { paymentFlow } from '../payment.flow';
import { schedulingFlow } from '../scheduling.flow';
import { crowdfundingFlow } from '../crowdfunding.flow';
import { buildListItem, truncTitle } from '../../utils/truncate';
import { formatCurrency } from '@/lib/constants';

function queryResult(data: unknown, error: unknown = null) {
  const chain: Record<string, any> = {};
  for (const method of [
    'select', 'eq', 'neq', 'is', 'order', 'limit', 'in', 'or', 'gte', 'lte', 'not',
  ]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve({ data, error }).then(resolve, reject);
  return chain;
}

function makeContext(opts: {
  tables?: Record<string, unknown>;
  sessionData?: Record<string, unknown>;
  countryCode?: 'NG' | 'US' | 'GB' | 'GH';
} = {}): FlowContext {
  const tables = opts.tables || {};
  return {
    supabase: {
      from: vi.fn((table: string) => queryResult(tables[table] ?? [])),
    } as any,
    sender: {} as any,
    standalone: {} as any,
    intelligence: {} as any,
    from: '+2348000000000',
    session: {
      id: 'session-227',
      user_id: 'user-227',
      business_id: 'biz-227',
      current_step: 'test',
      session_data: opts.sessionData || {},
      version: 1,
    },
    business: {
      id: 'biz-227',
      name: 'Test Business',
      slug: 'test-business',
      category: 'other',
      flow_type: 'scheduling',
      subscription_tier: 'free',
      trial_ends_at: '2026-12-31T00:00:00.000Z',
      metadata: {},
      country_code: opts.countryCode || 'NG',
    },
    t: async (text: string) => text,
  } as FlowContext;
}

function getList(messages: Awaited<ReturnType<NonNullable<(typeof paymentFlow.steps)[number]['prompt']>>>) {
  const list = messages.find(m => m.type === 'list');
  expect(list?.type).toBe('list');
  return list as Extract<(typeof messages)[number], { type: 'list' }>;
}

describe('#227 shared WhatsApp list row formatter', () => {
  it('keeps exact-boundary titles unchanged', () => {
    const name = 'A'.repeat(24);
    expect(truncTitle(name, 24)).toBe(name);
    expect(buildListItem({ name, detail: '$10/month', postbackText: 'id-1' })).toEqual({
      title: name,
      description: '$10/month',
      postbackText: 'id-1',
    });
  });

  it('reserves description space for material detail before long-name context', () => {
    const detail = '₦5,000/month · Recurring';
    const item = buildListItem({
      name: 'A Very Long Business Service Name That Cannot Fit In WhatsApp',
      detail,
      postbackText: 'svc-long',
    });

    expect(item.title.length).toBeLessThanOrEqual(24);
    expect(item.title).toContain('…');
    expect(item.description?.startsWith(detail)).toBe(true);
    expect(item.description?.length).toBeLessThanOrEqual(72);
    expect(item.postbackText).toBe('svc-long');
  });

  it('never splits a surrogate pair when truncating emoji-heavy titles/descriptions', () => {
    const title = truncTitle('ABCDEFGHIJKLMNOPQR🎉Z', 20);
    const item = buildListItem({
      name: 'A'.repeat(30),
      detail: 'D'.repeat(70) + '🎉🎉',
      postbackText: 'emoji',
    });

    for (const value of [title, item.description || '']) {
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
          const next = value.charCodeAt(i + 1);
          expect(next).toBeGreaterThanOrEqual(0xDC00);
          expect(next).toBeLessThanOrEqual(0xDFFF);
          i++;
        } else {
          expect(code < 0xDC00 || code > 0xDFFF).toBe(true);
        }
      }
    }
  });
});

describe('#227 actual flow prompt rows', () => {
  it('Payment/Giving keeps Biazo Conference amount + monthly frequency visible', async () => {
    const price = 1000;
    const ctx = makeContext({
      tables: {
        services: [{
          id: 'svc-biazo',
          name: 'Biazo Conference',
          billing_type: 'recurring',
          recurring_interval: 'monthly',
          price,
        }],
      },
      sessionData: { active_capability: 'giving' },
    });

    const step = paymentFlow.steps.find(s => s.id === 'select_category')!;
    const list = getList(await step.prompt(ctx));
    const row = list.items[0];
    const exactDetail = `${formatCurrency(price, 'NG')}/month`;

    expect(row.title).toBe('Biazo Conference');
    expect(row.description).toBe(exactDetail);
    expect(row.postbackText).toBe('svc-biazo');
    expect(row.title.length).toBeLessThanOrEqual(24);
    expect(row.description!.length).toBeLessThanOrEqual(72);
  });

  it('Payment/Giving keeps exact configured amount/frequency first even with a very long name', async () => {
    const price = 5000;
    const ctx = makeContext({
      tables: {
        services: [{
          id: 'svc-long',
          name: 'Premium Monthly Worship Experience Contribution Category',
          billing_type: 'recurring',
          recurring_interval: 'weekly',
          price,
        }],
      },
      sessionData: { active_capability: 'giving' },
    });

    const step = paymentFlow.steps.find(s => s.id === 'select_category')!;
    const list = getList(await step.prompt(ctx));
    const row = list.items[0];
    const exactDetail = `${formatCurrency(price, 'NG')}/week`;

    expect(row.title.length).toBeLessThanOrEqual(24);
    expect(row.description?.startsWith(exactDetail)).toBe(true);
    expect(row.description!.length).toBeLessThanOrEqual(72);
    expect(row.postbackText).toBe('svc-long');
  });

  it('Scheduling add-on keeps the configured price visible and postback unchanged', async () => {
    const price = 15000;
    const ctx = makeContext({
      sessionData: {
        _available_addons: [{
          id: 'addon-long',
          name: 'Professional Photography Session Package',
          price,
          is_required: false,
        }],
      },
    });

    const step = schedulingFlow.steps.find(s => s.id === 'select_addons')!;
    const list = getList(await step.prompt(ctx));
    const row = list.items[0];
    const exactDetail = formatCurrency(price, 'NG');

    expect(row.title.length).toBeLessThanOrEqual(24);
    expect((row.description || row.title)).toContain(exactDetail);
    expect(row.postbackText).toBe('addon-long');
  });

  it('Crowdfunding keeps progress/donor detail while safely truncating a long campaign title', async () => {
    const raised = 100000;
    const ctx = makeContext({
      tables: {
        campaigns: [{
          id: 'campaign-xyz',
          title: 'Build a Brand New Community Center for Everyone in the Village',
          description: null,
          goal_amount: 500000,
          raised_amount: raised,
          donor_count: 42,
          end_date: null,
          allow_after_end_date: true,
          allow_after_goal_met: true,
        }],
      },
    });

    const step = crowdfundingFlow.steps.find(s => s.id === 'select_campaign')!;
    const list = getList(await step.prompt(ctx));
    const row = list.items[0];
    const exactDetail = `${formatCurrency(raised, 'NG')} raised (20%) - 42 donors`;

    expect(row.title.length).toBeLessThanOrEqual(24);
    expect(row.title).toContain('…');
    expect(row.description?.startsWith(exactDetail)).toBe(true);
    expect(row.description!.length).toBeLessThanOrEqual(72);
    expect(row.postbackText).toBe('campaign_campaign-xyz');
  });
});
