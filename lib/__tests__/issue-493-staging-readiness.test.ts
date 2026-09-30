/**
 * Issue #493: Staging launch-readiness — production-path handler evidence.
 * Every acceptance test invokes the actual production route/function.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Top-level mocks ──
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() } }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));

let mockAuthUser: { id: string } | null = { id: 'user-1' };
const mockAuthFrom = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => Promise.resolve({ data: { user: mockAuthUser } }) }, from: (...a: any[]) => mockAuthFrom(...a) }),
}));

const mockServiceFrom = vi.fn();
const mockServiceRpc = vi.fn().mockResolvedValue({ data: null, error: null });
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: (...a: any[]) => mockServiceFrom(...a), rpc: (...a: any[]) => mockServiceRpc(...a) }),
}));

const _adminRef: { admin: boolean } = { admin: false };
vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: () => Promise.resolve(_adminRef.admin ? { id: 'admin-1', role: 'admin' } : null) }));
vi.mock('@/lib/admin-cors', () => ({ adminCorsHeaders: () => ({}) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: vi.fn(() => Promise.resolve(null)), getRateLimitKey: () => 'test' }));
vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: vi.fn(() => null) }));
vi.mock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false), resolveTrialCredit: vi.fn().mockResolvedValue(false) }));

const mockResolveBusinessGateway = vi.fn().mockResolvedValue({ gateway: 'paystack', currency: 'NGN', source: 'country_default' });

function dc(data: unknown, error: unknown = null) {
  const s: any = {};
  for (const m of ['select','eq','neq','in','gt','lt','gte','lte','limit','order','insert','update','delete','is','or','not','filter','upsert','single','maybeSingle'])
    s[m] = vi.fn((...args: any[]) => (m === 'single' || m === 'maybeSingle') ? Promise.resolve({ data, error }) : s);
  s.then = (r: (v: any) => void) => r({ data, error, count: 0 });
  return s;
}
function makeReq(path: string, body?: Record<string, unknown>, method = 'POST'): NextRequest {
  return body
    ? new NextRequest(`http://localhost:3000${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    : new NextRequest(`http://localhost:3000${path}`, { method: method || 'GET' });
}

// ═══════════════════════════════════════════════════════════
// S1: Gateway resolver — production function
// ═══════════════════════════════════════════════════════════
describe('Gateway resolver', () => {
  beforeEach(() => { vi.resetModules(); });
  const cases = [['NG','paystack','NGN'],['GH','paystack','GHS'],['US','stripe','USD'],['GB','stripe','GBP'],['CA','stripe','CAD']] as const;
  for (const [c, gw, cur] of cases) {
    it(`${c} -> ${gw}/${cur}`, async () => {
      const { resolveCountryGateway } = await import('@/lib/payments/gateway-resolver');
      const sb = { from: (t: string) => { if (t==='countries') return { select:()=>({eq:()=>({eq:()=>({single:()=>Promise.resolve({data:{payment_gateway:gw,currency_code:cur},error:null})})})}) }; return {} as any; }} as any;
      const r = await resolveCountryGateway(sb, c); expect(r.gateway).toBe(gw); expect(r.currency).toBe(cur);
    });
  }
  it('BYO on NG -> still Paystack', async () => {
    const { resolveBusinessGateway } = await import('@/lib/payments/gateway-resolver');
    const sb = { from: (t: string) => { if (t==='businesses') return { select:()=>({eq:()=>({single:()=>Promise.resolve({data:{country_code:'NG'},error:null})})}) }; if (t==='countries') return { select:()=>({eq:()=>({eq:()=>({single:()=>Promise.resolve({data:{payment_gateway:'paystack',currency_code:'NGN'},error:null})})})}) }; return {} as any; }} as any;
    expect((await resolveBusinessGateway(sb, 'b1')).gateway).toBe('paystack');
  });
  it('unconfigured -> fail closed', async () => {
    const { resolveCountryGateway } = await import('@/lib/payments/gateway-resolver');
    expect((await resolveCountryGateway({ from:()=>({select:()=>({eq:()=>({eq:()=>({single:()=>Promise.resolve({data:null,error:{code:'PGRST116'}})})})})}) } as any, 'ZZ')).gateway).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// S2: Paystack recovery — production module
// ═══════════════════════════════════════════════════════════
describe('processPaystackActivationRecovery', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  function buildSvc(o: { evidence: {id:string}|null; subStatus:string; bizStatus:string; rpcResult:{activated:boolean;reason?:string}|null; rpcError:Error|null; bizUpdateOk:boolean }) {
    const rc: string[] = []; const bu: string[] = [];
    return { svc: { from: (t: string) => {
      if (t==='subscription_payments') return { select:()=>({eq:()=>({eq:()=>({eq:()=>({order:()=>({limit:()=>({single:()=>Promise.resolve({data:o.evidence,error:o.evidence?null:{code:'PGRST116'}})})})})})})}) };
      if (t==='subscriptions') return { select:()=>({eq:()=>({single:()=>Promise.resolve({data:{status:o.subStatus},error:null})})}) };
      if (t==='businesses') return { select:()=>({eq:()=>({single:()=>Promise.resolve({data:{status:o.bizStatus},error:null})})}), update:()=>({eq:()=>({eq:()=>{bu.push('u');return Promise.resolve({error:o.bizUpdateOk?null:new Error('x')})}})}) };
      return {} as any;
    }, rpc:(fn:string)=>{rc.push(fn);return Promise.resolve({data:o.rpcResult,error:o.rpcError})} } as any, rc, bu };
  }
  it('pending+evidence->converged', async () => { const {processPaystackActivationRecovery:f}=await import('@/lib/payments/paystack-activation-recovery'); const m=buildSvc({evidence:{id:'e1'},subStatus:'pending',bizStatus:'pending',rpcResult:{activated:true},rpcError:null,bizUpdateOk:true}); expect(await f(m.svc,'s','b')).toBe('converged'); expect(m.rc).toContain('activate_paid_subscription'); });
  it('active sub+pending biz->converged no RPC', async () => { const {processPaystackActivationRecovery:f}=await import('@/lib/payments/paystack-activation-recovery'); const m=buildSvc({evidence:{id:'e2'},subStatus:'active',bizStatus:'pending',rpcResult:null,rpcError:null,bizUpdateOk:true}); expect(await f(m.svc,'s','b')).toBe('converged'); expect(m.rc).not.toContain('activate_paid_subscription'); });
  it('no evidence->no_evidence', async () => { const {processPaystackActivationRecovery:f}=await import('@/lib/payments/paystack-activation-recovery'); expect(await f(buildSvc({evidence:null,subStatus:'pending',bizStatus:'pending',rpcResult:null,rpcError:null,bizUpdateOk:true}).svc,'s','b')).toBe('no_evidence'); });
  it('RPC rejected->rpc_rejected', async () => { const {processPaystackActivationRecovery:f}=await import('@/lib/payments/paystack-activation-recovery'); const m=buildSvc({evidence:{id:'e3'},subStatus:'pending',bizStatus:'pending',rpcResult:{activated:false,reason:'amount_mismatch'},rpcError:null,bizUpdateOk:true}); expect(await f(m.svc,'s','b')).toBe('rpc_rejected'); expect(m.bu).toHaveLength(0); });
  it('already converged->no mutation', async () => { const {processPaystackActivationRecovery:f}=await import('@/lib/payments/paystack-activation-recovery'); const m=buildSvc({evidence:{id:'e4'},subStatus:'active',bizStatus:'active',rpcResult:null,rpcError:null,bizUpdateOk:true}); expect(await f(m.svc,'s','b')).toBe('already_converged'); expect(m.rc).toHaveLength(0); });
  it('biz update fail->retryable', async () => { const {processPaystackActivationRecovery:f}=await import('@/lib/payments/paystack-activation-recovery'); expect(await f(buildSvc({evidence:{id:'e5'},subStatus:'pending',bizStatus:'pending',rpcResult:{activated:true},rpcError:null,bizUpdateOk:false}).svc,'s','b')).toBe('biz_update_failed'); });
});

// ═══════════════════════════════════════════════════════════
// S2b: Cron GET — actual route with spy assertions
// ═══════════════════════════════════════════════════════════
describe('GET /api/cron/subscription-renewal-recovery — actual route', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  it('discovers pending Paystack sub, invokes recovery, updates counters', async () => {
    mockServiceRpc.mockResolvedValue({ data: [], error: null }); // Pass 1 empty

    const recoverySpy = vi.fn().mockResolvedValue('converged');
    vi.doMock('@/lib/payments/paystack-activation-recovery', () => ({
      processPaystackActivationRecovery: recoverySpy,
    }));

    // Track subscription update calls for last_reconciliation_attempt_at
    const subUpdateCalls: string[] = [];
    let pass2QueryCount = 0;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        pass2QueryCount++;
        if (pass2QueryCount <= 2) {
          // Pass 2 queries: Case A returns one pending sub, Case B returns empty
          const chain = dc(null);
          chain.eq = vi.fn(() => chain);
          chain.or = vi.fn(() => chain);
          chain.limit = vi.fn(() => {
            if (pass2QueryCount === 1) return Promise.resolve({ data: [{ id: 'sub-1', business_id: 'biz-1', plan: 'business', gateway: 'paystack', status: 'pending' }], error: null });
            return Promise.resolve({ data: [], error: null });
          });
          return chain;
        }
        // last_reconciliation_attempt_at update
        return { update: () => ({ eq: () => { subUpdateCalls.push('claim'); return Promise.resolve({ error: null }); } }) };
      }
      return dc(null);
    });

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const res = await GET(makeReq('/api/cron/subscription-renewal-recovery', undefined, 'GET'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);

    // Recovery function was called with the discovered sub
    expect(recoverySpy).toHaveBeenCalledTimes(1);
    expect(recoverySpy.mock.calls[0][1]).toBe('sub-1'); // subId
    expect(recoverySpy.mock.calls[0][2]).toBe('biz-1'); // bizId

    // last_reconciliation_attempt_at was updated before recovery
    expect(subUpdateCalls).toContain('claim');

    // paystackRecovered reflects converged outcome
    expect(data.paystackRecovered).toBe(1);
  });

  it('converged+already_converged both count as recovered', async () => {
    mockServiceRpc.mockResolvedValue({ data: [], error: null });
    const recoverySpy = vi.fn()
      .mockResolvedValueOnce('converged')
      .mockResolvedValueOnce('already_converged');
    vi.doMock('@/lib/payments/paystack-activation-recovery', () => ({ processPaystackActivationRecovery: recoverySpy }));

    let pass2Q = 0;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        pass2Q++;
        if (pass2Q <= 2) {
          const c = dc(null); c.eq = vi.fn(() => c); c.or = vi.fn(() => c);
          c.limit = vi.fn(() => {
            if (pass2Q === 1) return Promise.resolve({ data: [
              { id: 'sub-a', business_id: 'biz-a', plan: 'business', gateway: 'paystack', status: 'pending' },
              { id: 'sub-b', business_id: 'biz-b', plan: 'business', gateway: 'paystack', status: 'pending' },
            ], error: null });
            return Promise.resolve({ data: [], error: null });
          });
          return c;
        }
        return { update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
      }
      return dc(null);
    });

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const data = await (await GET(makeReq('/c', undefined, 'GET'))).json();
    expect(recoverySpy).toHaveBeenCalledTimes(2);
    expect(data.paystackRecovered).toBe(2);
  });

  it('failed/retryable outcome does not become false success', async () => {
    mockServiceRpc.mockResolvedValue({ data: [], error: null });
    const recoverySpy = vi.fn().mockResolvedValue('rpc_rejected');
    vi.doMock('@/lib/payments/paystack-activation-recovery', () => ({ processPaystackActivationRecovery: recoverySpy }));

    let q = 0;
    mockServiceFrom.mockImplementation((t: string) => {
      if (t === 'subscriptions') { q++; if (q<=2) { const c=dc(null);c.eq=vi.fn(()=>c);c.or=vi.fn(()=>c);c.limit=vi.fn(()=>q===1?Promise.resolve({data:[{id:'sub-f',business_id:'biz-f',plan:'business',gateway:'paystack',status:'pending'}],error:null}):Promise.resolve({data:[],error:null}));return c; } return{update:()=>({eq:()=>Promise.resolve({error:null})})}; }
      return dc(null);
    });

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const data = await (await GET(makeReq('/c', undefined, 'GET'))).json();
    // rpc_rejected counts as skipped, not paystackRecovered
    expect(data.paystackRecovered).toBe(0);
    expect(data.skipped).toBeGreaterThanOrEqual(1);
  });

  it('one candidate throwing does not abort later candidates', async () => {
    mockServiceRpc.mockResolvedValue({ data: [], error: null });
    const recoverySpy = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('converged');
    vi.doMock('@/lib/payments/paystack-activation-recovery', () => ({ processPaystackActivationRecovery: recoverySpy }));

    let q = 0;
    mockServiceFrom.mockImplementation((t: string) => {
      if (t === 'subscriptions') { q++; if (q<=2) { const c=dc(null);c.eq=vi.fn(()=>c);c.or=vi.fn(()=>c);c.limit=vi.fn(()=>q===1?Promise.resolve({data:[{id:'sub-x',business_id:'biz-x',plan:'business',gateway:'paystack',status:'pending'},{id:'sub-y',business_id:'biz-y',plan:'business',gateway:'paystack',status:'pending'}],error:null}):Promise.resolve({data:[],error:null}));return c; } return{update:()=>({eq:()=>Promise.resolve({error:null})})}; }
      return dc(null);
    });

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const data = await (await GET(makeReq('/c', undefined, 'GET'))).json();
    expect(recoverySpy).toHaveBeenCalledTimes(2);
    expect(data.paystackRecovered).toBe(1); // second succeeded
  });
});

// ═══════════════════════════════════════════════════════════
// S3: Poll POST — actual route
// ═══════════════════════════════════════════════════════════
describe('POST /api/polls — actual route', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); mockAuthUser = { id: 'user-1' }; });
  it('pending -> 403', async () => {
    mockAuthFrom.mockReturnValue(dc({ id: 'biz-1' }));
    vi.doMock('@/lib/capabilities/api-guard', () => ({ requireCapability: vi.fn().mockResolvedValue({ allowed: false, status: 403, denial: { success: false, reason: 'business_setup_incomplete' } }) }));
    const { POST } = await import('@/app/api/polls/route');
    const res = await POST(makeReq('/api/polls', { business_id: 'biz-1', question: 'Q?', options: ['A', 'B'] }));
    expect(res.status).toBe(403); expect((await res.json()).reason).toBe('business_setup_incomplete');
  });
  it('active -> 201', async () => {
    mockAuthFrom.mockImplementation((t: string) => { if (t==='polls') return { insert:()=>({select:()=>({single:()=>Promise.resolve({data:{id:'p1',question:'Q?',options:['A','B'],status:'draft'},error:null})})}) }; return dc({id:'biz-1'}); });
    vi.doMock('@/lib/capabilities/api-guard', () => ({ requireCapability: vi.fn().mockResolvedValue({ allowed: true, business: { id:'biz-1',status:'active',subscription_tier:'free',trial_ends_at:null,category:'salon' }, resolution: {} }) }));
    const { POST } = await import('@/app/api/polls/route');
    expect((await POST(makeReq('/api/polls', { business_id: 'biz-1', question: 'Q?', options: ['A', 'B'] }))).status).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════
// S4: Giving save — actual route
// ═══════════════════════════════════════════════════════════
describe('POST /api/giving/save — actual route', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); mockAuthUser = { id: 'user-1' }; });
  it('rightful owner -> success', async () => {
    mockAuthFrom.mockImplementation((t: string) => { if (t==='businesses') return dc({id:'biz-1',owner_id:'user-1',recurring_enabled:false,subscription_tier:'free',trial_ends_at:null,capability_overrides:null}); if (t==='services'){const c=dc([],null);c.insert=()=>({select:()=>({single:()=>Promise.resolve({data:{id:'svc-1'},error:null})})});return c;} return dc(null); });
    const { POST } = await import('@/app/api/giving/save/route');
    expect((await POST(makeReq('/api/giving/save', { businessId:'biz-1',name:'Tithes',description:'',fixedAmount:false,price:0,isRecurring:false,interval:'monthly' }))).status).toBeLessThan(400);
  });
  it('cross-business -> 403', async () => {
    mockAuthFrom.mockImplementation(() => dc({id:'biz-other',owner_id:'user-other',recurring_enabled:false,subscription_tier:'free',trial_ends_at:null,capability_overrides:null}));
    const { POST } = await import('@/app/api/giving/save/route');
    const res = await POST(makeReq('/api/giving/save', { businessId:'biz-other',name:'X',description:'',fixedAmount:false,price:0,isRecurring:false,interval:'monthly' }));
    expect(res.status).toBe(403); expect((await res.json()).reason).toBe('unauthorized');
  });
});

// ═══════════════════════════════════════════════════════════
// S5: Party persistence — production function
// ═══════════════════════════════════════════════════════════
describe('createParty — production function', () => {
  it('successful insert -> success:true', async () => {
    const { createParty } = await import('@/lib/actions/party-persistence');
    const sb = { from: () => ({ insert: () => Promise.resolve({ error: null }) }) } as any;
    const r = await createParty(sb, { business_id: 'b1', name: 'Test', date: '2026-12-01' });
    expect(r.success).toBe(true);
  });
  it('DB error -> success:false + error message', async () => {
    const { createParty } = await import('@/lib/actions/party-persistence');
    const sb = { from: () => ({ insert: () => Promise.resolve({ error: { message: 'RLS violation' } }) }) } as any;
    const r = await createParty(sb, { business_id: 'b1', name: 'Bad', date: '2026-12-01' });
    expect(r.success).toBe(false); expect(r.error).toContain('RLS violation');
  });
  it('error path does not return success', async () => {
    const { createParty } = await import('@/lib/actions/party-persistence');
    const sb = { from: () => ({ insert: () => Promise.resolve({ error: { message: 'constraint' } }) }) } as any;
    const r = await createParty(sb, { business_id: 'b1', name: 'X', date: '2026-12-01' });
    expect(r.success).not.toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// S6: Event creation — production function
// ═══════════════════════════════════════════════════════════
describe('createEvent — production function', () => {
  it('authorized create -> success + eventId', async () => {
    const { createEvent } = await import('@/lib/actions/event-persistence');
    const sb = { from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'evt-1' }, error: null }) }) }) }) } as any;
    const r = await createEvent(sb, { business_id: 'b1', name: 'Launch', date: '2026-12-01' });
    expect(r.success).toBe(true); expect(r.eventId).toBe('evt-1');
  });
  it('DB failure -> surfaced error', async () => {
    const { createEvent } = await import('@/lib/actions/event-persistence');
    const sb = { from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'constraint violated' } }) }) }) }) } as any;
    const r = await createEvent(sb, { business_id: 'b1', name: 'Bad', date: '2026-12-01' });
    expect(r.success).toBe(false); expect(r.error).toContain('constraint violated');
  });
});

// ═══════════════════════════════════════════════════════════
// S7: Admin query — actual route
// ═══════════════════════════════════════════════════════════
describe('POST /api/admin/query — actual route', () => {
  it('admin -> 200', async () => { vi.resetModules(); _adminRef.admin=true; mockServiceFrom.mockReturnValue(dc([{id:'ls-1'}])); const{POST}=await import('@/app/api/admin/query/route'); expect((await POST(makeReq('/api/admin/query',{table:'launch_subscribers'}))).status).toBe(200); });
  it('non-admin -> 403', async () => { vi.resetModules(); _adminRef.admin=false; const{POST}=await import('@/app/api/admin/query/route'); expect((await POST(makeReq('/api/admin/query',{table:'launch_subscribers'}))).status).toBe(403); });
});

// ═══════════════════════════════════════════════════════════
// S8: Admin reconcile-gateways — actual route
// ═══════════════════════════════════════════════════════════
describe('POST /api/admin/reconcile-gateways — actual route', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules();
    vi.doMock('@/lib/payments/gateway-resolver', () => ({ resolveBusinessGateway: (...a: any[]) => mockResolveBusinessGateway(...a), resolveCountryGateway: vi.fn().mockResolvedValue({ gateway:'paystack',currency:'NGN',source:'country_default' }) }));
  });
  it('non-admin -> 403', async () => { _adminRef.admin=false; const{POST}=await import('@/app/api/admin/reconcile-gateways/route'); expect((await POST(makeReq('/r',{}))).status).toBe(403); });
  it('dry-run default -> no writes', async () => {
    _adminRef.admin=true; mockServiceFrom.mockReturnValue({select:()=>({is:()=>({order:()=>({limit:()=>Promise.resolve({data:[],error:null})})})})});
    const{POST}=await import('@/app/api/admin/reconcile-gateways/route'); const d=await(await POST(makeReq('/r',{}))).json(); expect(d.dry_run).toBe(true);
  });
  it('CAS no-op -> skipped[already_reconciled]', async () => {
    _adminRef.admin=true; mockResolveBusinessGateway.mockResolvedValue({gateway:'paystack',currency:'NGN',source:'country_default'});
    mockServiceFrom.mockImplementation((t:string)=>{ if(t==='businesses') return{select:()=>({eq:()=>({single:()=>Promise.resolve({data:{id:'biz-1',name:'T',payment_gateway:null,country_code:'NG'},error:null})})}),update:()=>({eq:()=>({is:()=>({select:()=>Promise.resolve({data:[],error:null})})})})}; return dc(null); });
    const{POST}=await import('@/app/api/admin/reconcile-gateways/route'); const d=await(await POST(makeReq('/r',{dry_run:false,business_id:'biz-1'}))).json();
    expect(d.skipped).toEqual([{id:'biz-1',reason:'already_reconciled'}]);
  });
});

// ═══════════════════════════════════════════════════════════
// S9: Scan-to-Pay — actual route with exact assertions
// ═══════════════════════════════════════════════════════════
describe('POST /api/pay-link/pay — actual route', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules();
    vi.doMock('@/lib/payments/gateway-resolver', () => ({ resolveBusinessGateway: (...a: any[]) => mockResolveBusinessGateway(...a) }));
  });

  function mockLink(bizStatus: string, country: string) {
    const paymentInserts: Record<string,unknown>[] = [];
    const factoryCalls: string[] = [];
    mockServiceFrom.mockImplementation((t: string) => {
      if (t==='payment_links') return{select:()=>({eq:()=>({eq:()=>({single:()=>Promise.resolve({data:{id:'pl-1',title:'T',amount:5000,currency:null,uses_count:0,expires_at:null,max_uses:null,business_id:'biz-1',is_active:true,businesses:{name:'B',country_code:country,payment_gateway:null,status:bizStatus}},error:null})})})})};
      if (t==='payments') return{insert:(data:Record<string,unknown>)=>{paymentInserts.push(data);return{select:()=>({single:()=>Promise.resolve({data:{id:'pay-1',gateway_reference:'ref-1'},error:null})})}}};
      return dc(null);
    });
    return { paymentInserts, factoryCalls };
  }

  it('pending -> 503, zero payment inserts, zero factory calls', async () => {
    const ctx = mockLink('pending', 'NG');
    const mockFactory = vi.fn();
    vi.doMock('@/lib/payments/factory', () => ({ getPaymentGateway:vi.fn(), getPaymentGatewayByName:mockFactory }));
    const{POST}=await import('@/app/api/pay-link/pay/route');
    const res = await POST(makeReq('/p',{token:'t',amount:5000,customer_name:'N',customer_phone:'+234'}));
    expect(res.status).toBe(503);
    expect(ctx.paymentInserts).toHaveLength(0);
    expect(mockFactory).not.toHaveBeenCalled();
  });

  it('active NG -> Paystack/NGN payment row + provider URL', async () => {
    const ctx = mockLink('active', 'NG');
    mockResolveBusinessGateway.mockResolvedValue({gateway:'paystack',currency:'NGN',source:'country_default'});
    const mockInit = vi.fn().mockResolvedValue({url:'https://paystack.com/pay',reference:'PS-REF'});
    vi.doMock('@/lib/payments/factory', () => ({ getPaymentGateway:vi.fn(), getPaymentGatewayByName:vi.fn(()=>({name:'paystack',initializePayment:mockInit})) }));
    const{POST}=await import('@/app/api/pay-link/pay/route');
    const res = await POST(makeReq('/p',{token:'t',amount:5000,customer_name:'N',customer_phone:'+234'}));
    expect(res.status).toBeLessThan(400);
    // Payment row used correct gateway+currency
    expect(ctx.paymentInserts.length).toBeGreaterThanOrEqual(1);
    expect(ctx.paymentInserts[0].gateway).toBe('paystack');
    expect(ctx.paymentInserts[0].currency).toBe('NGN');
    // Factory received Paystack
    const{getPaymentGatewayByName}=await import('@/lib/payments/factory');
    expect(getPaymentGatewayByName).toHaveBeenCalledWith('paystack');
    // Response contains URL
    const data = await res.json();
    expect(data.url || data.authorization_url).toBeDefined();
  });

  it('active US -> Stripe/USD payment row + provider URL', async () => {
    const ctx = mockLink('active', 'US');
    mockResolveBusinessGateway.mockResolvedValue({gateway:'stripe',currency:'USD',source:'country_default'});
    const mockInit = vi.fn().mockResolvedValue({url:'https://stripe.com/pay',reference:'ST-REF'});
    vi.doMock('@/lib/payments/factory', () => ({ getPaymentGateway:vi.fn(), getPaymentGatewayByName:vi.fn(()=>({name:'stripe',initializePayment:mockInit})) }));
    const{POST}=await import('@/app/api/pay-link/pay/route');
    const res = await POST(makeReq('/p',{token:'t',amount:5000,customer_name:'N',customer_phone:'+1555'}));
    expect(res.status).toBeLessThan(400);
    expect(ctx.paymentInserts[0].gateway).toBe('stripe');
    expect(ctx.paymentInserts[0].currency).toBe('USD');
    const{getPaymentGatewayByName}=await import('@/lib/payments/factory');
    expect(getPaymentGatewayByName).toHaveBeenCalledWith('stripe');
  });

  it('missing gateway -> 503', async () => {
    mockLink('active', 'ZZ');
    mockResolveBusinessGateway.mockResolvedValue({gateway:null,currency:null,source:null,reason:'country_not_found'});
    const{POST}=await import('@/app/api/pay-link/pay/route');
    expect((await POST(makeReq('/p',{token:'t',amount:5000,customer_name:'N',customer_phone:'+1'}))).status).toBe(503);
  });

  it('provider failure -> non-success, no fallback', async () => {
    mockLink('active', 'NG');
    mockResolveBusinessGateway.mockResolvedValue({gateway:'paystack',currency:'NGN',source:'country_default'});
    vi.doMock('@/lib/payments/factory', () => ({ getPaymentGateway:vi.fn(), getPaymentGatewayByName:vi.fn(()=>({name:'paystack',initializePayment:vi.fn().mockRejectedValue(new Error('timeout'))})) }));
    const{POST}=await import('@/app/api/pay-link/pay/route');
    const res = await POST(makeReq('/p',{token:'t',amount:5000,customer_name:'N',customer_phone:'+234'}));
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Only paystack was attempted — no fallback to stripe
    const{getPaymentGatewayByName}=await import('@/lib/payments/factory');
    expect(getPaymentGatewayByName).toHaveBeenCalledTimes(1);
    expect(getPaymentGatewayByName).toHaveBeenCalledWith('paystack');
  });
});

// ═══════════════════════════════════════════════════════════
// S10: Payment-link creation — actual route
// ═══════════════════════════════════════════════════════════
describe('POST /api/pay-link/manage — actual route', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });
  it('active business creates link', async () => {
    vi.doMock('@/lib/api-auth', () => ({ authenticateRequest: vi.fn().mockResolvedValue({ user:{id:'user-1'},businessId:'biz-1',service:{from:(t:string)=>{if(t==='payment_links') return{insert:()=>({select:()=>({single:()=>Promise.resolve({data:{id:'pl-1',token:'tk',title:'Link'},error:null})})})}; return dc(null)}} }) }));
    const{POST}=await import('@/app/api/pay-link/manage/route');
    expect((await POST(makeReq('/m',{businessId:'biz-1',title:'Test',amount:5000}))).status).toBeLessThan(400);
  });
});
