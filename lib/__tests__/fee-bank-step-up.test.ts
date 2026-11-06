/**
 * Platform fee bank account (Owner decision 2026-11-06, "extra code required"):
 * - the general platform-settings routes refuse platform_bank_* keys;
 * - /api/admin/platform-settings/fee-bank saves only with a verified, unconsumed
 *   step-up bound to provider_config + platform_bank_ng + this exact value.
 *
 * Runs the real route handlers and the real consumeStepUp against an in-memory
 * step-up table; auth, audit and CORS are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashOperationParams } from '@/lib/admin-step-up';
import { requirePlatformAdmin } from '@/lib/admin-auth';

type StepUpRow = {
  id: string; admin_user_id: string; session_id: string; action_type: string;
  target_id: string | null; params_hash: string; verified_at: string | null;
  consumed_at: string | null; expires_at: string;
};

const { state } = vi.hoisted(() => ({
  state: {
    stepUps: [] as StepUpRow[],
    settings: new Map<string, unknown>(),
    upserts: 0,
    genericWrites: 0,
    admin: { id: 'admin-1', userId: 'admin-1', email: 'a@test.test', role: 'admin', aal: 'aal2', bearerToken: 't', sessionId: 'sess-1' } as Record<string, unknown> | null,
  },
}));

function stepUpTable() {
  const preds: Array<(r: StepUpRow) => boolean> = [];
  let patch: Partial<StepUpRow> = {};
  const chain: Record<string, unknown> = {};
  chain.update = (p: Partial<StepUpRow>) => { patch = p; return chain; };
  chain.eq = (c: keyof StepUpRow, v: unknown) => { preds.push(r => r[c] === v); return chain; };
  chain.is = (c: keyof StepUpRow, v: unknown) => { preds.push(r => r[c] === v); return chain; };
  chain.not = (c: keyof StepUpRow, _op: string, v: unknown) => { preds.push(r => r[c] !== v); return chain; };
  chain.gt = (c: keyof StepUpRow, v: string) => { preds.push(r => String(r[c]) > v); return chain; };
  chain.select = async () => {
    const hit = state.stepUps.filter(r => preds.every(p => p(r)));
    hit.forEach(r => Object.assign(r, patch));
    return { data: hit.map(r => ({ id: r.id })), error: null };
  };
  return chain;
}

function settingsTable() {
  let key = '';
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (_c: string, v: string) => { key = v; return chain; };
  chain.maybeSingle = async () => ({ data: state.settings.has(key) ? { value: state.settings.get(key), updated_at: 'now' } : null, error: null });
  chain.upsert = async (row: { key: string; value: unknown }) => { state.upserts++; state.settings.set(row.key, row.value); return { error: null }; };
  chain.update = () => { state.genericWrites++; return { eq: async () => ({ error: null }) }; };
  chain.insert = async () => { state.genericWrites++; return { error: null }; };
  chain.delete = () => { state.genericWrites++; return { eq: async () => ({ error: null }) }; };
  return chain;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (t: string) => (t === 'admin_step_up_authorizations' ? stepUpTable() : settingsTable()),
  }),
}));
vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: vi.fn(async () => state.admin) }));
vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn(async () => ({ error: null })) }));
vi.mock('@/lib/admin-cors', () => ({ adminCorsHeaders: () => ({}) }));
vi.mock('@/lib/admin-mfa-transport', () => ({ verifyTotpOnSingleConnection: vi.fn() }));

import * as feeBank from '@/app/api/admin/platform-settings/fee-bank/route';
import * as generic from '@/app/api/admin/platform-settings/route';

const VALUE = { bank_code: '058', account_number: '0123456789', account_name: 'Waaiio Ltd' };

function req(body: unknown) {
  return { json: async () => body, headers: { get: () => null } } as unknown as import('next/server').NextRequest;
}

function addStepUp(over: Partial<StepUpRow> & { params?: Record<string, unknown> } = {}) {
  const { params, ...rest } = over;
  const row: StepUpRow = {
    id: `su-${state.stepUps.length + 1}`, admin_user_id: 'admin-1', session_id: 'sess-1',
    action_type: 'provider_config', target_id: 'platform_bank_ng',
    params_hash: hashOperationParams(params ?? { key: 'platform_bank_ng', value: VALUE }),
    verified_at: '2026-11-06T00:00:00Z', consumed_at: null, expires_at: '2999-01-01T00:00:00Z',
    ...rest,
  };
  state.stepUps.push(row);
  return row.id;
}

beforeEach(() => {
  state.stepUps = [];
  state.settings = new Map();
  state.upserts = 0;
  state.genericWrites = 0;
  state.admin = { id: 'admin-1', userId: 'admin-1', email: 'a@test.test', role: 'admin', aal: 'aal2', bearerToken: 't', sessionId: 'sess-1' };
});

describe('general platform-settings routes refuse fee bank keys', () => {
  it.each(['platform_bank_ng', 'PLATFORM_BANK_NG', ' platform_bank_gh'])('PUT/POST/DELETE %s → 403, nothing written', async (key) => {
    for (const handler of [generic.PUT, generic.POST, generic.DELETE]) {
      const res = await handler(req({ key, value: VALUE }));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('fee_bank_protected');
    }
    expect(state.genericWrites).toBe(0);
  });

  it('other keys still go through the general route', async () => {
    const res = await generic.PUT(req({ key: 'invoice_expiry_days', value: 30 }));
    expect(res.status).not.toBe(403);
    expect(state.genericWrites).toBe(1);
  });
});

describe('fee bank route requires a step-up bound to this exact value', () => {
  it('no step-up → 403, nothing saved', async () => {
    const res = await feeBank.PUT(req({ ...VALUE }));
    expect(res.status).toBe(403);
    expect(state.upserts).toBe(0);
  });

  it('step-up for a different account number → 403', async () => {
    const id = addStepUp({ params: { key: 'platform_bank_ng', value: { ...VALUE, account_number: '9999999999' } } });
    const res = await feeBank.PUT(req({ ...VALUE, stepUpId: id }));
    expect(res.status).toBe(403);
    expect(state.upserts).toBe(0);
  });

  it('step-up for another action or target → 403', async () => {
    const a = addStepUp({ action_type: 'commercial_config' });
    const b = addStepUp({ target_id: 'NG' });
    for (const id of [a, b]) {
      const res = await feeBank.PUT(req({ ...VALUE, stepUpId: id }));
      expect(res.status).toBe(403);
    }
    expect(state.upserts).toBe(0);
  });

  it('unverified, expired, other session → 403', async () => {
    const ids = [
      addStepUp({ verified_at: null }),
      addStepUp({ expires_at: '2000-01-01T00:00:00Z' }),
      addStepUp({ session_id: 'other-session' }),
    ];
    for (const id of ids) {
      expect((await feeBank.PUT(req({ ...VALUE, stepUpId: id }))).status).toBe(403);
    }
    expect(state.upserts).toBe(0);
  });

  it('valid step-up → saved once; the same step-up cannot be reused', async () => {
    const id = addStepUp();
    const res = await feeBank.PUT(req({ ...VALUE, stepUpId: id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account_number_masked).toBe('******6789');
    expect(JSON.stringify(body)).not.toContain('0123456789');
    expect(state.settings.get('platform_bank_ng')).toEqual(VALUE);

    const again = await feeBank.PUT(req({ ...VALUE, stepUpId: id }));
    expect(again.status).toBe(403);
    expect(state.upserts).toBe(1);
  });

  it('invalid values are rejected before any step-up is consumed', async () => {
    const id = addStepUp();
    for (const bad of [{ ...VALUE, account_number: '12345' }, { ...VALUE, bank_code: 'abc' }, { ...VALUE, account_name: '' }]) {
      expect((await feeBank.PUT(req({ ...bad, stepUpId: id }))).status).toBe(400);
    }
    expect(state.stepUps[0].consumed_at).toBeNull();
  });

  it('the fee bank route requires the full admin role', async () => {
    await feeBank.PUT(req({ ...VALUE, stepUpId: addStepUp() }));
    expect(vi.mocked(requirePlatformAdmin)).toHaveBeenCalledWith(expect.anything(), { requiredRole: 'admin' });
  });

  it('non-admin → 403, nothing saved', async () => {
    state.admin = null;
    expect((await feeBank.PUT(req({ ...VALUE, stepUpId: addStepUp() }))).status).toBe(403);
    expect(state.upserts).toBe(0);
  });
});
