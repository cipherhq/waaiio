/**
 * Admin passkey step-up policy (Owner decision 2026-11-12).
 *
 * Runs the REAL route handlers, the REAL lib/admin-step-up.ts and the REAL
 * lib/admin-passkey.ts against an in-memory step-up table and approvals table.
 * Auth (requirePlatformAdmin) supplies a fixture admin whose amr/factors are
 * what the verified token would carry; audit, CORS, email and the TOTP
 * transport are stubbed.
 *
 * Negative proofs: every money-out route still demands a consumable step-up
 * from a trusted, fresh passkey session. Positive proofs: the five financial
 * actions that move no money skip step-up only for that session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Row = Record<string, unknown>;
type Res = { data: unknown; error: unknown };

const { state } = vi.hoisted(() => {
  // Read at module load by the approve route.
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_x';
  return {
  state: {
    admin: null as Record<string, unknown> | null,
    stepUps: [] as Row[],
    approvals: [] as Row[],
    approvalsReadError: false,
    /** auth.sessions row for the admin's session (admin_session_mfa_state). */
    session: null as Record<string, unknown> | null,
    sessionReadError: false,
    fixtures: {} as Record<string, { single?: unknown; list?: unknown[] }>,
    log: [] as Array<{ table: string; op: string }>,
    rpcCalls: [] as string[],
    audits: [] as Array<Record<string, unknown>>,
    deletedFactors: [] as string[],
    refunds: 0,
    seq: 0,
  },
  };
});

const MONEY_TABLES = ['business_payouts', 'reseller_payouts', 'platform_settings', 'payments', 'refunds', 'payment_provider_config'];

function makeChain(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  let patch: Row = {};
  let toInsert: Row[] = [];
  const chain: Record<string, unknown> = {};
  const filter = (fn: (r: Row) => boolean) => { preds.push(fn); return chain; };
  chain.eq = (c: string, v: unknown) => filter(r => r[c] === v);
  chain.is = (c: string, v: unknown) => filter(r => (r[c] ?? null) === v);
  chain.in = (c: string, v: unknown[]) => filter(r => v.includes(r[c]));
  chain.gt = (c: string, v: string) => filter(r => String(r[c]) > v);
  chain.not = (c: string, _o: string, v: unknown) => filter(r => (r[c] ?? null) !== v);
  for (const m of ['neq', 'order', 'limit', 'gte', 'lte', 'lt', 'or', 'range', 'filter', 'match', 'contains']) chain[m] = () => chain;
  chain.select = () => chain;
  chain.insert = (rows: Row | Row[]) => { op = 'insert'; toInsert = Array.isArray(rows) ? rows : [rows]; return chain; };
  chain.update = (p: Row) => { op = 'update'; patch = p; return chain; };
  chain.upsert = (rows: Row) => { op = 'upsert'; toInsert = [rows]; return chain; };
  chain.delete = () => { op = 'delete'; return chain; };

  const memory = table === 'admin_step_up_authorizations' ? state.stepUps
    : table === 'admin_passkey_approvals' ? state.approvals : null;

  function run(): Res {
    state.log.push({ table, op });
    if (!memory) {
      const f = state.fixtures[table] ?? {};
      return { data: f.list ?? [], error: null };
    }
    if (table === 'admin_passkey_approvals' && op === 'select' && state.approvalsReadError) {
      return { data: null, error: { message: 'read failed' } };
    }
    const match = memory.filter(r => preds.every(p => p(r)));
    if (op === 'insert') {
      for (const r of toInsert) {
        if (table === 'admin_passkey_approvals' && memory.some(x => x.factor_id === r.factor_id)) {
          return { data: null, error: { code: '23505' } };
        }
      }
      const rows = toInsert.map(r => ({ id: `su-${++state.seq}`, created_at: new Date().toISOString(), verified_at: null, consumed_at: null, ...r }));
      memory.push(...rows);
      return { data: rows, error: null };
    }
    if (op === 'update') {
      if (patch.challenge_id && memory.some(r => !match.includes(r) && r.challenge_id === patch.challenge_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      match.forEach(r => Object.assign(r, patch));
      return { data: match.map(r => ({ id: r.id })), error: null };
    }
    if (op === 'delete') {
      for (const r of match) memory.splice(memory.indexOf(r), 1);
      return { data: null, error: null };
    }
    return { data: match, error: null };
  }

  chain.single = async () => {
    if (!memory) {
      state.log.push({ table, op });
      const f = state.fixtures[table];
      return f?.single ? { data: f.single, error: null } : { data: null, error: { message: 'not found' } };
    }
    const r = run();
    const arr = (r.data as Row[] | null) ?? [];
    return arr[0] ? { data: arr[0], error: null } : { data: null, error: r.error ?? { message: 'not found' } };
  };
  chain.maybeSingle = async () => {
    if (!memory) {
      state.log.push({ table, op });
      return { data: state.fixtures[table]?.single ?? null, error: null };
    }
    const r = run();
    if (r.error) return { data: null, error: r.error };
    return { data: ((r.data as Row[]) ?? [])[0] ?? null, error: null };
  };
  chain.then = (ok: (v: Res) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad);
  return chain;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (t: string) => makeChain(t),
    rpc: (name: string) => {
      if (name === 'admin_session_mfa_state') {
        const res = Promise.resolve(state.sessionReadError
          ? { data: null, error: { message: 'read failed' } }
          : { data: state.session, error: null });
        return Object.assign(res, { maybeSingle: () => res, single: () => res });
      }
      state.rpcCalls.push(name);
      const res = Promise.resolve({ data: null, error: { message: 'rpc not stubbed' } });
      return Object.assign(res, { maybeSingle: () => res, single: () => res });
    },
    auth: { admin: { mfa: { deleteFactor: async ({ id }: { id: string }) => { state.deletedFactors.push(id); return { error: null }; } } } },
  }),
}));
vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: vi.fn(async () => state.admin) }));
vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn(async (e: Record<string, unknown>) => { state.audits.push(e); return { error: null }; }) }));
vi.mock('@/lib/admin-cors', () => ({ adminCorsHeaders: () => ({}) }));
vi.mock('@/lib/admin-mfa-transport', () => ({ verifyTotpOnSingleConnection: vi.fn(async () => { throw new Error('no TOTP in this test'); }) }));
vi.mock('@/lib/payouts/verification-limit', () => ({
  checkVerificationLimit: vi.fn(async () => ({ allowed: true, limit: 1e12, used: 0, remaining: 1e12 })),
}));
vi.mock('@/lib/payouts/accounting-hold', () => ({ getMerchantAccountingHold: vi.fn(async () => null) }));
vi.mock('@/lib/payments/refund-handler', () => ({ processRefund: vi.fn(async () => { state.refunds++; return { success: true }; }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
// The payout batch job's first step after the gate; stop there.
vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn(async () => { throw new Error('stop after step-up gate'); }) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn(async () => undefined) }));

import { passkeyChallengeId, PASSKEY_WAIVABLE_ACTIONS } from '@/lib/admin-passkey';
import { hashOperationParams, verifyPasskeyStepUp, verifyStepUp, StepUpError } from '@/lib/admin-step-up';
import * as approveRoute from '@/app/api/admin/payouts/[id]/approve/route';
import * as confirmRoute from '@/app/api/admin/payouts/[id]/confirm-settlement/route';
import * as forceRoute from '@/app/api/admin/payouts/[id]/force-settle/route';
import * as rejectRoute from '@/app/api/admin/payouts/[id]/reject/route';
import * as generateRoute from '@/app/api/admin/payouts/generate/route';
import * as refundRoute from '@/app/api/admin/payments/refund/route';
import * as resellerIdRoute from '@/app/api/admin/reseller-payouts/[id]/route';
import * as resellerRoute from '@/app/api/admin/reseller-payouts/route';
import * as feeBankRoute from '@/app/api/admin/platform-settings/fee-bank/route';
import * as commercialRoute from '@/app/api/admin/platform-settings/commercial/route';
import * as providerRoute from '@/app/api/admin/provider-config/route';
import * as prepareRoute from '@/app/api/admin/step-up/prepare/route';
import * as verifyRoute from '@/app/api/admin/step-up/verify/route';
import * as passkeysRoute from '@/app/api/admin/passkeys/route';

const nowSec = () => Math.floor(Date.now() / 1000);
const FACTORS = [
  { id: 'totp-1', factor_type: 'totp', status: 'verified' },
  { id: 'pk-1', factor_type: 'webauthn', status: 'verified' },
];

function passkeyAdmin(over: Record<string, unknown> = {}) {
  return {
    id: 'admin-1', userId: 'admin-1', email: 'a@test.test', role: 'admin', aal: 'aal2', bearerToken: 't', sessionId: 'sess-1',
    amr: [{ method: 'password', timestamp: nowSec() - 120 }, { method: 'mfa/webauthn', timestamp: nowSec() - 60 }],
    factors: FACTORS,
    ...over,
  };
}
function totpAdmin() {
  return passkeyAdmin({ amr: [{ method: 'password', timestamp: nowSec() - 120 }, { method: 'mfa/totp', timestamp: nowSec() - 60 }] });
}

function req(body: unknown, url = 'http://localhost/api/admin/x') {
  return new NextRequest(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const stepUpUpdates = () => state.log.filter(l => l.table === 'admin_step_up_authorizations' && l.op === 'update').length;
const moneyWrites = () => state.log.filter(l => MONEY_TABLES.includes(l.table) && l.op !== 'select');
const waivedAudits = () => state.audits.filter(a => a.action === 'step_up_waived_passkey');

const FEE_BANK = { bank_code: '058', account_number: '0123456789', account_name: 'Waaiio Ltd' };
const APPROVED_PAYOUT = { id: 'p1', business_id: 'b1', status: 'approved', transfer_method: 'manual_bank', net_amount: 100, currency: 'NGN', payout_account_id: 'pa1', flags: [] };
const PENDING_PAYOUT = { ...APPROVED_PAYOUT, status: 'pending', transfer_method: null };

/** Each money-out route, called by a trusted passkey session with no step-up. */
const MONEY_OUT_CALLS: Array<{ name: string; action: string; call: (stepUpId?: string) => Promise<Response>; fixtures?: () => void }> = [
  {
    name: 'payout approve (automatic Paystack transfer)', action: 'payout_approve',
    fixtures: () => {
      state.fixtures.business_payouts = { single: PENDING_PAYOUT, list: [] };
      state.fixtures.payout_accounts = { single: { id: 'pa1', business_id: 'b1', is_active: true, verified_at: '2024-01-01', gateway: 'paystack', bank_code: '058', account_number: '0123456789', account_name: 'Biz' } };
      state.fixtures.platform_fees = { list: [{ transaction_amount: 1000, fee_total: 50, gateway_fee: 10, waived: false, is_direct_transfer: false, payments: { currency: 'NGN' } }] };
    },
    call: id => approveRoute.POST(req({ transfer_method: 'paystack_transfer', stepUpId: id }), ctx('p1')),
  },
  {
    name: 'payout approve (manual bank)', action: 'payout_approve',
    fixtures: () => {
      state.fixtures.business_payouts = { single: PENDING_PAYOUT, list: [] };
      state.fixtures.payout_accounts = { single: { id: 'pa1', business_id: 'b1', is_active: true, verified_at: '2024-01-01', gateway: 'paystack' } };
      state.fixtures.platform_fees = { list: [{ transaction_amount: 1000, fee_total: 50, gateway_fee: 10, waived: false, is_direct_transfer: false, payments: { currency: 'NGN' } }] };
    },
    call: id => approveRoute.POST(req({ transfer_method: 'manual_bank', reference: 'REF', stepUpId: id }), ctx('p1')),
  },
  {
    name: 'confirm settlement paid', action: 'payout_confirm_settlement',
    fixtures: () => { state.fixtures.business_payouts = { single: APPROVED_PAYOUT }; },
    call: id => confirmRoute.POST(req({ transfer_reference: 'BANK-REF-1', attestation: true, stepUpId: id }), ctx('p1')),
  },
  {
    name: 'force-settle', action: 'payout_force_settle',
    fixtures: () => { state.fixtures.business_payouts = { single: APPROVED_PAYOUT }; },
    call: id => forceRoute.POST(req({ transfer_reference: 'BANK-REF-1', reason: 'bank confirmed', attestation: true, stepUpId: id }), ctx('p1')),
  },
  {
    name: 'refund', action: 'refund',
    call: id => refundRoute.POST(req({ paymentId: 'pay-1', businessId: 'b1', amount: 500, reason: 'x', stepUpId: id })),
  },
  {
    name: 'reseller payout mark paid', action: 'reseller_payout_mark_paid',
    call: id => resellerIdRoute.PATCH(req({ action: 'mark_paid', stepUpId: id }), ctx('rp-1')),
  },
  {
    name: 'platform fee bank account', action: 'provider_config',
    call: id => feeBankRoute.PUT(req({ ...FEE_BANK, stepUpId: id })),
  },
  {
    name: 'payment provider config', action: 'provider_config',
    call: id => providerRoute.POST(req({ action: 'switch_provider', country_code: 'NG', new_gateway: 'stripe', stepUpId: id })),
  },
  {
    name: 'commercial fee settings', action: 'commercial_config',
    call: id => commercialRoute.POST(req({ key: 'pricing_tiers', value: { starter: 1 }, stepUpId: id })),
  },
];

beforeEach(() => {
  state.admin = passkeyAdmin();
  state.stepUps = [];
  state.approvals = [{ factor_id: 'pk-1', admin_user_id: 'admin-1', step_up_id: 'su-0', approved_at: new Date(Date.now() - 86_400_000).toISOString() }];
  state.approvalsReadError = false;
  // Signed in two minutes ago; latest MFA verification was approved passkey pk-1.
  state.session = { session_aal: 'aal2', session_factor_id: 'pk-1', session_created_at: new Date(Date.now() - 120_000).toISOString() };
  state.sessionReadError = false;
  state.fixtures = { businesses: { single: { verification_level: 'verified', country_code: 'NG', name: 'Biz', owner_id: 'u1' } } };
  state.log = [];
  state.rpcCalls = [];
  state.audits = [];
  state.deletedFactors = [];
  state.refunds = 0;
  process.env.ENABLE_PAYOUTS = 'true';
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_x';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://auth.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
});

describe('money moving out still needs step-up for a trusted, fresh passkey session', () => {
  it('the waivable set holds no money-out or money-routing action', () => {
    for (const a of ['payout_approve', 'payout_confirm_settlement', 'payout_force_settle', 'refund', 'reseller_payout_mark_paid', 'provider_config', 'commercial_config', 'team_grant', 'impersonate']) {
      expect(PASSKEY_WAIVABLE_ACTIONS.has(a as never)).toBe(false);
    }
  });

  for (const c of MONEY_OUT_CALLS) {
    it(`${c.name}: no stepUpId → 403 step_up_required, nothing moves`, async () => {
      c.fixtures?.();
      const res = await c.call(undefined);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('step_up_required');
      expect(waivedAudits()).toHaveLength(0);
      expect(moneyWrites()).toEqual([]);
      expect(state.rpcCalls).toEqual([]);
      expect(state.refunds).toBe(0);
    });

    it(`${c.name}: unverified passkey grant → 403, nothing moves`, async () => {
      c.fixtures?.();
      state.stepUps.push({ id: 'su-x', admin_user_id: 'admin-1', session_id: 'sess-1', action_type: c.action, target_id: null, params_hash: 'h', factor_id: null, challenge_id: null, verified_at: null, consumed_at: null, expires_at: '2999-01-01T00:00:00Z', created_at: new Date().toISOString() });
      const res = await c.call('su-x');
      expect(res.status).toBe(403);
      expect(moneyWrites()).toEqual([]);
      expect(state.rpcCalls).toEqual([]);
      expect(state.refunds).toBe(0);
    });
  }
});

describe('financial actions that move no money skip step-up only for a trusted, fresh passkey session', () => {
  const WAIVABLE_CALLS: Array<{ name: string; call: () => Promise<Response>; fixtures?: () => void }> = [
    { name: 'generate payout batch', call: () => generateRoute.POST(req({})) },
    {
      name: 'reject payout', fixtures: () => { state.fixtures.business_payouts = { single: PENDING_PAYOUT }; },
      call: () => rejectRoute.POST(req({ reason: 'duplicate' }), ctx('p1')),
    },
    { name: 'approve reseller payout', call: () => resellerIdRoute.PATCH(req({ action: 'approve' }), ctx('rp-1')) },
    { name: 'reject reseller payout', call: () => resellerIdRoute.PATCH(req({ action: 'reject' }), ctx('rp-1')) },
    { name: 'generate reseller payout', call: () => resellerRoute.POST(req({ reseller_id: 'r1', period_start: '2026-11-01', period_end: '2026-11-07' })) },
  ];

  async function expectStepUpDemanded(call: () => Promise<Response>) {
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('step_up_required');
    expect(waivedAudits()).toHaveLength(0);
  }

  for (const c of WAIVABLE_CALLS) {
    it(`${c.name}: passkey session → no step-up, waiver audited`, async () => {
      c.fixtures?.();
      const res = await c.call();
      const body = await res.json().catch(() => ({}));
      expect(body.code).not.toBe('step_up_required');
      expect(stepUpUpdates()).toBe(0);
      expect(waivedAudits()).toHaveLength(1);
    });

    it(`${c.name}: authenticator-code session → step-up still required`, async () => {
      c.fixtures?.();
      state.admin = totpAdmin();
      await expectStepUpDemanded(c.call);
    });

    it(`${c.name}: signed in more than 12 hours ago (even with a fresh tap) → step-up required`, async () => {
      c.fixtures?.();
      state.session = { ...state.session, session_created_at: new Date(Date.now() - (12 * 3600 + 5) * 1000).toISOString() };
      state.admin = passkeyAdmin({ amr: [{ method: 'mfa/webauthn', timestamp: nowSec() - 1 }] });
      await expectStepUpDemanded(c.call);
    });

    it(`${c.name}: session's latest verification was not an approved passkey → step-up required`, async () => {
      c.fixtures?.();
      state.session = { ...state.session, session_factor_id: 'pk-unapproved-removed' };
      await expectStepUpDemanded(c.call);
    });

    it(`${c.name}: an unapproved passkey on the account → step-up required`, async () => {
      c.fixtures?.();
      state.admin = passkeyAdmin({ factors: [...FACTORS, { id: 'pk-2', factor_type: 'webauthn', status: 'verified' }] });
      await expectStepUpDemanded(c.call);
    });
  }

  it('fails closed when approvals cannot be read', async () => {
    state.approvalsReadError = true;
    await expectStepUpDemanded(() => generateRoute.POST(req({})));
  });

  it('fails closed when the session record cannot be read', async () => {
    state.sessionReadError = true;
    await expectStepUpDemanded(() => generateRoute.POST(req({})));
  });

  it('a downgraded (aal1) session record earns nothing', async () => {
    state.session = { ...state.session, session_aal: 'aal1' };
    await expectStepUpDemanded(() => generateRoute.POST(req({})));
  });

  it('a session whose latest verification was the authenticator code earns nothing', async () => {
    state.session = { ...state.session, session_factor_id: 'totp-1' };
    await expectStepUpDemanded(() => generateRoute.POST(req({})));
  });

  it('a passkey tap from before the passkey was approved (registration) earns nothing', async () => {
    state.approvals[0].approved_at = new Date().toISOString();
    state.admin = passkeyAdmin({ amr: [{ method: 'mfa/webauthn', timestamp: nowSec() - 30 }] });
    await expectStepUpDemanded(() => generateRoute.POST(req({})));
  });

  it('a webauthn amr with no passkey factor on the account earns nothing', async () => {
    state.admin = passkeyAdmin({ factors: [FACTORS[0]] });
    await expectStepUpDemanded(() => generateRoute.POST(req({})));
  });
});

describe('prepare tells the UI what to ask for', () => {
  async function prepare(actionType: string, targetId: string | null, params: Record<string, unknown>) {
    const res = await prepareRoute.POST(req({ actionType, targetId, params }));
    return { status: res.status, body: await res.json() };
  }

  it('waivable action in a passkey session → notRequired, no grant', async () => {
    const r = await prepare('payout_generate', null, { action: 'generate' });
    expect(r.body).toMatchObject({ notRequired: true, method: 'passkey' });
    expect(state.stepUps).toHaveLength(0);
  });

  it('money-out action in a passkey session → passkey grant (factor_id NULL)', async () => {
    const r = await prepare('refund', 'pay-1', { businessId: 'b1', amount: 500, reason: null });
    expect(r.body.method).toBe('passkey');
    expect(r.body.notRequired).toBeUndefined();
    expect(state.stepUps).toHaveLength(1);
    expect(state.stepUps[0]).toMatchObject({ action_type: 'refund', factor_id: null, verified_at: null });
  });

  it('passkey approval always uses the authenticator code', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ factors: FACTORS })));
    const r = await prepare('passkey_approve', 'pk-2', { factor_id: 'pk-2' });
    expect(r.body.method).toBe('totp');
    expect(state.stepUps[0]).toMatchObject({ action_type: 'passkey_approve', factor_id: 'totp-1' });
    fetchSpy.mockRestore();
  });
});

describe('passkey step-up verification', () => {
  function grant(over: Row = {}) {
    const row = { id: `su-${++state.seq}`, admin_user_id: 'admin-1', session_id: 'sess-1', action_type: 'refund', target_id: 'pay-1', params_hash: 'h', factor_id: null, challenge_id: null, verified_at: null, consumed_at: null, expires_at: '2999-01-01T00:00:00Z', created_at: new Date((nowSec() - 10) * 1000).toISOString(), ...over };
    state.stepUps.push(row);
    return row;
  }
  const tapNow = () => { state.admin = passkeyAdmin({ amr: [{ method: 'mfa/webauthn', timestamp: nowSec() }] }); };

  it('a tap after the grant verifies it, bound to that tap', async () => {
    const g = grant();
    tapNow();
    await verifyPasskeyStepUp(state.admin as never, g.id);
    expect(g.verified_at).not.toBeNull();
    expect(g.challenge_id).toBe(passkeyChallengeId('sess-1', nowSec()));
  });

  it('the sign-in tap (before the grant) does not verify it', async () => {
    const g = grant();
    state.admin = passkeyAdmin({ amr: [{ method: 'mfa/webauthn', timestamp: nowSec() - 11 }] });
    await expect(verifyPasskeyStepUp(state.admin as never, g.id)).rejects.toThrow(/Tap your passkey/);
    expect(g.verified_at).toBeNull();
  });

  it('one tap cannot verify two grants', async () => {
    const a = grant();
    const b = grant();
    tapNow();
    await verifyPasskeyStepUp(state.admin as never, a.id);
    await expect(verifyPasskeyStepUp(state.admin as never, b.id)).rejects.toThrow(/already used/);
    expect(b.verified_at).toBeNull();
  });

  it('an authenticator-code grant cannot be verified by passkey, and vice versa', async () => {
    const totpGrant = grant({ factor_id: 'totp-1' });
    tapNow();
    await expect(verifyPasskeyStepUp(state.admin as never, totpGrant.id)).rejects.toThrow(/authenticator code/);
    const passkeyGrant = grant();
    await expect(verifyStepUp(state.admin as never, passkeyGrant.id, '123456')).rejects.toBeInstanceOf(StepUpError);
    expect(passkeyGrant.verified_at).toBeNull();
  });

  it('passkey approval/removal grants never accept a passkey tap', async () => {
    const g = grant({ action_type: 'passkey_approve' });
    tapNow();
    await expect(verifyPasskeyStepUp(state.admin as never, g.id)).rejects.toThrow(/authenticator code/);
  });

  it('an unapproved passkey cannot verify', async () => {
    const g = grant();
    state.approvals = [];
    tapNow();
    await expect(verifyPasskeyStepUp(state.admin as never, g.id)).rejects.toThrow(/Tap your passkey/);
  });

  it('a fresh tap by a since-removed, unapproved passkey cannot verify (session factor is not approved)', async () => {
    const g = grant();
    tapNow();
    state.session = { ...state.session, session_factor_id: 'pk-attacker' };
    await expect(verifyPasskeyStepUp(state.admin as never, g.id)).rejects.toThrow(/Tap your passkey/);
    expect(g.verified_at).toBeNull();
  });

  it('a downgraded session cannot verify', async () => {
    const g = grant();
    tapNow();
    state.session = { ...state.session, session_aal: 'aal1' };
    await expect(verifyPasskeyStepUp(state.admin as never, g.id)).rejects.toThrow(/Tap your passkey/);
  });

  it('a session that signed in more than 12 hours ago can still confirm money-out with a fresh tap', async () => {
    const g = grant();
    tapNow();
    state.session = { ...state.session, session_created_at: new Date(Date.now() - 20 * 3600 * 1000).toISOString() };
    await verifyPasskeyStepUp(state.admin as never, g.id);
    expect(g.verified_at).not.toBeNull();
  });

  it('another session cannot verify the grant', async () => {
    const g = grant();
    state.admin = passkeyAdmin({ sessionId: 'sess-2', amr: [{ method: 'mfa/webauthn', timestamp: nowSec() }] });
    await expect(verifyPasskeyStepUp(state.admin as never, g.id)).rejects.toThrow(/different session/);
  });

  it('full chain: prepare → tap → verify route → refund runs once; replay is refused', async () => {
    const params = { businessId: 'b1', amount: 500, reason: 'x' };
    const prep = await (await prepareRoute.POST(req({ actionType: 'refund', targetId: 'pay-1', params }))).json();
    state.stepUps[0].created_at = new Date((nowSec() - 5) * 1000).toISOString();
    tapNow();
    const v = await verifyRoute.POST(req({ stepUpId: prep.stepUpId, method: 'passkey' }));
    expect(v.status).toBe(200);
    expect(state.stepUps[0].params_hash).toBe(hashOperationParams(params));

    const first = await refundRoute.POST(req({ paymentId: 'pay-1', businessId: 'b1', amount: 500, reason: 'x', stepUpId: prep.stepUpId }));
    expect(first.status).toBe(200);
    expect(state.refunds).toBe(1);
    const replay = await refundRoute.POST(req({ paymentId: 'pay-1', businessId: 'b1', amount: 500, reason: 'x', stepUpId: prep.stepUpId }));
    expect(replay.status).toBe(403);
    expect(state.refunds).toBe(1);
  });

  it('a verified grant for a different amount is refused', async () => {
    const prep = await (await prepareRoute.POST(req({ actionType: 'refund', targetId: 'pay-1', params: { businessId: 'b1', amount: 500, reason: 'x' } }))).json();
    state.stepUps[0].created_at = new Date((nowSec() - 5) * 1000).toISOString();
    tapNow();
    await verifyRoute.POST(req({ stepUpId: prep.stepUpId, method: 'passkey' }));
    const res = await refundRoute.POST(req({ paymentId: 'pay-1', businessId: 'b1', amount: 5000, reason: 'x', stepUpId: prep.stepUpId }));
    expect(res.status).toBe(403);
    expect(state.refunds).toBe(0);
  });
});

describe('passkey approve/remove endpoint', () => {
  function codeGrant(action: string, factorId: string) {
    const row = { id: `su-${++state.seq}`, admin_user_id: 'admin-1', session_id: 'sess-1', action_type: action, target_id: factorId, params_hash: hashOperationParams({ factor_id: factorId }), factor_id: 'totp-1', challenge_id: 'c', verified_at: '2026-11-12T00:00:00Z', consumed_at: null, expires_at: '2999-01-01T00:00:00Z', created_at: '2026-11-12T00:00:00Z' };
    state.stepUps.push(row);
    return row.id;
  }

  beforeEach(() => {
    state.admin = totpAdmin();
    state.admin.factors = [...FACTORS, { id: 'pk-2', factor_type: 'webauthn', status: 'verified' }];
  });

  it('approval without a step-up is refused', async () => {
    const res = await passkeysRoute.POST(req({ action: 'approve', factorId: 'pk-2' }));
    expect(res.status).toBe(403);
    expect(state.approvals.map(a => a.factor_id)).toEqual(['pk-1']);
  });

  it('approval with a verified code step-up for this factor succeeds', async () => {
    const id = codeGrant('passkey_approve', 'pk-2');
    const res = await passkeysRoute.POST(req({ action: 'approve', factorId: 'pk-2', stepUpId: id }));
    expect(res.status).toBe(200);
    expect(state.approvals.map(a => a.factor_id)).toEqual(['pk-1', 'pk-2']);
  });

  it('a step-up for another factor cannot approve this one', async () => {
    const id = codeGrant('passkey_approve', 'pk-1');
    const res = await passkeysRoute.POST(req({ action: 'approve', factorId: 'pk-2', stepUpId: id }));
    expect(res.status).toBe(403);
    expect(state.approvals.map(a => a.factor_id)).toEqual(['pk-1']);
  });

  it("another user's factor is not found", async () => {
    const id = codeGrant('passkey_approve', 'pk-other');
    const res = await passkeysRoute.POST(req({ action: 'approve', factorId: 'pk-other', stepUpId: id }));
    expect(res.status).toBe(404);
  });

  it('removal drops the approval and deletes the factor', async () => {
    const id = codeGrant('passkey_remove', 'pk-1');
    const res = await passkeysRoute.POST(req({ action: 'remove', factorId: 'pk-1', stepUpId: id }));
    expect(res.status).toBe(200);
    expect(state.approvals).toEqual([]);
    expect(state.deletedFactors).toEqual(['pk-1']);
  });
});
