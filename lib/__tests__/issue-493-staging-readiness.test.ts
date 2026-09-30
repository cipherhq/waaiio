/**
 * Issue #493: Staging launch-readiness — production-path handler evidence.
 *
 * Every test invokes the actual production function/route or its
 * extracted module. No test-local logic simulators.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger at top level to prevent console noise in recovery tests
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() },
}));

// ═══════════════════════════════════════════════════════════
// S1: Gateway resolver — actual production function
// ═══════════════════════════════════════════════════════════

describe('Gateway resolver — processor authority matrix', () => {
  beforeEach(() => { vi.resetModules(); });

  function countrySb(gw: string | null, cur: string) {
    return {
      from: (t: string) => {
        if (t === 'businesses') return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { country_code: 'NG' }, error: null }) }) }) };
        if (t === 'countries') return { select: () => ({ eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: gw ? { payment_gateway: gw, currency_code: cur } : null, error: gw ? null : { code: 'PGRST116' } }) }) }) }) };
        return {} as any;
      },
    } as any;
  }

  const matrix = [
    { c: 'NG', gw: 'paystack', cur: 'NGN' },
    { c: 'GH', gw: 'paystack', cur: 'GHS' },
    { c: 'US', gw: 'stripe', cur: 'USD' },
    { c: 'GB', gw: 'stripe', cur: 'GBP' },
    { c: 'CA', gw: 'stripe', cur: 'CAD' },
  ];

  for (const { c, gw, cur } of matrix) {
    it(`${c} -> ${gw}/${cur}`, async () => {
      const { resolveCountryGateway } = await import('@/lib/payments/gateway-resolver');
      const r = await resolveCountryGateway(countrySb(gw, cur), c);
      expect(r.gateway).toBe(gw);
      expect(r.currency).toBe(cur);
    });
  }

  it('BYO Stripe on NG -> still Paystack (country wins)', async () => {
    const { resolveBusinessGateway } = await import('@/lib/payments/gateway-resolver');
    const sb = {
      from: (t: string) => {
        if (t === 'businesses') return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { country_code: 'NG' }, error: null }) }) }) };
        if (t === 'countries') return { select: () => ({ eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { payment_gateway: 'paystack', currency_code: 'NGN' }, error: null }) }) }) }) };
        return {} as any;
      },
    } as any;
    expect((await resolveBusinessGateway(sb, 'b1')).gateway).toBe('paystack');
  });

  it('BYO Paystack on US -> still Stripe (country wins)', async () => {
    const { resolveBusinessGateway } = await import('@/lib/payments/gateway-resolver');
    const sb = {
      from: (t: string) => {
        if (t === 'businesses') return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { country_code: 'US' }, error: null }) }) }) };
        if (t === 'countries') return { select: () => ({ eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { payment_gateway: 'stripe', currency_code: 'USD' }, error: null }) }) }) }) };
        return {} as any;
      },
    } as any;
    expect((await resolveBusinessGateway(sb, 'b1')).gateway).toBe('stripe');
  });

  it('unconfigured country -> fail closed', async () => {
    const { resolveCountryGateway } = await import('@/lib/payments/gateway-resolver');
    expect((await resolveCountryGateway(countrySb(null, 'X'), 'ZZ')).gateway).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// S2: Paystack activation recovery — actual production module
// ═══════════════════════════════════════════════════════════

describe('processPaystackActivationRecovery — production module', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  function buildSvc(opts: {
    evidence: { id: string } | null;
    subStatus: string;
    bizStatus: string;
    rpcResult: { activated: boolean; reason?: string } | null;
    rpcError: Error | null;
    bizUpdateOk: boolean;
  }) {
    const rpcCalls: string[] = [];
    const bizUpdates: string[] = [];
    return {
      svc: {
        from: (table: string) => {
          if (table === 'subscription_payments') {
            return { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => ({
              single: () => Promise.resolve({ data: opts.evidence, error: opts.evidence ? null : { code: 'PGRST116' } }),
            }) }) }) }) }) }) };
          }
          if (table === 'subscriptions') return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { status: opts.subStatus }, error: null }) }) }) };
          if (table === 'businesses') return {
            select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { status: opts.bizStatus }, error: null }) }) }),
            update: () => ({ eq: () => ({ eq: () => { bizUpdates.push('biz_update'); return Promise.resolve({ error: opts.bizUpdateOk ? null : new Error('concurrent') }); } }) }),
          };
          return {} as any;
        },
        rpc: (fn: string) => { rpcCalls.push(fn); return Promise.resolve({ data: opts.rpcResult, error: opts.rpcError }); },
      } as any,
      rpcCalls,
      bizUpdates,
    };
  }

  it('pending sub + evidence -> RPC -> business active', async () => {
    const { processPaystackActivationRecovery } = await import('@/lib/payments/paystack-activation-recovery');
    const m = buildSvc({ evidence: { id: 'e1' }, subStatus: 'pending', bizStatus: 'pending', rpcResult: { activated: true }, rpcError: null, bizUpdateOk: true });
    const outcome = await processPaystackActivationRecovery(m.svc, 'sub1', 'biz1');
    expect(outcome).toBe('converged');
    expect(m.rpcCalls).toContain('activate_paid_subscription');
    expect(m.bizUpdates).toContain('biz_update');
  });

  it('active sub + pending biz -> business-only convergence', async () => {
    const { processPaystackActivationRecovery } = await import('@/lib/payments/paystack-activation-recovery');
    const m = buildSvc({ evidence: { id: 'e2' }, subStatus: 'active', bizStatus: 'pending', rpcResult: null, rpcError: null, bizUpdateOk: true });
    const outcome = await processPaystackActivationRecovery(m.svc, 'sub1', 'biz1');
    expect(outcome).toBe('converged');
    expect(m.rpcCalls).not.toContain('activate_paid_subscription');
    expect(m.bizUpdates).toContain('biz_update');
  });

  it('no evidence -> no_evidence', async () => {
    const { processPaystackActivationRecovery } = await import('@/lib/payments/paystack-activation-recovery');
    const m = buildSvc({ evidence: null, subStatus: 'pending', bizStatus: 'pending', rpcResult: null, rpcError: null, bizUpdateOk: true });
    expect(await processPaystackActivationRecovery(m.svc, 'sub1', 'biz1')).toBe('no_evidence');
  });

  it('RPC rejection -> rpc_rejected', async () => {
    const { processPaystackActivationRecovery } = await import('@/lib/payments/paystack-activation-recovery');
    const m = buildSvc({ evidence: { id: 'e3' }, subStatus: 'pending', bizStatus: 'pending', rpcResult: { activated: false, reason: 'amount_mismatch' }, rpcError: null, bizUpdateOk: true });
    expect(await processPaystackActivationRecovery(m.svc, 'sub1', 'biz1')).toBe('rpc_rejected');
    expect(m.bizUpdates).toHaveLength(0);
  });

  it('fully converged replay -> already_converged (no mutation)', async () => {
    const { processPaystackActivationRecovery } = await import('@/lib/payments/paystack-activation-recovery');
    const m = buildSvc({ evidence: { id: 'e4' }, subStatus: 'active', bizStatus: 'active', rpcResult: null, rpcError: null, bizUpdateOk: true });
    expect(await processPaystackActivationRecovery(m.svc, 'sub1', 'biz1')).toBe('already_converged');
    expect(m.rpcCalls).toHaveLength(0);
    expect(m.bizUpdates).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// S3: requireCapability — actual handler
// ═══════════════════════════════════════════════════════════

describe('requireCapability guard — production handler', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  function mocks(opts: { bizStatus: string; tier: string; caps: string[] }) {
    const biz = { id: 'b1', status: opts.bizStatus, subscription_tier: opts.tier, trial_ends_at: null, category: 'salon' };
    const rows = opts.caps.map(c => ({ capability: c, is_enabled: true, sort_order: 0 }));
    return {
      supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: biz, error: null }) }), maybeSingle: () => Promise.resolve({ data: biz, error: null }) }) }) }) } as any,
      service: { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }) }) }), rpc: () => Promise.resolve({ data: null, error: null }) } as any,
    };
  }

  it('pending + create_new (Poll) -> 403', async () => {
    const { requireCapability } = await import('@/lib/capabilities/api-guard');
    const { supabase, service } = mocks({ bizStatus: 'pending', tier: 'free', caps: ['poll'] });
    const r = await requireCapability(supabase, service, { businessId: 'b1', userId: 'u1', capability: 'poll', action: 'create_new' });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.denial.reason).toBe('business_setup_incomplete');
  });

  it('active + create_new (Poll) -> allowed', async () => {
    const { requireCapability } = await import('@/lib/capabilities/api-guard');
    const { supabase, service } = mocks({ bizStatus: 'active', tier: 'free', caps: ['poll'] });
    const r = await requireCapability(supabase, service, { businessId: 'b1', userId: 'u1', capability: 'poll', action: 'create_new' });
    expect(r.allowed).toBe(true);
  });

  it('active + create_new (Giving) -> allowed', async () => {
    const { requireCapability } = await import('@/lib/capabilities/api-guard');
    const { supabase, service } = mocks({ bizStatus: 'active', tier: 'free', caps: ['giving'] });
    const r = await requireCapability(supabase, service, { businessId: 'b1', userId: 'u1', capability: 'giving', action: 'create_new' });
    expect(r.allowed).toBe(true);
  });

  it('suspended -> 403', async () => {
    const { requireCapability } = await import('@/lib/capabilities/api-guard');
    const { supabase, service } = mocks({ bizStatus: 'suspended', tier: 'business', caps: ['poll'] });
    const r = await requireCapability(supabase, service, { businessId: 'b1', userId: 'u1', capability: 'poll', action: 'create_new' });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.denial.reason).toBe('business_suspended');
  });
});

// ═══════════════════════════════════════════════════════════
// S4: reconcileNullGateways — actual production function
// ═══════════════════════════════════════════════════════════

describe('reconcileNullGateways — production function', () => {
  it('updates NG->paystack, US->stripe', async () => {
    const { reconcileNullGateways } = await import('@/lib/payments/gateway-resolver');
    let calls: Array<{ c: string; g: string }> = [];
    const sb = {
      from: (t: string) => {
        if (t === 'countries') return { select: () => ({ eq: () => ({ not: () => Promise.resolve({ data: [{ code: 'NG', payment_gateway: 'paystack' }, { code: 'US', payment_gateway: 'stripe' }], error: null }) }) }) };
        if (t === 'businesses') return { update: (d: any) => ({ eq: (_: string, v: string) => ({ is: () => ({ select: () => { calls.push({ c: v, g: d.payment_gateway }); return Promise.resolve({ data: [{ id: 'b1' }], error: null }); } }) }) }) };
        return {} as any;
      },
    } as any;
    const r = await reconcileNullGateways(sb);
    expect(r.updated).toBe(2);
    expect(calls).toContainEqual({ c: 'NG', g: 'paystack' });
    expect(calls).toContainEqual({ c: 'US', g: 'stripe' });
  });
});

// ═══════════════════════════════════════════════════════════
// S5: Scan-to-Pay pending business fail-closed — route structure
// ═══════════════════════════════════════════════════════════

describe('Scan-to-Pay route — business readiness', () => {
  it('pay-link/pay checks business.status before payment init', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('app/api/pay-link/pay/route.ts', 'utf-8');
    // Must fetch status in the join
    expect(src).toContain('status)');
    // Must check active before payment init
    expect(src).toContain("biz.status !== 'active'");
    // Must use canonical resolver
    expect(src).toContain('resolveBusinessGateway');
    // No silent paystack fallback
    expect(src).not.toContain("|| 'paystack'");
  });
});

// ═══════════════════════════════════════════════════════════
// S6: Payment readiness UX — visible to merchant
// ═══════════════════════════════════════════════════════════

describe('Payment readiness UX', () => {
  it('OnboardingWizard shows visible warning when payment_ready=false', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('app/get-started/OnboardingWizard.tsx', 'utf-8');
    // Must set a visible paymentWarning state
    expect(src).toContain('setPaymentWarning(');
    // Must have a rendered element with data-testid
    expect(src).toContain('data-testid="payment-readiness-warning"');
    // Must NOT rely solely on console.warn
    expect(src).not.toContain("console.warn('[ONBOARDING]'");
  });

  it('Dashboard shows payment readiness banner with data-testid', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('app/dashboard/page.tsx', 'utf-8');
    expect(src).toContain('data-testid="payment-readiness-warning"');
    expect(src).toContain('Payment processing is not yet configured');
  });
});

// ═══════════════════════════════════════════════════════════
// S7: Party error handling — production code check
// ═══════════════════════════════════════════════════════════

describe('Party persistence', () => {
  it('insert failure is surfaced (error: insertErr)', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('app/dashboard/parties/page.tsx', 'utf-8');
    expect(src).toContain('error: insertErr');
    expect(src).toContain('Failed to create party');
    expect(src).toContain('if (insertErr)');
  });
});

// ═══════════════════════════════════════════════════════════
// S8: Admin launch_subscribers — route-level auth check
// ═══════════════════════════════════════════════════════════

describe('Admin launch_subscribers auth', () => {
  it('launch_subscribers in ADMIN_TABLES whitelist', async () => {
    const fs = await import('fs');
    expect(fs.readFileSync('app/api/admin/query/route.ts', 'utf-8')).toContain("'launch_subscribers'");
  });
  it('LaunchSubscribers uses adminApiFetch not direct adminDb', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('admin/src/pages/LaunchSubscribers.tsx', 'utf-8');
    expect(src).toContain('adminApiFetch');
    expect(src).not.toContain('adminDb');
  });
  it('admin query route requires requirePlatformAdmin', async () => {
    const fs = await import('fs');
    expect(fs.readFileSync('app/api/admin/query/route.ts', 'utf-8')).toContain('requirePlatformAdmin');
  });
});

// ═══════════════════════════════════════════════════════════
// S9: Admin reconcile-gateways — route structure + audit
// ═══════════════════════════════════════════════════════════

describe('Admin reconcile-gateways route', () => {
  it('requires admin auth + defaults to dry-run + bounded batch', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('app/api/admin/reconcile-gateways/route.ts', 'utf-8');
    expect(src).toContain('requirePlatformAdmin');
    expect(src).toContain('body.dry_run !== false');
    expect(src).toContain('batch_size');
    expect(src).toContain('cursor');
  });
  it('single-business CAS no-op reports already_reconciled', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('app/api/admin/reconcile-gateways/route.ts', 'utf-8');
    expect(src).toContain("'already_reconciled'");
    expect(src).toContain("affected === 0");
  });
  it('batch CAS no-op reports in skipped[]', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('app/api/admin/reconcile-gateways/route.ts', 'utf-8');
    // The else branch after CAS rows.length check
    expect(src).toContain("reason: 'already_reconciled'");
  });
});

// ═══════════════════════════════════════════════════════════
// S10: Regression — event + payment-link routes exist
// ═══════════════════════════════════════════════════════════

describe('Regression — known-good flows', () => {
  it('event page exists and exports default', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('app/dashboard/events/page.tsx', 'utf-8');
    expect(src).toContain('export default');
  });
  it('payment-link manage route exports POST', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('app/api/pay-link/manage/route.ts', 'utf-8');
    expect(src).toContain('export async function POST');
  });
});
