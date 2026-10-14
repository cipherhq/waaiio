/**
 * Commercial config route: country-amount server-side validation
 *
 * Proves that the POST /api/admin/platform-settings/commercial route:
 * - Returns 400 for invalid minimum_bank_transfer / minimum_payout values
 * - Passes valid values through to the RPC as numbers (not strings)
 *
 * Run:
 *   npx vitest run lib/__tests__/commercial-route-country-amounts.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks ---

const rpcMock = vi.fn();

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    rpc: rpcMock,
  }),
}));

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(async () => ({
    id: 'admin-1',
    userId: 'admin-1',
    email: 'admin@test.test',
    role: 'admin',
    aal: 'aal2',
    bearerToken: 'tok',
    sessionId: 'sess-1',
  })),
}));

vi.mock('@/lib/admin-step-up', () => ({
  consumeStepUp: vi.fn(async () => {}),
  StepUpError: class StepUpError extends Error {},
}));

vi.mock('@/lib/admin-cors', () => ({
  adminCorsHeaders: () => ({}),
}));

function makeRequest(body: Record<string, unknown>) {
  return {
    json: async () => body,
    headers: { get: () => null },
  } as unknown as import('next/server').NextRequest;
}

describe('POST /api/admin/platform-settings/commercial — country-amount validation', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.mockResolvedValue({ data: 'version-1', error: null });
    envBackup.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    envBackup.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://unit.example.test';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'unit-test-public-key';
  });

  afterEach(() => {
    if (envBackup.NEXT_PUBLIC_SUPABASE_URL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = envBackup.NEXT_PUBLIC_SUPABASE_URL;
    if (envBackup.NEXT_PUBLIC_SUPABASE_ANON_KEY === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = envBackup.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  async function callRoute(body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/admin/platform-settings/commercial/route');
    const res = await POST(makeRequest(body));
    const json = await res.json();
    return { status: res.status, json };
  }

  // --- Rejection tests ---

  it('rejects minimum_bank_transfer with string value "1000"', async () => {
    const { status, json } = await callRoute({
      key: 'minimum_bank_transfer',
      value: { NG: '1000', GH: 5000 },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(json.code).toBe('validation_error');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects minimum_bank_transfer with negative value', async () => {
    const { status } = await callRoute({
      key: 'minimum_bank_transfer',
      value: { NG: -1, GH: 5000 },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects minimum_bank_transfer with decimal value', async () => {
    const { status } = await callRoute({
      key: 'minimum_bank_transfer',
      value: { NG: 1.5, GH: 5000 },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects minimum_bank_transfer with unknown country', async () => {
    const { status, json } = await callRoute({
      key: 'minimum_bank_transfer',
      value: { NG: 5000, GH: 5000, US: 5000 },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(json.error).toContain('not allowed');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects minimum_bank_transfer missing GH', async () => {
    const { status, json } = await callRoute({
      key: 'minimum_bank_transfer',
      value: { NG: 5000 },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(json.error).toContain('required');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects minimum_payout missing US', async () => {
    const { status, json } = await callRoute({
      key: 'minimum_payout',
      value: { NG: 5000, GB: 2000, CA: 2500, GH: 50 },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(json.error).toContain('required');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects minimum_bank_transfer with empty object', async () => {
    const { status } = await callRoute({
      key: 'minimum_bank_transfer',
      value: {},
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects minimum_bank_transfer when value is a string', async () => {
    const { status } = await callRoute({
      key: 'minimum_bank_transfer',
      value: '{"NG": 5000}',
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects minimum_bank_transfer when value is an array', async () => {
    const { status } = await callRoute({
      key: 'minimum_bank_transfer',
      value: [5000],
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects minimum_bank_transfer when value is null', async () => {
    const { status } = await callRoute({
      key: 'minimum_bank_transfer',
      value: null,
      stepUpId: 'su-1',
    });
    // null value hits the !key || value === undefined check, but null !== undefined
    // so it passes that check. Our validator catches it.
    expect(status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects minimum_payout with nested object', async () => {
    const { status } = await callRoute({
      key: 'minimum_payout',
      value: { NG: { amount: 5000 }, US: 2500, GB: 2000, CA: 2500, GH: 50 },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects minimum_payout with NaN', async () => {
    const { status } = await callRoute({
      key: 'minimum_payout',
      value: { NG: NaN, US: 2500, GB: 2000, CA: 2500, GH: 50 },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  // --- Pass-through tests ---

  it('passes valid minimum_bank_transfer to RPC as numbers', async () => {
    const { status } = await callRoute({
      key: 'minimum_bank_transfer',
      value: { NG: 5000, GH: 5000 },
      stepUpId: 'su-1',
    });
    expect(status).toBe(200);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const rpcArgs = rpcMock.mock.calls[0][1];
    expect(rpcArgs.p_key).toBe('minimum_bank_transfer');
    // Values should be numbers, not strings
    expect(rpcArgs.p_value).toEqual({ NG: 5000, GH: 5000 });
    expect(typeof rpcArgs.p_value.NG).toBe('number');
    expect(typeof rpcArgs.p_value.GH).toBe('number');
  });

  it('passes valid minimum_payout to RPC as numbers', async () => {
    const { status } = await callRoute({
      key: 'minimum_payout',
      value: { NG: 5000, US: 2500, GB: 2000, CA: 2500, GH: 50 },
      stepUpId: 'su-1',
    });
    expect(status).toBe(200);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const p_value = rpcMock.mock.calls[0][1].p_value;
    expect(typeof p_value.NG).toBe('number');
    expect(typeof p_value.US).toBe('number');
    expect(p_value.NG).toBe(5000);
  });

  it('does not validate non-country-amount keys', async () => {
    // trial_days is not a country-amount key — no validation applied
    const { status } = await callRoute({
      key: 'trial_days',
      value: 14,
      stepUpId: 'su-1',
    });
    expect(status).toBe(200);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});
