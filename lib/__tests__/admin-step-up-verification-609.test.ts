/**
 * SEC-005: executable step-up verification state-transition regressions.
 * No production Auth calls: the GoTrue MFA response and service DB are isolated.
 * The corresponding real-service staging proofs remain a separate release gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAdmin } from '../admin-auth';

const mock = vi.hoisted(() => ({
  pending: vi.fn(),
  marked: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
  gt: vi.fn(),
  update: vi.fn(),
  transport: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('@/lib/admin-mfa-transport', () => ({ verifyTotpOnSingleConnection: (...args: unknown[]) => mock.transport(...args) }));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => {
      const query: Record<string, unknown> = {};
      query.select = vi.fn(() => query);
      query.eq = vi.fn((...args: unknown[]) => { mock.eq(...args); return query; });
      query.is = vi.fn((...args: unknown[]) => { mock.is(...args); return query; });
      query.gt = vi.fn((...args: unknown[]) => { mock.gt(...args); return query; });
      query.insert = vi.fn((...args: unknown[]) => { mock.insert(...args); return query; });
      query.update = vi.fn((...args: unknown[]) => { mock.update(...args); return query; });
      query.single = vi.fn(async () => ({ data: mock.pending(), error: null }));
      query.maybeSingle = vi.fn(async () => ({ data: mock.marked(), error: null }));
      return query;
    },
  }),
}));

const admin: PlatformAdmin = {
  id: 'admin-one', userId: 'admin-one', email: 'admin@example.test',
  role: 'admin', aal: 'aal2', bearerToken: 'verified-request-token',
  sessionId: 'verified-session-one',
};

const pendingRow = () => ({
  id: 'step-up-one',
  admin_user_id: admin.userId,
  session_id: admin.sessionId,
  challenge_id: null,
  factor_id: 'factor-one',
  verified_at: null,
  consumed_at: null,
  expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
});

describe('SEC-005 step-up verification: exact pending-state enforcement', () => {
  const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const oldKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = oldKey;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://unit.example.test';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'unit-test-public-key';
    mock.pending.mockImplementation(pendingRow);
    mock.marked.mockReturnValue({ id: 'step-up-one' });
    mock.transport.mockImplementation(async options => {
      await options.bindChallenge('challenge-one');
      return { access_token: 'rotated-aal2-token', refresh_token: 'rotated-refresh-token' };
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string) => ({
      ok: true,
      json: async () => input.endsWith('/verify')
        ? { access_token: 'rotated-aal2-token', refresh_token: 'rotated-refresh-token' }
        : { success: true },
    })));
  });

  it('accepts only the same admin/session/challenge and an updated pending row', async () => {
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).resolves.toEqual({
      access_token: 'rotated-aal2-token', refresh_token: 'rotated-refresh-token',
    });
    expect(mock.transport).toHaveBeenCalledWith(expect.objectContaining({ factorId: 'factor-one', code: '123456' }));
    expect(mock.eq).toHaveBeenCalledWith('admin_user_id', admin.userId);
    expect(mock.eq).toHaveBeenCalledWith('session_id', admin.sessionId);
    expect(mock.eq).toHaveBeenCalledWith('challenge_id', 'challenge-one');
    expect(mock.eq).toHaveBeenCalledWith('factor_id', 'factor-one');
    expect(mock.is).toHaveBeenCalledWith('challenge_id', null);
    expect(mock.is).toHaveBeenCalledWith('consumed_at', null);
    expect(mock.is).toHaveBeenCalledWith('verified_at', null);
    expect(mock.gt).toHaveBeenCalledWith('expires_at', expect.any(String));
  });

  it('denies when the conditional verification UPDATE matches zero rows', async () => {
    mock.marked.mockReturnValue(null);
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).rejects.toThrow(
      /Cancel and restart/,
    );
  });

  it('denies a different authenticated session before contacting MFA', async () => {
    mock.pending.mockImplementation(() => ({ ...pendingRow(), session_id: 'different-session' }));
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).rejects.toThrow(/different session/);
    expect(mock.transport).not.toHaveBeenCalled();
    expect(mock.update).not.toHaveBeenCalled();
  });

  it('denies verification for a different admin identity', async () => {
    mock.pending.mockImplementation(() => ({ ...pendingRow(), admin_user_id: 'another-admin' }));
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).rejects.toThrow(/different admin/);
    expect(mock.update).not.toHaveBeenCalled();
  });

  it('denies an already-consumed step-up even with a valid MFA code', async () => {
    mock.pending.mockImplementation(() => ({ ...pendingRow(), consumed_at: new Date().toISOString() }));
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).rejects.toThrow(/already consumed/);
    expect(mock.transport).not.toHaveBeenCalled();
  });

  it('denies an expired pending step-up before contacting MFA', async () => {
    mock.pending.mockImplementation(() => ({
      ...pendingRow(), expires_at: new Date(Date.now() - 10_000).toISOString(),
    }));
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).rejects.toThrow(/expired/);
    expect(mock.transport).not.toHaveBeenCalled();
  });
  it('requires fresh prepare for legacy or already bound challenge, without another Auth call', async () => {
    mock.pending.mockImplementation(() => ({ ...pendingRow(), challenge_id: 'previous-challenge' }));
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).rejects.toMatchObject({ restartRequired: true });
    expect(mock.transport).not.toHaveBeenCalled();
  });

  it('does not mark verified after transport failure and tells the caller to restart', async () => {
    mock.transport.mockImplementation(async options => { await options.bindChallenge('challenge-one'); throw new Error('bad code'); });
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).rejects.toMatchObject({ restartRequired: true });
    expect(mock.update).toHaveBeenCalledTimes(1);
    expect(mock.update).toHaveBeenCalledWith({ challenge_id: 'challenge-one' });
  });

  it('rejects a race after successful MFA when final verification UPDATE matches zero rows', async () => {
    mock.marked.mockReturnValueOnce({ id: 'step-up-one' }).mockReturnValueOnce(null);
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).rejects.toMatchObject({ restartRequired: true });
  });

  it('prepares only the operation/factor binding, without creating an Auth challenge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ factors: [{ id: 'factor-one', factor_type: 'totp', status: 'verified' }] }) })));
    const { prepareStepUp } = await import('../admin-step-up');
    await expect(prepareStepUp(admin, 'payout_approve', 'fixture', {})).resolves.toMatchObject({ stepUpId: 'step-up-one', factorId: 'factor-one', challengeId: '' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://unit.example.test/auth/v1/user', expect.anything());
    expect(mock.insert).toHaveBeenCalledWith(expect.objectContaining({ challenge_id: null, session_id: admin.sessionId, factor_id: 'factor-one' }));
  });

  it('permits exactly one concurrent challenge binding; the loser never receives verification success', async () => {
    let bound = false;
    mock.marked.mockImplementation(() => {
      const update = mock.update.mock.calls.at(-1)?.[0];
      if (update?.challenge_id) { if (bound) return null; bound = true; }
      return { id: 'step-up-one' };
    });
    const { verifyStepUp } = await import('../admin-step-up');
    const results = await Promise.allSettled([verifyStepUp(admin, 'step-up-one', '123456'), verifyStepUp(admin, 'step-up-one', '123456')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(mock.update.mock.calls.filter(([value]) => value.verified_at)).toHaveLength(1);
  });

});
