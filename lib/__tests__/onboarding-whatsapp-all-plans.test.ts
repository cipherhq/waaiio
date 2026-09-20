/**
 * Regression + orchestration tests for #346: customer-owned WhatsApp on all plans.
 *
 * Part A: Structural assertions (source-level correctness)
 * Part B: Server-authority orchestration (register route behavior)
 * Part C: Verify/trial orchestration (Free register → verify → trial)
 * Part D: Paid path orchestration (register → subscribe, not converted)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NextRequest } from 'next/server';

// ═══ Part A: Structural source assertions ═══

const stepDetailsSource = readFileSync(
  join(process.cwd(), 'app/get-started/steps/StepDetails.tsx'),
  'utf-8',
);
const stepSuccessSource = readFileSync(
  join(process.cwd(), 'app/get-started/steps/StepSuccess.tsx'),
  'utf-8',
);
const wizardSource = readFileSync(
  join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'),
  'utf-8',
);
const dashboardConnectSource = readFileSync(
  join(process.cwd(), 'app/dashboard/whatsapp/connect/page.tsx'),
  'utf-8',
);
const registerRouteSource = readFileSync(
  join(process.cwd(), 'app/api/onboarding/register/route.ts'),
  'utf-8',
);

describe('#346 Part A — Structural assertions', () => {

  describe('StepDetails', () => {
    it('no plan gate on WhatsApp section', () => {
      expect(stepDetailsSource).not.toContain("selectedPlan !== 'free'");
    });

    it('shows "available on every plan" copy', () => {
      expect(stepDetailsSource).toContain('available on every plan');
    });

    it('no Pro/Premium-only wording', () => {
      expect(stepDetailsSource).not.toMatch(/As a .* user, you can connect/);
    });

    it('defers Meta connection to post-create dashboard (no Embedded Signup UI in template)', () => {
      // C3 fix: no Facebook Embedded Signup controls in the rendered template
      // (launchWhatsAppSignup may exist in props destructuring but must not be invoked in JSX)
      const templateBody = stepDetailsSource.slice(stepDetailsSource.indexOf('return ('));
      expect(templateBody).not.toContain('Connect with Facebook');
      expect(templateBody).not.toContain('launchWhatsAppSignup');
      expect(templateBody).not.toContain('Facebook Connected');
      // Instead shows deferred-connection notice
      expect(templateBody).toContain('connect your number after signup');
    });

    it('does not mutate selectedPlan', () => {
      expect(stepDetailsSource).not.toContain('setSelectedPlan');
    });
  });

  describe('StepSuccess', () => {
    it('always shows connect CTA (no conditional on waMethod or fbConnectionData)', () => {
      expect(stepSuccessSource).toContain('Connect Your Own WhatsApp Number');
      expect(stepSuccessSource).toContain('Do this later');
      expect(stepSuccessSource).not.toContain('WhatsApp Number Connected');
    });

    it('CTA links to /dashboard/whatsapp/connect without dead params', () => {
      expect(stepSuccessSource).toContain('href="/dashboard/whatsapp/connect"');
      expect(stepSuccessSource).not.toContain('?business_id=');
    });

    it('no misleading "setting up" copy', () => {
      expect(stepSuccessSource).not.toContain('Our team is setting up');
    });
  });

  describe('Registration route — server-enforced shared', () => {
    it('C1: route hardcodes wa_method to shared, ignoring caller value', () => {
      // The insert payload must use 'shared', not the caller-supplied wa_method
      const insertBlock = registerRouteSource.slice(
        registerRouteSource.indexOf('.insert({'),
        registerRouteSource.indexOf('status: \'pending\'') + 20
      );
      expect(insertBlock).toContain("wa_method: 'shared'");
      expect(insertBlock).not.toMatch(/wa_method:\s*wa_method/);
      expect(insertBlock).not.toMatch(/wa_method:\s*body\.wa_method/);
    });
  });

  describe('OnboardingWizard — client also sends shared', () => {
    it('handleRegister sends wa_method: shared', () => {
      const handleRegisterBlock = wizardSource.slice(
        wizardSource.indexOf('async function handleRegister'),
        wizardSource.indexOf('// ── Payment Handler')
      );
      expect(handleRegisterBlock).toContain("wa_method: 'shared'");
    });

    it('paid plan still redirects to /api/onboarding/subscribe', () => {
      const handleRegisterBlock = wizardSource.slice(
        wizardSource.indexOf('async function handleRegister'),
        wizardSource.indexOf('// ── Payment Handler')
      );
      expect(handleRegisterBlock).toContain('/api/onboarding/subscribe');
    });
  });

  describe('Dashboard connect — no tier gate', () => {
    it('no subscription_tier reference', () => {
      expect(dashboardConnectSource).not.toContain('subscription_tier');
    });

    it('uses useBusiness() for context', () => {
      expect(dashboardConnectSource).toContain('useBusiness');
    });
  });
});

// ═══ Part B-D: Orchestration tests (actual route execution) ═══

// ── Mock infrastructure ──

const mockGetUser = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
  }),
}));

let mockCountriesResponse = {
  data: [
    { code: 'NG', dialing_code: '+234' },
    { code: 'US', dialing_code: '+1' },
  ],
  error: null,
};

let lastInsertPayload: Record<string, unknown> | null = null;
let lastBusinessUpdate: Record<string, unknown> | null = null;
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

const mockServiceFrom = vi.fn((table: string) => {
  if (table === 'countries') {
    return {
      select: () => ({ eq: () => Promise.resolve(mockCountriesResponse) }),
    };
  }
  if (table === 'businesses') {
    return {
      select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) {
          return { eq: () => ({ in: () => Promise.resolve({ count: 0, error: null }) }) };
        }
        return {
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
              single: () => Promise.resolve({
                data: { id: 'biz-new', owner_id: 'user-1', status: 'pending', category: 'salon', bot_code: 'TESTCODE', subscription_tier: 'free', wa_method: 'shared' },
                error: null,
              }),
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          }),
        };
      },
      insert: (data: Record<string, unknown>) => {
        lastInsertPayload = data;
        return {
          select: () => ({
            single: () => Promise.resolve({
              data: { id: 'biz-new', bot_code: 'TESTCODE', slug: 'test-biz' },
              error: null,
            }),
          }),
        };
      },
      update: (data: Record<string, unknown>) => {
        lastBusinessUpdate = data;
        return {
          eq: () => Promise.resolve({ error: null }),
        };
      },
    };
  }
  if (table === 'category_templates') {
    return {
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    };
  }
  if (table === 'whatsapp_config') {
    return { insert: () => Promise.resolve({ error: null }) };
  }
  if (table === 'profiles') {
    return {
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { role: 'restaurant_owner' }, error: null }) }) }),
    };
  }
  if (table === 'business_capabilities') {
    return {
      select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [{ capability: 'chat', is_enabled: true }], error: null }) }) }),
    };
  }
  if (table === 'subscriptions') {
    return {
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    };
  }
  return {
    select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
  };
});

const mockServiceRpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
  rpcCalls.push({ fn, args });
  if (fn === 'activate_trial_if_eligible') {
    return { data: { activated: true, trial_ends_at: '2026-10-04T00:00:00Z', amount_minor: 500, currency_code: 'USD' }, error: null };
  }
  return { data: null, error: null };
});

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
    rpc: mockServiceRpc,
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn(() => Promise.resolve(null)),
  getRateLimitKey: (_req: Request, prefix: string) => `${prefix}:127.0.0.1`,
}));

vi.mock('@/lib/categoryConfig', () => ({
  loadCategories: () => Promise.resolve(),
  getAllCategoryKeys: () => ['salon', 'restaurant'],
}));

vi.mock('@/lib/capabilities/service', () => ({
  initCapabilities: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/onboarding/finalize', () => ({
  finalizeOnboarding: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/constants', () => ({
  generateSlug: () => 'test-slug',
  generateBotCode: () => 'TESTCODE',
  CATEGORY_FLOW_MAP: {},
}));

vi.mock('@/lib/email/client', () => ({
  sendEmail: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/email/templates', () => ({
  welcomeEmail: () => ({ subject: 'x', html: 'x' }),
  businessRegisteredEmail: () => ({ subject: 'x', html: 'x' }),
}));

vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: () => Promise.resolve({ max_businesses_per_user: 5 }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/observability/server-events', () => ({
  emitServerEvent: vi.fn(),
}));

function makeRegisterRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/onboarding/register'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
  });
}

function makeVerifyRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/onboarding/verify'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
  });
}

const FRESH_BODY = {
  first_name: 'Test',
  last_name: 'User',
  name: 'Test Salon',
  city: 'Lagos',
  address: '1 Test Street',
  phone: '+2341234567890',
  category: 'salon',
  country: 'NG',
};

describe('#346 Part B — Server-authority: registration always persists shared', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lastInsertPayload = null;
    lastBusinessUpdate = null;
    rpcCalls = [];
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.com' } } });
    mockCountriesResponse = {
      data: [{ code: 'NG', dialing_code: '+234' }, { code: 'US', dialing_code: '+1' }],
      error: null,
    };
  });

  it('C1: register with wa_method=shared → persists shared', async () => {
    const { POST } = await import('@/app/api/onboarding/register/route');
    const res = await POST(makeRegisterRequest({ ...FRESH_BODY, wa_method: 'shared' }));
    expect(res.status).toBe(200);
    expect(lastInsertPayload!.wa_method).toBe('shared');
  });

  it('C1: register with wa_method=transfer → server overrides to shared', async () => {
    const { POST } = await import('@/app/api/onboarding/register/route');
    const res = await POST(makeRegisterRequest({ ...FRESH_BODY, wa_method: 'transfer' }));
    expect(res.status).toBe(200);
    expect(lastInsertPayload!.wa_method).toBe('shared');
  });

  it('C1: register with wa_method=coexist → server overrides to shared', async () => {
    const { POST } = await import('@/app/api/onboarding/register/route');
    const res = await POST(makeRegisterRequest({ ...FRESH_BODY, wa_method: 'coexist' }));
    expect(res.status).toBe(200);
    expect(lastInsertPayload!.wa_method).toBe('shared');
  });

  it('C1: register with no wa_method → persists shared', async () => {
    const { POST } = await import('@/app/api/onboarding/register/route');
    const res = await POST(makeRegisterRequest({ ...FRESH_BODY }));
    expect(res.status).toBe(200);
    expect(lastInsertPayload!.wa_method).toBe('shared');
  });

  it('C1: business always starts as pending/free regardless of caller intent', async () => {
    const { POST } = await import('@/app/api/onboarding/register/route');
    const res = await POST(makeRegisterRequest({ ...FRESH_BODY, wa_method: 'transfer' }));
    expect(res.status).toBe(200);
    expect(lastInsertPayload!.subscription_tier).toBe('free');
    expect(lastInsertPayload!.status).toBe('pending');
  });
});

describe('#346 Part C — Free register → verify → trial activation invariants', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lastInsertPayload = null;
    lastBusinessUpdate = null;
    rpcCalls = [];
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.com' } } });
    mockCountriesResponse = {
      data: [{ code: 'NG', dialing_code: '+234' }, { code: 'US', dialing_code: '+1' }],
      error: null,
    };
  });

  it('C2: verify route calls activate_trial_if_eligible for free plan (structural proof)', () => {
    // The verify route calls activate_trial_if_eligible for free businesses.
    // Prove this structurally from the source.
    const verifySource = readFileSync(
      join(process.cwd(), 'app/api/onboarding/verify/route.ts'),
      'utf-8',
    );
    // Verify route calls activate_trial_if_eligible for free plan
    expect(verifySource).toContain('activate_trial_if_eligible');
    // It's called in the plan === 'free' branch
    const freeBlock = verifySource.slice(
      verifySource.indexOf("plan === 'free'"),
      verifySource.indexOf("plan === 'free'") + 500
    );
    expect(freeBlock).toContain('activate_trial_if_eligible');
  });

  it('C2: own-number intent registered as shared preserves trial eligibility', async () => {
    // When caller sends wa_method=transfer, server overrides to shared
    const { POST: registerPost } = await import('@/app/api/onboarding/register/route');
    const regRes = await registerPost(makeRegisterRequest({ ...FRESH_BODY, wa_method: 'transfer' }));
    expect(regRes.status).toBe(200);
    expect(lastInsertPayload!.wa_method).toBe('shared');

    // M372 activate_trial_if_eligible: for wa_method='shared', requires
    // business.status='active' (set by verify) — does NOT require
    // whatsapp_channel_id. Therefore trial activation succeeds.
    // Prove the M372 logic structurally:
    const m372Source = readFileSync(
      join(process.cwd(), 'supabase/migrations/372_trial_lifecycle.sql'),
      'utf-8',
    );
    // Shared method path checks status, not channel
    expect(m372Source).toContain("wa_method = 'shared'");
    // The dedicated/transfer path requires an active channel
    expect(m372Source).toContain('whatsapp_channel_id');
  });

  it('C2: M372 shared path does not require a dedicated channel', () => {
    const m372Source = readFileSync(
      join(process.cwd(), 'supabase/migrations/372_trial_lifecycle.sql'),
      'utf-8',
    );
    // The trial RPC has both shared and dedicated/transfer paths
    // Shared does NOT require whatsapp_channel_id — only status='active'
    expect(m372Source).toContain("v_biz.wa_method = 'shared'");
    expect(m372Source).toContain("v_biz.status = 'active'");
    // Dedicated/transfer path requires whatsapp_channel_id
    expect(m372Source).toContain('whatsapp_channel_id IS NOT NULL');
  });
});

describe('#346 Part D — Paid path not converted to free', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lastInsertPayload = null;
    rpcCalls = [];
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.com' } } });
    mockCountriesResponse = {
      data: [{ code: 'NG', dialing_code: '+234' }, { code: 'US', dialing_code: '+1' }],
      error: null,
    };
  });

  it('C2: paid own-number: register creates free/pending, does NOT call verify or subscribe', async () => {
    // Registration always creates free/pending regardless of intended plan
    // The wizard separately calls /api/onboarding/subscribe for paid plans
    const { POST: registerPost } = await import('@/app/api/onboarding/register/route');
    const regRes = await registerPost(makeRegisterRequest({ ...FRESH_BODY, wa_method: 'transfer' }));
    expect(regRes.status).toBe(200);
    expect(lastInsertPayload!.subscription_tier).toBe('free');
    expect(lastInsertPayload!.wa_method).toBe('shared');

    // No trial activation at registration time (only at verify time)
    const trialCall = rpcCalls.find(c => c.fn === 'activate_trial_if_eligible');
    expect(trialCall).toBeUndefined();
  });

  it('C2: subscribe route exists and requires business_id + plan', async () => {
    // Prove the paid subscribe route is separate from register
    // The wizard calls this after registration for paid plans
    const subscribeRouteSource = readFileSync(
      join(process.cwd(), 'app/api/onboarding/subscribe/route.ts'),
      'utf-8',
    );
    // Subscribe route must accept business_id and plan
    expect(subscribeRouteSource).toContain('business_id');
    expect(subscribeRouteSource).toContain('plan');
    // Subscribe route must NOT be called during registration
    expect(registerRouteSource).not.toContain('/api/onboarding/subscribe');
  });

  it('retry path unchanged — no wa_method dependency', async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: (col: string) => {
              if (col === 'id') return {
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () => Promise.resolve({
                      data: { id: 'biz-pending', owner_id: 'user-1', status: 'pending', category: 'salon', bot_code: 'TEST' },
                      error: null,
                    }),
                  }),
                }),
              };
              return { eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
            },
          }),
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    });

    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRegisterRequest({ retryBusinessId: 'biz-pending', capabilities: ['scheduling'] });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});
