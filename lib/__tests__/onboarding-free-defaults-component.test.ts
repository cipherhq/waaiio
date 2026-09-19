// @vitest-environment jsdom
/**
 * #341 — Component-level proof that onboarding category selection
 * replaces stale paid capabilities with free-only defaults,
 * and that the registration payload only contains free-tier capabilities.
 *
 * B2: Renders real StepCategory with mocked setters, clicks category
 *     selection paths, and asserts:
 *     - setSelectedCapabilities receives free-only defaults
 *     - setSelectedPlan('free') is called
 *     - personal-event shortcut included (B1 fix)
 *
 * B3: Full wizard path capturing /api/onboarding/register payload,
 *     proving capabilities = free-only with no paid auto-adds.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, act, waitFor, cleanup, fireEvent } from '@testing-library/react';
import {
  CAPABILITY_TIER_REQUIREMENTS,
  getOnboardingDefaultCapabilities,
  type CapabilityId,
} from '@/lib/capabilities/types';

// ─── Mocks required for both StepCategory and OnboardingWizard ───

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
    getCountryList: () => [{ code: 'NG', name: 'Nigeria', flag: '🇳🇬', currency_code: 'NGN', currency_symbol: '₦', currency_locale: 'en-NG' }],
    getCountry: () => ({ code: 'NG', name: 'Nigeria', currency_code: 'NGN', payment_gateway: 'paystack' }),
  };
});
vi.mock('@/lib/whatsapp/embedded-signup-config', () => ({ buildEmbeddedSignupLoginOptions: vi.fn(), extractAuthCode: vi.fn(), buildDiscoverRequestBody: vi.fn() }));
vi.mock('qrcode.react', () => ({ default: () => React.createElement('div', null, 'QR') }));
vi.mock('@/components/ui/AddressAutocomplete', () => ({
  default: (p: any) => React.createElement('input', {
    placeholder: 'Address',
    value: p.defaultValue || '',
    onChange: (e: any) => {
      p.onManualChange?.(e.target.value);
      // Also trigger onSelect to fill city/state/zip
      p.onSelect?.({ address: e.target.value, city: 'Lagos', state: 'Lagos', zipCode: '100001' });
    },
    'data-testid': 'address-input',
  }),
}));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: (p: any) => React.createElement('input', { value: p.value || '', onChange: (e: any) => p.onChange?.(e.target.value), 'data-testid': 'phone-input' }) }));

// ─── B2: StepCategory component tests ───

import { StepCategory } from '@/app/get-started/steps/StepCategory';

describe('StepCategory — category selection replaces stale paid state', () => {
  afterEach(() => cleanup());

  function renderStepCategory() {
    const setCategory = vi.fn();
    const setSelectedCapabilities = vi.fn();
    const setSelectedPlan = vi.fn();
    const setStep = vi.fn();

    const result = render(
      React.createElement(StepCategory, {
        selectedCountry: 'NG',
        setSelectedCountry: vi.fn(),
        countryList: [{ code: 'NG', name: 'Nigeria', flag: '🇳🇬', currency_code: 'NGN', currency_symbol: '₦', currency_locale: 'en-NG' }],
        setCity: vi.fn(),
        selectedGroup: null,
        setSelectedGroup: vi.fn(),
        category: '',
        setCategory,
        setSelectedCapabilities,
        setSelectedPlan,
        setStep,
      }),
    );

    return { container: result.container, setCategory, setSelectedCapabilities, setSelectedPlan, setStep };
  }

  it('personal-event shortcut sets free-only defaults and setSelectedPlan("free")', () => {
    const { container, setCategory, setSelectedCapabilities, setSelectedPlan, setStep } = renderStepCategory();

    const personalBtn = Array.from(container.querySelectorAll('button')).find(
      btn => btn.textContent?.includes('personal event'),
    );
    expect(personalBtn).toBeDefined();
    act(() => { personalBtn!.click(); });

    expect(setCategory).toHaveBeenCalledWith('events');

    const expectedDefaults = getOnboardingDefaultCapabilities('events');
    expect(setSelectedCapabilities).toHaveBeenCalledWith(expectedDefaults);
    for (const cap of expectedDefaults) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap]).toBe('free');
    }

    expect(setSelectedPlan).toHaveBeenCalledWith('free');
    expect(setStep).toHaveBeenCalledWith('features');
  });

  it('outcome→business-type selection sets free-only defaults and setSelectedPlan("free")', () => {
    const { container, setSelectedCapabilities, setSelectedPlan, setStep } = renderStepCategory();

    // Click "Collect payments" outcome
    const outcomeBtn = Array.from(container.querySelectorAll('button')).find(
      btn => btn.textContent?.includes('Collect payments'),
    );
    expect(outcomeBtn).toBeDefined();
    act(() => { outcomeBtn!.click(); });

    // Phase 2 now shows: Back button, sub-categories in a grid, and Other.
    // Sub-categories have class "border-gray-200 bg-white" in the grid.
    // Find buttons that are NOT Back, NOT Other, NOT country selector
    const gridDiv = container.querySelector('.grid');
    expect(gridDiv).not.toBeNull();
    const subCatBtns = Array.from(gridDiv!.querySelectorAll('button')).filter(btn => {
      const text = (btn.textContent || '').trim();
      return !text.includes('Other') && text.length > 0;
    });
    expect(subCatBtns.length).toBeGreaterThan(0);

    act(() => { subCatBtns[0].click(); });

    expect(setSelectedCapabilities).toHaveBeenCalled();
    const receivedCaps = setSelectedCapabilities.mock.calls[0][0] as CapabilityId[];
    for (const cap of receivedCaps) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap]).toBe('free');
    }
    expect(setSelectedPlan).toHaveBeenCalledWith('free');
    expect(setStep).toHaveBeenCalledWith('features');
  });

  it('"Other" fallback sets free-only defaults and setSelectedPlan("free")', () => {
    const { container, setSelectedCapabilities, setSelectedPlan, setStep } = renderStepCategory();

    const outcomeBtn = Array.from(container.querySelectorAll('button')).find(
      btn => btn.textContent?.includes('Collect payments'),
    );
    expect(outcomeBtn).toBeDefined();
    act(() => { outcomeBtn!.click(); });

    // Find Other in the grid
    const gridDiv = container.querySelector('.grid');
    expect(gridDiv).not.toBeNull();
    const otherBtn = Array.from(gridDiv!.querySelectorAll('button')).find(
      btn => (btn.textContent || '').includes('Other'),
    );
    expect(otherBtn).toBeDefined();
    act(() => { otherBtn!.click(); });

    expect(setSelectedCapabilities).toHaveBeenCalled();
    const receivedCaps = setSelectedCapabilities.mock.calls[0][0] as CapabilityId[];
    for (const cap of receivedCaps) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap]).toBe('free');
    }
    expect(setSelectedPlan).toHaveBeenCalledWith('free');
    expect(setStep).toHaveBeenCalledWith('features');
  });

  it('search selection sets free-only defaults and setSelectedPlan("free")', async () => {
    const { container, setSelectedCapabilities, setSelectedPlan, setStep } = renderStepCategory();

    const searchInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(searchInput).toBeDefined();

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'salon' } });
    });

    await waitFor(() => {
      const btns = Array.from(container.querySelectorAll('button')).filter(btn => {
        const text = (btn.textContent || '').toLowerCase();
        return text.includes('salon') || text.includes('barber');
      });
      expect(btns.length).toBeGreaterThan(0);
    });

    const resultBtn = Array.from(container.querySelectorAll('button')).find(btn => {
      const text = (btn.textContent || '').toLowerCase();
      return (text.includes('salon') || text.includes('barber')) && text.length < 50;
    });
    expect(resultBtn).toBeDefined();
    act(() => { resultBtn!.click(); });

    expect(setSelectedCapabilities).toHaveBeenCalled();
    const receivedCaps = setSelectedCapabilities.mock.calls[0][0] as CapabilityId[];
    for (const cap of receivedCaps) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap]).toBe('free');
    }
    expect(setSelectedPlan).toHaveBeenCalledWith('free');
    expect(setStep).toHaveBeenCalledWith('features');
  });
});

// ─── B3: Full wizard registration payload proof ───

const PRICING_FIXTURE = {
  trialDays: 14, annualDiscountPercentage: 25,
  tierFees: { free: { feePercentage: 3.0 }, growth: { feePercentage: 2.0 }, business: { feePercentage: 1.0 } },
  categoryFees: {}, byoFeePolicy: '0%',
  country: {
    code: 'NG', name: 'Nigeria', currencyCode: 'NGN', currencySymbol: '₦',
    currencyLocale: 'en-NG', flag: '🇳🇬', gateway: 'paystack',
    pricing: {
      free: { price: 0, feeFlat: 200, feePercentage: 3.0 },
      growth: { price: 25000, feeFlat: 75, feePercentage: 2.0 },
      business: { price: 70000, feeFlat: 100, feePercentage: 1.0 },
    },
  },
  countries: [{ code: 'NG', name: 'Nigeria', currencyCode: 'NGN', currencySymbol: '₦',
    currencyLocale: 'en-NG', flag: '🇳🇬', gateway: 'paystack',
    pricing: {
      free: { price: 0, feeFlat: 200, feePercentage: 3.0 },
      growth: { price: 25000, feeFlat: 75, feePercentage: 2.0 },
      business: { price: 70000, feeFlat: 100, feePercentage: 1.0 },
    },
  }],
};

const originalFetch = global.fetch;

function findButton(container: HTMLElement, pattern: RegExp): HTMLElement {
  const btns = Array.from(container.querySelectorAll('button'));
  const btn = btns.find(b => pattern.test(b.textContent || ''));
  if (!btn) throw new Error(`Button matching ${pattern} not found. Available: ${btns.map(b => (b.textContent || '').slice(0, 40)).join(' | ')}`);
  return btn;
}

describe('OnboardingWizard — registration payload contains only free-tier capabilities', () => {
  let registerPayloads: Array<{ url: string; body: any }> = [];

  beforeEach(() => {
    registerPayloads = [];
    (window as any).FB = undefined;
    Object.defineProperty(window, 'location', {
      value: { search: '', href: 'http://localhost/get-started', pathname: '/get-started' },
      writable: true, configurable: true,
    });

    global.fetch = vi.fn(async (url: string, init?: any) => {
      if (typeof url === 'string' && url.includes('/api/public/pricing')) {
        return new Response(JSON.stringify(PRICING_FIXTURE), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (typeof url === 'string' && url.includes('/api/onboarding/check-name')) {
        return new Response(JSON.stringify({ slug_available: true, code_available: true, suggested_code: 'TEST-BIZ', bot_code: 'TEST-BIZ' }), { status: 200 });
      }
      if (typeof url === 'string' && url.includes('/api/onboarding/register')) {
        const body = init?.body ? JSON.parse(init.body) : {};
        registerPayloads.push({ url, body });
        return new Response(JSON.stringify({ business_id: 'biz-123', bot_code: 'TEST-BIZ' }), { status: 200 });
      }
      if (typeof url === 'string' && url.includes('/api/onboarding/verify')) {
        return new Response(JSON.stringify({ bot_code: 'TEST-BIZ', business_id: 'biz-123' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    cleanup();
    vi.clearAllMocks();
  });

  it('registration payload capabilities are free-only after category selection (no paid auto-adds)', async () => {
    const { OnboardingWizard } = await import('@/app/get-started/OnboardingWizard');
    let container!: HTMLElement;
    await act(async () => {
      const result = render(React.createElement(OnboardingWizard));
      container = result.container;
    });

    // Wait for category step
    await waitFor(() => {
      if (!(container.textContent || '').includes('Which country are you in')) throw new Error('Not on category step');
    }, { timeout: 3000 });

    // Use the personal-event shortcut (simplest path to features with known category)
    const personalBtn = Array.from(container.querySelectorAll('button')).find(
      btn => (btn.textContent || '').includes('personal event'),
    );
    expect(personalBtn).toBeDefined();
    await act(async () => { personalBtn!.click(); });

    // Wait for features step
    await waitFor(() => {
      if (!(container.textContent || '').includes('set up for you')) throw new Error('Not on features step');
    }, { timeout: 3000 });

    // Click "Start Free Trial" to advance to details
    await act(async () => { findButton(container, /Start Free Trial/).click(); });

    // Wait for details step
    await waitFor(() => {
      if (!(container.textContent || '').includes('First Name')) throw new Error('Not on details step');
    }, { timeout: 3000 });

    // Fill required form fields by placeholder
    const getInput = (placeholder: string) =>
      container.querySelector(`input[placeholder*="${placeholder}"]`) as HTMLInputElement;

    // First Name, Last Name
    await act(async () => { fireEvent.change(getInput('Ayodeji'), { target: { value: 'Test' } }); });
    await act(async () => { fireEvent.change(getInput('Ogunleye'), { target: { value: 'User' } }); });

    // Business/event name (triggers handleNameChange → check-name)
    await act(async () => { fireEvent.change(getInput('Name or Brand'), { target: { value: 'Test Event Biz' } }); });

    // Address (mocked AddressAutocomplete — onSelect also fills city/state/zip)
    const addrInput = container.querySelector('[data-testid="address-input"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(addrInput, { target: { value: '123 Test St' } }); });

    // Phone (mocked PhoneInput)
    const phoneInput = container.querySelector('[data-testid="phone-input"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(phoneInput, { target: { value: '+2348012345678' } }); });

    // Wait for check-name debounce (500ms in wizard)
    await act(async () => { await new Promise(r => setTimeout(r, 600)); });

    // Check all checkboxes (terms + data processing)
    const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
    for (const cb of checkboxes) {
      if (!(cb as HTMLInputElement).checked) {
        await act(async () => { fireEvent.click(cb); });
      }
    }

    // Click "Start Free Trial" on details step to trigger handleRegister
    await act(async () => { findButton(container, /Start Free Trial/).click(); });

    // Wait for register call
    await waitFor(() => {
      expect(registerPayloads.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    // Assert: capabilities in payload are free-only
    const payload = registerPayloads[0].body;
    expect(payload.capabilities).toBeDefined();
    expect(Array.isArray(payload.capabilities)).toBe(true);
    expect(payload.capabilities.length).toBeGreaterThan(0);

    // Every capability must be free-tier
    for (const cap of payload.capabilities) {
      const tier = CAPABILITY_TIER_REQUIREMENTS[cap as CapabilityId];
      expect(tier).toBe('free');
    }

    // No Pro/Premium capability was auto-added
    const paidCaps = payload.capabilities.filter(
      (cap: string) => {
        const tier = CAPABILITY_TIER_REQUIREMENTS[cap as CapabilityId];
        return tier === 'growth' || tier === 'business';
      },
    );
    expect(paidCaps).toEqual([]);

    // Verify the selected capabilities match the expected events free defaults
    const expectedEventsCaps = getOnboardingDefaultCapabilities('events');
    expect(payload.capabilities).toEqual(expectedEventsCaps);
  }, 15000);
});
