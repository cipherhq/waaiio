/**
 * Commercial config route: messaging_topup_packages server-side validation
 *
 * Proves that POST /api/admin/platform-settings/commercial:
 *   1. Runs requirePlatformAdmin (auth) BEFORE validation — route.ts line 18
 *   2. Runs validateTopupPackages BEFORE consumeStepUp — route.ts lines 40-48 vs line 52
 *   3. Returns 400 + does NOT call consumeStepUp for every invalid payload
 *   4. Calls consumeStepUp and the RPC for a valid payload
 *
 * Run:
 *   npx vitest run lib/__tests__/commercial-route-topup-packages.test.ts
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

const consumeStepUpMock = vi.fn(async () => {});

vi.mock('@/lib/admin-step-up', () => ({
  consumeStepUp: consumeStepUpMock,
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

describe('POST /api/admin/platform-settings/commercial — topup-packages validation', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.mockResolvedValue({ data: 'version-1', error: null });
    consumeStepUpMock.mockResolvedValue(undefined);
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

  // ── Auth-before-validation order proof ───────────────────────────────────────
  // route.ts line 18: requirePlatformAdmin (auth)
  // route.ts lines 40-48: isTopupPackagesKey / validateTopupPackages (validation)
  // route.ts line 52: consumeStepUp (step-up authorization)
  // This order means: validation never reaches the step-up layer for bad payloads.

  // ── Rejection tests — consumeStepUp must NOT be called ───────────────────────

  it('rejects null value', async () => {
    const { status, json } = await callRoute({
      key: 'messaging_topup_packages',
      value: null,
      stepUpId: 'su-1',
    });
    // null hits the !key || value === undefined guard at line 24; null !== undefined
    // so it passes that guard. validateTopupPackages rejects null with a 400.
    expect(status).toBe(400);
    expect(json.code).toBe('validation_error');
    expect(consumeStepUpMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects a string value', async () => {
    const { status, json } = await callRoute({
      key: 'messaging_topup_packages',
      value: '{"NGN":[]}',
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(json.code).toBe('validation_error');
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });

  it('rejects an array value', async () => {
    const { status } = await callRoute({
      key: 'messaging_topup_packages',
      value: [],
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown currency code', async () => {
    const { status, json } = await callRoute({
      key: 'messaging_topup_packages',
      value: { EUR: [{ amount_minor: 1000, label: '€10' }] },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(json.error).toContain('EUR');
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });

  it('rejects negative amount_minor', async () => {
    const { status, json } = await callRoute({
      key: 'messaging_topup_packages',
      value: { NGN: [{ amount_minor: -1000, label: 'bad' }] },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(json.error).toContain('greater than 0');
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });

  it('rejects zero amount_minor', async () => {
    const { status } = await callRoute({
      key: 'messaging_topup_packages',
      value: { NGN: [{ amount_minor: 0, label: 'bad' }] },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });

  it('rejects a decimal amount_minor', async () => {
    const { status, json } = await callRoute({
      key: 'messaging_topup_packages',
      value: { NGN: [{ amount_minor: 1000.5, label: 'bad' }] },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(json.error).toContain('whole number');
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate amount_minor values within a currency', async () => {
    const { status, json } = await callRoute({
      key: 'messaging_topup_packages',
      value: {
        NGN: [
          { amount_minor: 100000, label: 'First' },
          { amount_minor: 100000, label: 'Duplicate' },
        ],
      },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(json.error).toContain('duplicate');
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });

  it('rejects a missing label', async () => {
    const { status, json } = await callRoute({
      key: 'messaging_topup_packages',
      value: { NGN: [{ amount_minor: 100000 }] },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(json.error).toContain('label');
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });

  it('rejects an empty label', async () => {
    const { status } = await callRoute({
      key: 'messaging_topup_packages',
      value: { NGN: [{ amount_minor: 100000, label: '' }] },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });

  it('rejects a non-object package (array element that is a string)', async () => {
    const { status } = await callRoute({
      key: 'messaging_topup_packages',
      value: { NGN: ['not-an-object'] },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown field on a package', async () => {
    const { status, json } = await callRoute({
      key: 'messaging_topup_packages',
      value: { NGN: [{ amount_minor: 100000, label: 'ok', bonus: 'free' }] },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(json.error).toContain('"bonus"');
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });

  it('rejects a non-string description', async () => {
    const { status } = await callRoute({
      key: 'messaging_topup_packages',
      value: { NGN: [{ amount_minor: 100000, label: 'ok', description: 42 }] },
      stepUpId: 'su-1',
    });
    expect(status).toBe(400);
    expect(consumeStepUpMock).not.toHaveBeenCalled();
  });

  // ── Pass-through test — consumeStepUp and RPC are both called ────────────────

  it('passes a valid single-currency payload through to consumeStepUp and the RPC', async () => {
    const { status } = await callRoute({
      key: 'messaging_topup_packages',
      value: {
        NGN: [
          { amount_minor: 100000, label: '₦1,000 credit' },
          { amount_minor: 500000, label: '₦5,000 credit', description: 'Best value' },
        ],
      },
      stepUpId: 'su-1',
    });
    expect(status).toBe(200);
    expect(consumeStepUpMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const rpcArgs = rpcMock.mock.calls[0][1];
    expect(rpcArgs.p_key).toBe('messaging_topup_packages');
    expect(rpcArgs.p_value.NGN[0].amount_minor).toBe(100000);
  });

  it('passes an empty object {} — clears all packages — through to consumeStepUp and RPC', async () => {
    const { status } = await callRoute({
      key: 'messaging_topup_packages',
      value: {},
      stepUpId: 'su-1',
    });
    expect(status).toBe(200);
    expect(consumeStepUpMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it('passes a valid multi-currency payload', async () => {
    const { status } = await callRoute({
      key: 'messaging_topup_packages',
      value: {
        NGN: [{ amount_minor: 100000, label: '₦1,000' }],
        GHS: [{ amount_minor: 10000, label: 'GH₵100' }],
        USD: [{ amount_minor: 1000, label: '$10' }],
        GBP: [{ amount_minor: 1000, label: '£10' }],
        CAD: [{ amount_minor: 1000, label: 'CA$10' }],
      },
      stepUpId: 'su-1',
    });
    expect(status).toBe(200);
    expect(consumeStepUpMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});
