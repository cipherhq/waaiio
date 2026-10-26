import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runSealedRuleActions } from '../sealed-rule-actions';
import { sealRuleActions, type FrozenRuleAction } from '@/lib/payments/terminal-effects';

/**
 * Mock template category resolver simulating Meta API responses.
 * Maps template names to their APPROVED Meta categories.
 * Unknown templates return null (fail-closed).
 */
const MOCK_TEMPLATE_CATEGORIES: Record<string, 'utility' | 'marketing' | 'authentication'> = {
  booking_confirmation: 'utility',
  business_promotion: 'marketing',
  waaiio_event_invite: 'marketing',
  feedback_request: 'marketing',
};
const mockCategoryResolver = async (_s: SupabaseClient, _b: string, templateName: string) =>
  MOCK_TEMPLATE_CATEGORIES[templateName] || null;

type Candidate = {
  rule_id: string;
  action_type: string;
  action_payload: Record<string, unknown>;
  action_fingerprint: string;
};

function raceStore() {
  let manifest: { action_count: number } | null = null;
  let rows: FrozenRuleAction[] = [];
  let botRuleReads = 0;

  const supabase = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'seal_payment_rule_actions') {
        if (manifest) return { data: null, error: { code: '23505', message: 'winner already sealed' } };
        const actions = args.p_actions as Candidate[];
        manifest = { action_count: actions.length };
        rows = actions.map((action, index) => ({
          id: `execution-${index}`,
          rule_id: action.rule_id,
          action_type: action.action_type,
          action_payload: action.action_payload,
          status: 'pending',
        }));
        return { data: { sealed: true, action_count: actions.length }, error: null };
      }
      if (name === 'advance_rule_action') {
        const row = rows.find(item => item.rule_id === args.p_rule_id);
        if (!row) return { data: { advanced: false, reason: 'not_found' }, error: null };
        const target = args.p_target_status as FrozenRuleAction['status'];
        const legal = (row.status === 'pending' && ['sending', 'completed', 'failed'].includes(target))
          || (row.status === 'sending' && ['completed', 'indeterminate'].includes(target));
        if (!legal) return { data: { advanced: false, reason: 'not_pending' }, error: null };
        row.status = target;
        return { data: { advanced: true }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    }),
    from: vi.fn((table: string) => {
      if (table === 'payment_rule_action_manifests') {
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn(() => chain),
          maybeSingle: vi.fn(async () => ({ data: manifest, error: null })),
        };
        return chain;
      }
      if (table === 'payment_rule_action_executions') {
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn(async () => ({ data: rows.map(row => ({ ...row })), error: null })),
        };
        return chain;
      }
      if (table === 'whatsapp_channels') {
        // Return a mock channel with WABA credentials for template resolution
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn(() => chain),
          maybeSingle: vi.fn(async () => ({
            data: { waba_id: 'test-waba-123', meta_access_token: 'test-token-abc' },
            error: null,
          })),
        };
        return chain;
      }
      if (table === 'bot_rules') {
        botRuleReads += 1;
        throw new Error('live rules must not be read after a seal exists');
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };

  return {
    supabase: supabase as unknown as SupabaseClient,
    getRows: () => rows,
    getBotRuleReads: () => botRuleReads,
  };
}

describe('sealed Phase-A rule execution', () => {
  it('concurrent loser converges to winner rows and retries neither re-evaluate nor duplicate emission', async () => {
    const store = raceStore();
    const winner: Candidate[] = [{
      rule_id: 'winner-rule',
      action_type: 'send_message',
      action_payload: { message: 'winner {{customer_name}}' },
      action_fingerprint: 'winner-fingerprint',
    }];
    const loser: Candidate[] = [{
      rule_id: 'loser-rule',
      action_type: 'send_message',
      action_payload: { message: 'loser' },
      action_fingerprint: 'loser-fingerprint',
    }, {
      rule_id: 'loser-rule-2',
      action_type: 'assign_tag',
      action_payload: { tag: 'incorrect-candidate' },
      action_fingerprint: 'loser-fingerprint-2',
    }];

    const [won, converged] = await Promise.all([
      sealRuleActions(store.supabase, 'payment-1', winner),
      sealRuleActions(store.supabase, 'payment-1', loser),
    ]);
    expect(won).toMatchObject({ ok: true, actionCount: 1 });
    expect(converged).toMatchObject({ ok: true, alreadySealed: true, actionCount: 1 });
    expect(store.getRows().map(row => row.rule_id)).toEqual(['winner-rule']);

    const sendText = vi.fn().mockResolvedValue(undefined);
    const params = {
      supabase: store.supabase,
      paymentId: 'payment-1',
      businessId: 'business-1',
      event: 'booking_completed',
      context: { customer_phone: '+15551234567', customer_name: 'Ada' },
      sender: { sendText } as never,
    };
    await expect(runSealedRuleActions(params)).resolves.toEqual({ actionCount: 1, terminalCount: 1 });
    await expect(runSealedRuleActions(params)).resolves.toEqual({ actionCount: 1, terminalCount: 1 });

    expect(sendText).toHaveBeenCalledOnce();
    // Merchant-authored freeform text: no forced messageCategory (fail-closed at gate)
    expect(sendText).toHaveBeenCalledWith({ to: '15551234567', text: 'winner Ada' });
    expect(store.getBotRuleReads()).toBe(0);
  });

  it('reconciles a retry-observed sending row to indeterminate without re-emission', async () => {
    const store = raceStore();
    await sealRuleActions(store.supabase, 'payment-2', [{
      rule_id: 'possibly-emitted',
      action_type: 'notify_owner',
      action_payload: { message: 'check' },
      action_fingerprint: 'fp',
    }]);
    store.getRows()[0].status = 'sending';
    const sendText = vi.fn();

    await expect(runSealedRuleActions({
      supabase: store.supabase,
      paymentId: 'payment-2',
      businessId: 'business-1',
      event: 'booking_completed',
      context: { customer_phone: '+15551234567' },
      sender: { sendText } as never,
    })).resolves.toEqual({ actionCount: 1, terminalCount: 1 });

    expect(store.getRows()[0].status).toBe('indeterminate');
    expect(sendText).not.toHaveBeenCalled();
    expect(store.getBotRuleReads()).toBe(0);
  });

  it('utility template sends with messageCategory utility', async () => {
    const store = raceStore();
    await sealRuleActions(store.supabase, 'payment-tmpl-u', [{
      rule_id: 'tmpl-utility-rule',
      action_type: 'send_template',
      action_payload: { template_name: 'booking_confirmation', template_params: ['Alice', 'Spa', 'Dec 1', '10am', 'Massage', 'BK-001'] },
      action_fingerprint: 'fp-tmpl-u',
    }]);
    const sendTemplate = vi.fn().mockResolvedValue(undefined);
    await runSealedRuleActions({
      supabase: store.supabase,
      paymentId: 'payment-tmpl-u',
      businessId: 'business-1',
      event: 'payment_received',
      context: { customer_phone: '+15551234567' },
      sender: { sendText: vi.fn(), sendTemplate } as never,
      _resolveTemplateCategory: mockCategoryResolver,
    });
    expect(sendTemplate).toHaveBeenCalledOnce();
    expect(sendTemplate).toHaveBeenCalledWith({
      to: '15551234567',
      templateName: 'booking_confirmation',
      templateParams: ['Alice', 'Spa', 'Dec 1', '10am', 'Massage', 'BK-001'],
      messageCategory: 'utility',
    });
  });

  it('marketing template sends with messageCategory marketing', async () => {
    const store = raceStore();
    await sealRuleActions(store.supabase, 'payment-tmpl-m', [{
      rule_id: 'tmpl-marketing-rule',
      action_type: 'send_template',
      action_payload: { template_name: 'business_promotion', template_params: ['Fresh Cuts', '20% off!'] },
      action_fingerprint: 'fp-tmpl-m',
    }]);
    const sendTemplate = vi.fn().mockResolvedValue(undefined);
    await runSealedRuleActions({
      supabase: store.supabase,
      paymentId: 'payment-tmpl-m',
      businessId: 'business-1',
      event: 'payment_received',
      context: { customer_phone: '+15559876543' },
      sender: { sendText: vi.fn(), sendTemplate } as never,
      _resolveTemplateCategory: mockCategoryResolver,
    });
    expect(sendTemplate).toHaveBeenCalledOnce();
    expect(sendTemplate).toHaveBeenCalledWith({
      to: '15559876543',
      templateName: 'business_promotion',
      templateParams: ['Fresh Cuts', '20% off!'],
      messageCategory: 'marketing',
    });
  });

  it('unknown template fails closed — no provider emission, action goes indeterminate', async () => {
    const store = raceStore();
    await sealRuleActions(store.supabase, 'payment-tmpl-unk', [{
      rule_id: 'tmpl-unknown-rule',
      action_type: 'send_template',
      action_payload: { template_name: 'totally_unknown_template', template_params: [] },
      action_fingerprint: 'fp-tmpl-unk',
    }]);
    const sendTemplate = vi.fn();
    await runSealedRuleActions({
      supabase: store.supabase,
      paymentId: 'payment-tmpl-unk',
      businessId: 'business-1',
      event: 'payment_received',
      context: { customer_phone: '+15551234567' },
      sender: { sendText: vi.fn(), sendTemplate } as never,
      _resolveTemplateCategory: mockCategoryResolver,
    });
    // Template must NOT have been called — fail-closed before emission
    expect(sendTemplate).not.toHaveBeenCalled();
    // Action must be terminal (indeterminate, since it crossed the sending fence)
    expect(store.getRows()[0].status).toBe('indeterminate');
  });

  it('legacy freeform template (no template_name) sends as text without forced category', async () => {
    const store = raceStore();
    await sealRuleActions(store.supabase, 'payment-tmpl-legacy', [{
      rule_id: 'tmpl-legacy-rule',
      action_type: 'send_template',
      action_payload: { template: 'Thank you {{customer_name}}!' },
      action_fingerprint: 'fp-tmpl-legacy',
    }]);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendTemplate = vi.fn();
    await runSealedRuleActions({
      supabase: store.supabase,
      paymentId: 'payment-tmpl-legacy',
      businessId: 'business-1',
      event: 'payment_received',
      context: { customer_phone: '+15551234567', customer_name: 'Bob' },
      sender: { sendText, sendTemplate } as never,
      _resolveTemplateCategory: mockCategoryResolver,
    });
    // Legacy path uses sendText (freeform), not sendTemplate
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledOnce();
    // Merchant-authored freeform: no forced category (gate decides)
    expect(sendText).toHaveBeenCalledWith({ to: '15551234567', text: 'Thank you Bob!' });
  });

  it('waaiio_event_invite template resolves as marketing', async () => {
    const store = raceStore();
    await sealRuleActions(store.supabase, 'payment-tmpl-evt', [{
      rule_id: 'tmpl-event-invite-rule',
      action_type: 'send_template',
      action_payload: { template_name: 'waaiio_event_invite', template_params: ['Event details', 'https://example.com/rsvp'] },
      action_fingerprint: 'fp-tmpl-evt',
    }]);
    const sendTemplate = vi.fn().mockResolvedValue(undefined);
    await runSealedRuleActions({
      supabase: store.supabase,
      paymentId: 'payment-tmpl-evt',
      businessId: 'business-1',
      event: 'payment_received',
      context: { customer_phone: '+15551234567' },
      sender: { sendText: vi.fn(), sendTemplate } as never,
      _resolveTemplateCategory: mockCategoryResolver,
    });
    expect(sendTemplate).toHaveBeenCalledOnce();
    expect(sendTemplate).toHaveBeenCalledWith({
      to: '15551234567',
      templateName: 'waaiio_event_invite',
      templateParams: ['Event details', 'https://example.com/rsvp'],
      messageCategory: 'marketing',
    });
  });

  it('template category resolver failure → fail closed, no emission', async () => {
    const store = raceStore();
    await sealRuleActions(store.supabase, 'payment-tmpl-fail', [{
      rule_id: 'tmpl-fail-rule',
      action_type: 'send_template',
      action_payload: { template_name: 'booking_confirmation', template_params: [] },
      action_fingerprint: 'fp-tmpl-fail',
    }]);
    const sendTemplate = vi.fn();
    // Resolver throws (simulating Meta API failure)
    const failResolver = async () => { throw new Error('Meta API timeout'); };
    await runSealedRuleActions({
      supabase: store.supabase,
      paymentId: 'payment-tmpl-fail',
      businessId: 'business-1',
      event: 'payment_received',
      context: { customer_phone: '+15551234567' },
      sender: { sendText: vi.fn(), sendTemplate } as never,
      _resolveTemplateCategory: failResolver as never,
    });
    // No provider emission on resolver failure
    expect(sendTemplate).not.toHaveBeenCalled();
    // Action goes indeterminate (crossed sending fence but failed before emission)
    expect(store.getRows()[0].status).toBe('indeterminate');
  });

  it('fails closed when live rule discovery errors before the initial seal', async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'payment_rule_action_manifests') {
          const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), maybeSingle: vi.fn(async () => ({ data: null, error: null })) };
          return chain;
        }
        if (table === 'bot_rules') {
          const chain = {
            select: vi.fn(() => chain), eq: vi.fn(() => chain),
            order: vi.fn(async () => ({ data: null, error: { message: 'database unavailable' } })),
          };
          return chain;
        }
        throw new Error(`unexpected table ${table}`);
      }),
    } as unknown as SupabaseClient;

    await expect(runSealedRuleActions({
      supabase, paymentId: 'payment-3', businessId: 'business-1',
      event: 'booking_completed', context: {},
    })).rejects.toThrow('rule_discovery_failed:database unavailable');
  });
});
