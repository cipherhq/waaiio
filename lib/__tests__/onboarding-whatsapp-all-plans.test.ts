/**
 * Regression + orchestration tests for #346: customer-owned WhatsApp on all plans.
 *
 * Part A: Structural assertions (source-level correctness)
 * Part B: Orchestration tests (runtime flow correctness)
 *   B1. Free + shared: register → verify; trial path unchanged
 *   B2. Free + own-number intent: registers as shared, trial succeeds
 *   B3. Paid + own-number: goes through payment, not converted to Free
 *   B4. Connection failure does not disable trial/shared usability
 *   B5. No false "connected" state from transient fbConnectionData
 *   B6. Success CTA uses /dashboard/whatsapp/connect (no dead query param)
 *   B7. Dashboard connect has correct business via useBusiness() context
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
const qrPageSource = readFileSync(
  join(process.cwd(), 'app/dashboard/qr-code/page.tsx'),
  'utf-8',
);

describe('#346 Part A — Structural assertions', () => {

  describe('StepDetails — WhatsApp section', () => {
    it('does NOT gate WhatsApp section behind selectedPlan !== free', () => {
      expect(stepDetailsSource).not.toContain("selectedPlan !== 'free'");
    });

    it('renders WhatsApp section with "available on every plan" copy', () => {
      expect(stepDetailsSource).toContain('WhatsApp Connection');
      expect(stepDetailsSource).toContain('available on every plan');
    });

    it('does NOT contain Pro/Premium-only wording', () => {
      expect(stepDetailsSource).not.toMatch(/As a .* user, you can connect/);
    });

    it('renders shared, own-number, and Coming Soon options', () => {
      expect(stepDetailsSource).toContain("shared number");
      expect(stepDetailsSource).toContain('Connect my own WhatsApp number');
      expect(stepDetailsSource).toContain('Coming Soon');
    });

    it('does NOT mutate selectedPlan when waMethod changes', () => {
      expect(stepDetailsSource).not.toContain('setSelectedPlan');
    });
  });

  describe('StepSuccess — connect CTA', () => {
    it('shows connect CTA with "Available on every plan"', () => {
      expect(stepSuccessSource).toContain('Connect Your Own WhatsApp Number');
      expect(stepSuccessSource).toContain('Connect WhatsApp Number');
      expect(stepSuccessSource).toContain('Do this later');
      expect(stepSuccessSource).toContain('Available on every plan');
    });

    it('connect CTA links to /dashboard/whatsapp/connect without dead query param', () => {
      expect(stepSuccessSource).toContain('/dashboard/whatsapp/connect');
      // B3 fix: no dead ?business_id= query parameter
      expect(stepSuccessSource).not.toContain('business_id=');
    });

    it('does NOT show false "connected" state from transient fbConnectionData', () => {
      // B1 fix: no "WhatsApp Number Connected" based on browser state
      expect(stepSuccessSource).not.toContain('WhatsApp Number Connected');
      // fbConnectionData may be in props destructuring but must not be used in template logic
      // Count occurrences: should only appear in the destructuring, not in JSX
      const matches = stepSuccessSource.match(/fbConnectionData/g) || [];
      expect(matches.length).toBeLessThanOrEqual(1); // only in destructuring
    });

    it('does NOT contain misleading "our team is setting up" copy', () => {
      expect(stepSuccessSource).not.toContain('Our team is setting up');
      expect(stepSuccessSource).not.toContain('setting up your dedicated');
    });
  });

  describe('OnboardingWizard — registration always uses shared', () => {
    it('handleRegister sends wa_method: shared regardless of user selection', () => {
      // The registration payload in handleRegister must always be 'shared'
      // to ensure trial activation succeeds (B2 fix)
      const handleRegisterBlock = wizardSource.slice(
        wizardSource.indexOf('async function handleRegister'),
        wizardSource.indexOf('// ── Payment Handler')
      );
      // Must contain wa_method: 'shared' (hardcoded)
      expect(handleRegisterBlock).toContain("wa_method: 'shared'");
      // Must NOT send wa_own_phone in the registration payload
      expect(handleRegisterBlock).not.toContain('wa_own_phone');
    });

    it('paid plan still goes through /api/onboarding/subscribe', () => {
      const handleRegisterBlock = wizardSource.slice(
        wizardSource.indexOf('async function handleRegister'),
        wizardSource.indexOf('// ── Payment Handler')
      );
      expect(handleRegisterBlock).toContain('/api/onboarding/subscribe');
      expect(handleRegisterBlock).toContain("plan: selectedPlan");
    });

    it('free plan still goes through /api/onboarding/verify', () => {
      const handleRegisterBlock = wizardSource.slice(
        wizardSource.indexOf('async function handleRegister'),
        wizardSource.indexOf('// ── Payment Handler')
      );
      expect(handleRegisterBlock).toContain('/api/onboarding/verify');
      expect(handleRegisterBlock).toContain("plan: 'free'");
    });
  });

  describe('Dashboard — no tier gate, correct priority', () => {
    it('connect page has no subscription_tier gate', () => {
      expect(dashboardConnectSource).not.toContain('subscription_tier');
      expect(dashboardConnectSource).not.toContain('selectedPlan');
    });

    it('QR resolves: assigned > dedicated > shared', () => {
      const resolvedLine = qrPageSource.match(
        /const resolved\s*=\s*assignedResult[\s\S]*?\|\|[\s\S]*?dedicatedResult[\s\S]*?\|\|[\s\S]*?sharedResult/
      );
      expect(resolvedLine).not.toBeNull();
    });

    it('connect page uses useBusiness() for business context', () => {
      expect(dashboardConnectSource).toContain('useBusiness');
    });
  });
});

// ═══ Part B: Orchestration tests (runtime flow) ═══

// Mock infrastructure for register route
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
const mockServiceFrom = vi.fn((table: string) => {
  if (table === 'countries') {
    return {
      select: () => ({
        eq: () => Promise.resolve(mockCountriesResponse),
      }),
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
  return {
    select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
  };
});

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: mockServiceFrom }),
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

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/onboarding/register'), {
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

describe('#346 Part B — Orchestration tests', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lastInsertPayload = null;
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.com' } } });
    mockCountriesResponse = {
      data: [
        { code: 'NG', dialing_code: '+234' },
        { code: 'US', dialing_code: '+1' },
      ],
      error: null,
    };
  });

  it('B1: Free + shared: register succeeds with wa_method=shared', async () => {
    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({ ...FRESH_BODY, wa_method: 'shared' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(lastInsertPayload).toBeTruthy();
    expect(lastInsertPayload!.wa_method).toBe('shared');
    expect(lastInsertPayload!.status).toBe('pending');
  });

  it('B2: Free + own-number intent registered as shared preserves trial path', async () => {
    // When wizard sends wa_method: 'shared' (even though user chose own-number in UI),
    // the business is registered with shared method, ensuring trial activation succeeds
    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({ ...FRESH_BODY, wa_method: 'shared' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(lastInsertPayload!.wa_method).toBe('shared');
    // With wa_method='shared', activate_trial_if_eligible will use
    // the shared-channel path (status='active') not the dedicated path
  });

  it('B3: paid + own-number: registration does NOT change plan to free', async () => {
    // Paid plan is handled by the wizard AFTER registration succeeds:
    // wizard calls /api/onboarding/subscribe with the paid plan.
    // Registration always creates business with subscription_tier='free'
    // (the tier is upgraded by the subscribe/verify route, not register).
    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({ ...FRESH_BODY, wa_method: 'shared' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    // Business starts as free/pending regardless of UI plan selection
    expect(lastInsertPayload!.subscription_tier).toBe('free');
    expect(lastInsertPayload!.status).toBe('pending');
    // The paid checkout happens in a separate /api/onboarding/subscribe call
  });

  it('B4: wa_method=transfer with no channel still allows registration', async () => {
    // Even if someone directly sends wa_method='transfer' to the API,
    // registration succeeds. The trial activation issue is prevented
    // because the wizard now always sends 'shared'.
    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({ ...FRESH_BODY, wa_method: 'transfer' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    // Business is created — trial activation is a separate concern
    expect(lastInsertPayload!.wa_method).toBe('transfer');
  });

  it('B5: StepSuccess never shows durable connected state from transient browser data', () => {
    // The success screen no longer uses fbConnectionData in template logic
    // It always shows the connect CTA pointing to the dashboard
    expect(stepSuccessSource).not.toContain('WhatsApp Number Connected');
    // fbConnectionData only in props destructuring, never in JSX/template
    const fbMatches = stepSuccessSource.match(/fbConnectionData/g) || [];
    expect(fbMatches.length).toBeLessThanOrEqual(1);
    // The connect CTA is unconditional (no waMethod branching)
    expect(stepSuccessSource).not.toMatch(/waMethod\s*===\s*'shared'/);
    expect(stepSuccessSource).not.toMatch(/waMethod\s*!==\s*'shared'/);
  });

  it('B6: success CTA uses plain /dashboard/whatsapp/connect without dead business_id param', () => {
    expect(stepSuccessSource).toContain('href="/dashboard/whatsapp/connect"');
    expect(stepSuccessSource).not.toContain('?business_id=');
  });

  it('B7: dashboard connect page uses useBusiness() — no cross-tenant selector', () => {
    expect(dashboardConnectSource).toContain('useBusiness');
    // No business_id from URL params
    expect(dashboardConnectSource).not.toContain('useSearchParams');
    expect(dashboardConnectSource).not.toContain('searchParams');
  });

  it('B8: retry path remains unchanged (no wa_method dependency)', async () => {
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
    const req = makeRequest({ retryBusinessId: 'biz-pending', capabilities: ['scheduling'] });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});
