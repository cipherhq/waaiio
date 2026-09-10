// @vitest-environment jsdom
/**
 * #270 — OnboardingWizard pricing lifecycle: hermetic runtime proof
 *
 * Renders the ACTUAL OnboardingWizard in jsdom with mocked deps,
 * controls /api/public/pricing, navigates the real UI, and proves:
 * 1. Failed pricing → features step shows "Pricing temporarily unavailable", no constants prices
 * 2. Malformed 200 → same fail-closed behavior
 * 3. Successful pricing → features step shows exact DB fixture prices/fees, progression enabled
 * 4. Successful pricing → clicking Continue reaches details step with DB-derived CTA
 *
 * The wizard flow is: auth → category → features → details → success.
 * The features step is the first pricing-dependent boundary (shows tier prices).
 * The details step shows the pay CTA with the plan price.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, act, waitFor, cleanup } from '@testing-library/react';

// ─── Mock all external deps BEFORE importing OnboardingWizard ───

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/get-started',
}));
vi.mock('next/link', () => ({ default: ({ children, ...p }: any) => React.createElement('a', p, children) }));
vi.mock('next/image', () => ({ default: (p: any) => React.createElement('img', p) }));
const MockMotionDiv = React.forwardRef(function MockMotionDiv(p: any, r: any) { return React.createElement('div', { ...p, ref: r, whileHover: undefined, transition: undefined, animate: undefined, initial: undefined, exit: undefined, style: undefined }, p.children); });
const MockMotionSvg = React.forwardRef(function MockMotionSvg(p: any, r: any) { return React.createElement('svg', { ...p, ref: r, animate: undefined, transition: undefined }, p.children); });
const MockMotionPath = React.forwardRef(function MockMotionPath(p: any, r: any) { return React.createElement('path', { ...p, ref: r }, p.children); });
const MockMotionSpan = React.forwardRef(function MockMotionSpan(p: any, r: any) { return React.createElement('span', { ...p, ref: r }, p.children); });
const MockMotionP = React.forwardRef(function MockMotionP(p: any, r: any) { return React.createElement('p', { ...p, ref: r }, p.children); });
vi.mock('framer-motion', () => ({
  motion: { div: MockMotionDiv, svg: MockMotionSvg, path: MockMotionPath, span: MockMotionSpan, p: MockMotionP },
  AnimatePresence: function MockAnimatePresence({ children }: any) { return children; },
  useScroll: () => ({ scrollYProgress: { get: () => 0 } }),
  useTransform: () => 0,
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1', email: 'test@test.com' } } }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn().mockResolvedValue({}),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: null }), maybeSingle: vi.fn().mockResolvedValue({ data: null }) })),
          single: vi.fn().mockResolvedValue({ data: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
          limit: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) })),
        })),
        limit: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) })),
      })),
    })),
  }),
}));
vi.mock('@/lib/supabase/safe-view-query', () => ({ queryChannelsPublic: vi.fn().mockResolvedValue({ data: null }) }));
vi.mock('@/lib/posthog/client', () => ({ getPostHogClient: () => ({ capture: vi.fn(), identify: vi.fn() }) }));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => {} }));
vi.mock('@/hooks/useOnboardingPersistence', () => ({ useOnboardingPersistence: vi.fn(), clearOnboardingDraft: vi.fn() }));
vi.mock('@/lib/countries', async (importOriginal) => {
  const orig = await importOriginal() as any;
  return {
    ...orig,
    loadCountries: vi.fn().mockResolvedValue(undefined),
    getCountryList: () => [{ code: 'NG', name: 'Nigeria', flag: '\ud83c\uddf3\ud83c\uddec', currency_code: 'NGN', currency_symbol: '\u20A6', currency_locale: 'en-NG' }],
    getCountry: () => ({ code: 'NG', name: 'Nigeria', currency_code: 'NGN', payment_gateway: 'paystack' }),
  };
});
vi.mock('@/lib/whatsapp/embedded-signup-config', () => ({ buildEmbeddedSignupLoginOptions: vi.fn(), extractAuthCode: vi.fn(), buildDiscoverRequestBody: vi.fn() }));
vi.mock('qrcode.react', () => ({ default: () => React.createElement('div', null, 'QR') }));
vi.mock('@/components/ui/AddressAutocomplete', () => ({ default: (p: any) => React.createElement('input', { placeholder: 'Addr', value: p.defaultValue || '' }) }));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: (p: any) => React.createElement('input', { value: p.value || '', onChange: (e: any) => p.onChange?.(e.target.value) }) }));

// ─── Fixture ───

const PRICING_FIXTURE = {
  trialDays: 14, annualDiscountPercentage: 25,
  tierFees: { free: { feePercentage: 3.0 }, growth: { feePercentage: 2.0 }, business: { feePercentage: 1.0 } },
  categoryFees: {}, byoFeePolicy: '0%',
  country: {
    code: 'NG', name: 'Nigeria', currencyCode: 'NGN', currencySymbol: '\u20A6',
    currencyLocale: 'en-NG', flag: '\ud83c\uddf3\ud83c\uddec', gateway: 'paystack',
    pricing: {
      free: { price: 0, feeFlat: 200, feePercentage: 3.0 },
      growth: { price: 25000, feeFlat: 75, feePercentage: 2.0 },
      business: { price: 70000, feeFlat: 100, feePercentage: 1.0 },
    },
  },
  countries: [{ code: 'NG', name: 'Nigeria', currencyCode: 'NGN', currencySymbol: '\u20A6',
    currencyLocale: 'en-NG', flag: '\ud83c\uddf3\ud83c\uddec', gateway: 'paystack',
    pricing: {
      free: { price: 0, feeFlat: 200, feePercentage: 3.0 },
      growth: { price: 25000, feeFlat: 75, feePercentage: 2.0 },
      business: { price: 70000, feeFlat: 100, feePercentage: 1.0 },
    },
  }],
};

// ─── Helpers ───

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function setupFetch(mode: 'success' | 'fail-503' | 'malformed-200') {
  fetchMock = vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/public/pricing')) {
      if (mode === 'fail-503') {
        return new Response(JSON.stringify({ error: 'pricing_unavailable' }), { status: 503 });
      }
      if (mode === 'malformed-200') {
        // 200 but missing required fields — wizard should treat as unavailable
        return new Response(JSON.stringify({ trialDays: null, country: {} }), { status: 200 });
      }
      return new Response(JSON.stringify(PRICING_FIXTURE), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  });
  global.fetch = fetchMock;
}

function findButton(container: HTMLElement, textMatch: RegExp): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find(b =>
    textMatch.test(b.textContent || '')
  );
  if (!btn) throw new Error(`Button matching ${textMatch} not found. Page text: ${(container.textContent || '').slice(0, 500)}`);
  return btn as HTMLButtonElement;
}

function assertTextPresent(container: HTMLElement, text: string) {
  const content = container.textContent || '';
  if (!content.includes(text)) {
    throw new Error(`Expected "${text}" in page. Got: ${content.slice(0, 500)}`);
  }
}

function assertTextAbsent(container: HTMLElement, text: string) {
  const content = container.textContent || '';
  if (content.includes(text)) {
    throw new Error(`"${text}" should NOT appear in page. Found in: ${content.slice(0, 500)}`);
  }
}

async function renderWizardOnCategoryStep() {
  vi.resetModules();
  const mod = await import('@/app/get-started/OnboardingWizard');
  let container!: HTMLElement;
  await act(async () => {
    const result = render(React.createElement(mod.OnboardingWizard));
    container = result.container;
  });
  // Non-conditional: wizard MUST reach category step after auth
  await waitFor(() => assertTextPresent(container, 'Which country are you in'), { timeout: 3000 });
  return container;
}

async function navigateCategoryToFeatures(container: HTMLElement) {
  // Click "Collect payments" group — must exist
  const groupBtn = findButton(container, /Collect payments/);
  await act(async () => { groupBtn.click(); });

  // After clicking a group, sub-categories appear. Click the first one (e.g., "Parking")
  await waitFor(() => {
    findButton(container, /Parking|School fees|Bills|Churches|Markets/);
  }, { timeout: 2000 });

  const subCatBtn = findButton(container, /Parking|School fees|Bills|Churches|Markets/);
  await act(async () => { subCatBtn.click(); });

  // Wizard should now be on features step — either the real content or the pricing gate
  // Both prove we navigated past category. Wait for either to appear.
  await waitFor(() => {
    const text = container.textContent || '';
    const onFeaturesStep = text.includes("what we\u2019ll set up") || text.includes("what we'll set up") ||
                           text.includes('Pricing temporarily unavailable') || text.includes('Loading pricing');
    if (!onFeaturesStep) throw new Error('Not on features step yet');
  }, { timeout: 2000 });
}

// ─── Tests ───

describe('OnboardingWizard — pricing lifecycle proof', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    cleanup();
    vi.clearAllMocks();
  });

  beforeEach(() => {
    (window as any).FB = undefined;
    Object.defineProperty(window, 'location', {
      value: { search: '', href: 'http://localhost/get-started', pathname: '/get-started' },
      writable: true, configurable: true,
    });
  });

  it('failed pricing (503) → features step shows "Pricing temporarily unavailable", no constants prices', async () => {
    setupFetch('fail-503');
    const container = await renderWizardOnCategoryStep();
    await navigateCategoryToFeatures(container);

    // Non-conditional: features step must show the pricing-unavailable gate
    await waitFor(() => assertTextPresent(container, 'Pricing temporarily unavailable'), { timeout: 2000 });

    // No constants NG prices anywhere
    assertTextAbsent(container, '\u20A620,000');
    assertTextAbsent(container, '\u20A660,000');
    // No constants fee percentages
    assertTextAbsent(container, '2.5%');
    assertTextAbsent(container, '1.5%');
  });

  it('malformed 200 → features step shows "Pricing temporarily unavailable"', async () => {
    setupFetch('malformed-200');
    const container = await renderWizardOnCategoryStep();
    await navigateCategoryToFeatures(container);

    // Non-conditional: malformed projection → fail-closed
    await waitFor(() => assertTextPresent(container, 'Pricing temporarily unavailable'), { timeout: 2000 });

    assertTextAbsent(container, '\u20A620,000');
    assertTextAbsent(container, '\u20A660,000');
  });

  it('successful pricing \u2192 features step shows DB fixture prices, not constants', async () => {
    setupFetch('success');
    const container = await renderWizardOnCategoryStep();
    await navigateCategoryToFeatures(container);

    // Non-conditional: features step must render the real component, NOT the pricing gate
    await waitFor(() => assertTextPresent(container, 'set up for you'), { timeout: 2000 });

    const text = container.textContent || '';
    // Must NOT show "Pricing temporarily unavailable"
    assertTextAbsent(container, 'Pricing temporarily unavailable');

    // DB fixture business price (70,000) must appear in the "Requires Premium" label
    // (parking category defaults to premium-tier capabilities)
    expect(text).toContain('70,000');
    // DB fixture business fee (1%) must appear
    expect(text).toContain('1%');
    // Constants NG business price (\u20A660,000) must NOT appear
    expect(text).not.toContain('\u20A660,000');
  });

  it('successful pricing \u2192 Continue reaches details with DB-derived paid CTA + progression enabled', async () => {
    setupFetch('success');
    const container = await renderWizardOnCategoryStep();
    await navigateCategoryToFeatures(container);

    // Non-conditional: features step real content must be present
    await waitFor(() => assertTextPresent(container, 'set up for you'), { timeout: 2000 });

    // Click the Continue/Start button to advance to details step
    const continueBtn = findButton(container, /Start Free Trial|Continue/);
    await act(async () => { continueBtn.click(); });

    // Non-conditional: must arrive at details step (has First Name form field)
    await waitFor(() => assertTextPresent(container, 'First Name'), { timeout: 2000 });

    const text = container.textContent || '';

    // Parking category defaults to business tier. The details CTA must show
    // the DB fixture business price (70,000), NOT constants (60,000).
    expect(text).toContain('70,000');
    expect(text).not.toContain('\u20A660,000');

    // The paid-plan CTA ("Pay \u20A670,000/mo & Launch") proves the paid
    // pricing-dependent path is enabled with DB authority and progression works
    expect(text).toContain('Pay');
    expect(text).toContain('Launch');
  });
});
