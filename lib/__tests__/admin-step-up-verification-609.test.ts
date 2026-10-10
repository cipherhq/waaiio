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
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => {
      const query: Record<string, unknown> = {};
      query.select = vi.fn(() => query);
      query.eq = vi.fn((...args: unknown[]) => { mock.eq(...args); return query; });
      query.is = vi.fn((...args: unknown[]) => { mock.is(...args); return query; });
      query.gt = vi.fn((...args: unknown[]) => { mock.gt(...args); return query; });
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
  challenge_id: 'challenge-one',
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
    vi.stubGlobal('fetch', vi.fn(async (input: string) => ({
      ok: true,
      json: async () => input.endsWith('/factors')
        ? [{ id: 'factor-one', factor_type: 'totp', status: 'verified' }]
        : { success: true },
    })));
  });

  it('accepts only the same admin/session/challenge and an updated pending row', async () => {
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).resolves.toBe(true);
    expect(mock.eq).toHaveBeenCalledWith('admin_user_id', admin.userId);
    expect(mock.eq).toHaveBeenCalledWith('session_id', admin.sessionId);
    expect(mock.eq).toHaveBeenCalledWith('challenge_id', 'challenge-one');
    expect(mock.is).toHaveBeenCalledWith('consumed_at', null);
    expect(mock.is).toHaveBeenCalledWith('verified_at', null);
    expect(mock.gt).toHaveBeenCalledWith('expires_at', expect.any(String));
  });

  it('denies when the conditional verification UPDATE matches zero rows', async () => {
    mock.marked.mockReturnValue(null);
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).rejects.toThrow(
      /no longer pending/,
    );
  });

  it('denies a different authenticated session before contacting MFA', async () => {
    mock.pending.mockImplementation(() => ({ ...pendingRow(), session_id: 'different-session' }));
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).rejects.toThrow(/different session/);
    expect(fetch).not.toHaveBeenCalled();
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
    expect(fetch).not.toHaveBeenCalled();
  });

  it('denies an expired pending step-up before contacting MFA', async () => {
    mock.pending.mockImplementation(() => ({
      ...pendingRow(), expires_at: new Date(Date.now() - 10_000).toISOString(),
    }));
    const { verifyStepUp } = await import('../admin-step-up');
    await expect(verifyStepUp(admin, 'step-up-one', '123456')).rejects.toThrow(/expired/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
