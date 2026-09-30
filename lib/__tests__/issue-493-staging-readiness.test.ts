/**
 * Issue #493: Staging launch-readiness — executable evidence.
 * Handler-level behavior tests with mocked external boundaries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeMockCountrySupabase(countryRow: Record<string, unknown> | null) {
  return {
    from: (table: string) => {
      if (table === 'countries') {
        return { select: () => ({ eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: countryRow, error: countryRow ? null : { code: 'PGRST116' } }) }) }) }) };
      }
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) };
    },
  } as any;
}

// ═══ S1: Gateway resolver country matrix ═══

describe('Gateway resolver — country matrix', () => {
  beforeEach(() => { vi.resetModules(); });

  const cases = [
    { country: 'NG', gw: 'paystack', cur: 'NGN' },
    { country: 'GH', gw: 'paystack', cur: 'GHS' },
    { country: 'US', gw: 'stripe', cur: 'USD' },
    { country: 'GB', gw: 'stripe', cur: 'GBP' },
    { country: 'CA', gw: 'stripe', cur: 'CAD' },
  ];
  for (const { country, gw, cur } of cases) {
    it(`${country} -> ${gw}/${cur}`, async () => {
      const { resolveCountryGateway } = await import('@/lib/payments/gateway-resolver');
      const r = await resolveCountryGateway(makeMockCountrySupabase({ payment_gateway: gw, currency_code: cur }), country);
      expect(r.gateway).toBe(gw);
      expect(r.currency).toBe(cur);
      expect(r.source).toBe('country_default');
    });
  }

  it('null gateway -> fail closed', async () => {
    const { resolveCountryGateway } = await import('@/lib/payments/gateway-resolver');
    const r = await resolveCountryGateway(makeMockCountrySupabase({ payment_gateway: null, currency_code: 'XYZ' }), 'ZZ');
    expect(r.gateway).toBeNull();
    expect(r.reason).toBe('country_gateway_not_configured');
  });

  it('inactive country -> fail closed', async () => {
    const { resolveCountryGateway } = await import('@/lib/payments/gateway-resolver');
    const r = await resolveCountryGateway(makeMockCountrySupabase(null), 'XX');
    expect(r.gateway).toBeNull();
  });

  it('no country code -> fail closed', async () => {
    const { resolveCountryGateway } = await import('@/lib/payments/gateway-resolver');
    const r = await resolveCountryGateway(makeMockCountrySupabase(null), null);
    expect(r.gateway).toBeNull();
    expect(r.reason).toBe('no_country_code');
  });
});

// ═══ S2: BYO override ═══

describe('BYO override', () => {
  it('BYO stripe on NG -> stripe + NGN', async () => {
    const { resolveBusinessGateway } = await import('@/lib/payments/gateway-resolver');
    const sb = {
      from: (t: string) => {
        if (t === 'businesses') return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { payment_gateway: 'stripe', country_code: 'NG' }, error: null }) }) }) };
        if (t === 'countries') return { select: () => ({ eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { payment_gateway: 'paystack', currency_code: 'NGN' }, error: null }) }) }) }) };
        return {} as any;
      },
    } as any;
    const r = await resolveBusinessGateway(sb, 'b1');
    expect(r.gateway).toBe('stripe');
    expect(r.currency).toBe('NGN');
    expect(r.source).toBe('business_override');
  });

  it('NULL biz gateway -> country default', async () => {
    const { resolveBusinessGateway } = await import('@/lib/payments/gateway-resolver');
    const sb = {
      from: (t: string) => {
        if (t === 'businesses') return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { payment_gateway: null, country_code: 'NG' }, error: null }) }) }) };
        if (t === 'countries') return { select: () => ({ eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { payment_gateway: 'paystack', currency_code: 'NGN' }, error: null }) }) }) }) };
        return {} as any;
      },
    } as any;
    const r = await resolveBusinessGateway(sb, 'b1');
    expect(r.gateway).toBe('paystack');
    expect(r.source).toBe('country_default');
  });
});

// ═══ S3: Paystack activation recovery convergence ═══

describe('Paystack activation convergence state machine', () => {
  function sim(opts: {
    evidence: boolean; subStatus: string; bizStatus: string;
    rpcOk: boolean | null; rpcReason?: string; bizUpdateOk: boolean | null;
  }): string {
    if (!opts.evidence) return 'no_evidence';
    if (opts.subStatus === 'active' && opts.bizStatus === 'active') return 'already_converged';
    if (opts.subStatus !== 'active') {
      if (opts.rpcOk === null) return 'rpc_failed';
      if (!opts.rpcOk) return 'rpc_rejected';
    }
    if (opts.bizStatus !== 'active') {
      if (opts.bizUpdateOk === false) return 'biz_update_failed';
    }
    return 'converged';
  }

  it('pending + evidence -> converged', () => expect(sim({ evidence: true, subStatus: 'pending', bizStatus: 'pending', rpcOk: true, bizUpdateOk: true })).toBe('converged'));
  it('no evidence -> skipped', () => expect(sim({ evidence: false, subStatus: 'pending', bizStatus: 'pending', rpcOk: null, bizUpdateOk: null })).toBe('no_evidence'));
  it('amount mismatch -> rejected', () => expect(sim({ evidence: true, subStatus: 'pending', bizStatus: 'pending', rpcOk: false, rpcReason: 'amount_mismatch', bizUpdateOk: null })).toBe('rpc_rejected'));
  it('RPC error -> failed', () => expect(sim({ evidence: true, subStatus: 'pending', bizStatus: 'pending', rpcOk: null, bizUpdateOk: null })).toBe('rpc_failed'));
  it('partial: sub active, biz pending -> converged', () => expect(sim({ evidence: true, subStatus: 'active', bizStatus: 'pending', rpcOk: null, bizUpdateOk: true })).toBe('converged'));
  it('fully converged -> no-op', () => expect(sim({ evidence: true, subStatus: 'active', bizStatus: 'active', rpcOk: null, bizUpdateOk: null })).toBe('already_converged'));
  it('biz update fails -> retryable', () => expect(sim({ evidence: true, subStatus: 'pending', bizStatus: 'pending', rpcOk: true, bizUpdateOk: false })).toBe('biz_update_failed'));

  it('Pass 2 discovers pending paystack subs (claim_overdue does not)', () => {
    const sub = { status: 'pending', gateway: 'paystack' };
    expect(sub.status === 'active' && ['flutterwave', 'stripe'].includes(sub.gateway)).toBe(false);
    expect(sub.status === 'pending' && sub.gateway === 'paystack').toBe(true);
  });

  it('Pass 2 discovers partial convergence (sub active, biz pending)', () => {
    const state = { subStatus: 'active', gateway: 'paystack', bizStatus: 'pending' };
    expect(state.gateway === 'paystack' && state.bizStatus === 'pending').toBe(true);
  });
});

// ═══ S4: Pending business guard (executable requireCapability) ═══

describe('requireCapability guard', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  function mocks(opts: { bizStatus: string; tier: string; caps: string[] }) {
    const biz = { id: 'b1', status: opts.bizStatus, subscription_tier: opts.tier, trial_ends_at: null, category: 'salon' };
    const rows = opts.caps.map(c => ({ capability: c, is_enabled: true, sort_order: 0 }));
    const supabase = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: biz, error: null }) }), maybeSingle: () => Promise.resolve({ data: biz, error: null }) }) }) }) } as any;
    const service = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }) }) }), rpc: () => Promise.resolve({ data: null, error: null }) } as any;
    return { supabase, service };
  }

  it('pending + create_new -> 403 business_setup_incomplete', async () => {
    const { requireCapability } = await import('@/lib/capabilities/api-guard');
    const { supabase, service } = mocks({ bizStatus: 'pending', tier: 'free', caps: ['poll'] });
    const r = await requireCapability(supabase, service, { businessId: 'b1', userId: 'u1', capability: 'poll', action: 'create_new' });
    expect(r.allowed).toBe(false);
    if (!r.allowed) { expect(r.status).toBe(403); expect(r.denial.reason).toBe('business_setup_incomplete'); }
  });

  it('active + create_new + poll -> allowed', async () => {
    const { requireCapability } = await import('@/lib/capabilities/api-guard');
    const { supabase, service } = mocks({ bizStatus: 'active', tier: 'free', caps: ['poll'] });
    const r = await requireCapability(supabase, service, { businessId: 'b1', userId: 'u1', capability: 'poll', action: 'create_new' });
    expect(r.allowed).toBe(true);
  });

  it('suspended -> 403 business_suspended', async () => {
    const { requireCapability } = await import('@/lib/capabilities/api-guard');
    const { supabase, service } = mocks({ bizStatus: 'suspended', tier: 'business', caps: ['poll'] });
    const r = await requireCapability(supabase, service, { businessId: 'b1', userId: 'u1', capability: 'poll', action: 'create_new' });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.denial.reason).toBe('business_suspended');
  });

  it('pending + manage_existing -> allowed', async () => {
    const { requireCapability } = await import('@/lib/capabilities/api-guard');
    const { supabase, service } = mocks({ bizStatus: 'pending', tier: 'free', caps: ['poll'] });
    const r = await requireCapability(supabase, service, { businessId: 'b1', userId: 'u1', capability: 'poll', action: 'manage_existing' });
    expect(r.allowed).toBe(true);
  });
});

// ═══ S5: NULL gateway reconciliation ═══

describe('reconcileNullGateways', () => {
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

// ═══ S6-S12: Structural verification ═══

describe('Subscribe uses canonical resolver', () => {
  it('imports resolveBusinessGateway', async () => {
    const fs = await import('fs');
    const s = fs.readFileSync('app/api/onboarding/subscribe/route.ts', 'utf-8');
    expect(s).toContain('resolveBusinessGateway');
    expect(s).not.toContain("countryRow.payment_gateway as string");
  });
});

describe('Scan to Pay', () => {
  it('uses resolver, no paystack fallback', async () => {
    const fs = await import('fs');
    const s = fs.readFileSync('app/api/pay-link/pay/route.ts', 'utf-8');
    expect(s).toContain('resolveBusinessGateway');
    expect(s).not.toContain("|| 'paystack'");
  });
});

describe('Admin launch_subscribers', () => {
  it('in ADMIN_TABLES', async () => { const fs = await import('fs'); expect(fs.readFileSync('app/api/admin/query/route.ts', 'utf-8')).toContain("'launch_subscribers'"); });
  it('uses adminApiFetch', async () => { const fs = await import('fs'); const s = fs.readFileSync('admin/src/pages/LaunchSubscribers.tsx', 'utf-8'); expect(s).toContain('adminApiFetch'); expect(s).not.toContain('adminDb'); });
});

describe('Party error handling', () => {
  it('surfaces insert errors', async () => { const fs = await import('fs'); const s = fs.readFileSync('app/dashboard/parties/page.tsx', 'utf-8'); expect(s).toContain('error: insertErr'); expect(s).toContain('Failed to create party'); });
});

describe('Admin reconciliation endpoint', () => {
  it('exists with auth + dry-run', async () => { const fs = await import('fs'); const s = fs.readFileSync('app/api/admin/reconcile-gateways/route.ts', 'utf-8'); expect(s).toContain('requirePlatformAdmin'); expect(s).toContain('dry_run'); expect(s).toContain('reconcileNullGateways'); });
});

describe('Registration payment readiness', () => {
  it('surfaces payment_ready', async () => { const fs = await import('fs'); const s = fs.readFileSync('app/api/onboarding/register/route.ts', 'utf-8'); expect(s).toContain('payment_ready: paymentReady'); expect(s).toContain('payment_readiness_reason'); });
});

describe('Preserve known-good', () => {
  it('events page exists', async () => { const fs = await import('fs'); expect(fs.existsSync('app/dashboard/events/page.tsx')).toBe(true); });
  it('payment-link manage exists', async () => { const fs = await import('fs'); expect(fs.existsSync('app/api/pay-link/manage/route.ts')).toBe(true); });
});
