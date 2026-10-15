// @vitest-environment jsdom
/**
 * #456 — Client-side proof that a resumed onboarding URL
 * (?step=details&business_id=xxx) results in check-name fetch
 * including business_id, preventing self-collision.
 *
 * Strategy: mock useOnboardingPersistence to restore a draft at the
 * 'details' step (deterministic — no heuristic UI navigation).
 * The URL provides business_id; auth init captures it into businessId.
 * Draft restore does NOT set pendingBusinessId, so the only source of
 * business_id for check-name is the URL-derived businessId state.
 *
 * This complements the server-side route tests in check-name-self-collision.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act, cleanup, fireEvent } from '@testing-library/react';

const PENDING_BIZ_ID = 'biz-pending-resumed-456';

// Flag for draft restore mock — must be declared before afterEach
let draftRestored = false;

// ── Set URL before any imports that read window.location ──
const originalLocation = window.location;
beforeEach(() => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: {
      ...originalLocation,
      search: `?step=details&business_id=${PENDING_BIZ_ID}`,
      href: `http://localhost/get-started?step=details&business_id=${PENDING_BIZ_ID}`,
      origin: 'http://localhost',
      pathname: '/get-started',
      hash: '',
      host: 'localhost',
      hostname: 'localhost',
      port: '',
      protocol: 'http:',
      assign: vi.fn(),
      reload: vi.fn(),
      replace: vi.fn(),
      toString: () => `http://localhost/get-started?step=details&business_id=${PENDING_BIZ_ID}`,
    },
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { writable: true, value: originalLocation });
  cleanup();
  fetchCalls.length = 0;
  draftRestored = false;
});

// ── Track fetch calls ──
const fetchCalls: { url: string; init?: RequestInit }[] = [];
global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  fetchCalls.push({ url, init });

  if (url.includes('/api/onboarding/check-name')) {
    return new Response(JSON.stringify({
      available: true,
      slug: 'test-biz',
      bot_code: 'TEST-BIZ',
      suggested_code: 'TEST-BIZ',
      code_available: true,
      slug_available: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as any;

// ── Mocks ──
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/get-started',
}));
vi.mock('next/link', () => ({ default: ({ children, ...p }: any) => React.createElement('a', p, children) }));
vi.mock('next/image', () => ({ default: (p: any) => React.createElement('img', p) }));

const MockMotionDiv = React.forwardRef(function MockMotionDiv(p: any, r: any) {
  return React.createElement('div', { ...p, ref: r, whileHover: undefined, transition: undefined, animate: undefined, initial: undefined, exit: undefined, style: undefined }, p.children);
});
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

// Mock useOnboardingPersistence to restore a draft directly at the 'details' step.
// This is deterministic — no heuristic UI button clicking needed.
// Critically, pendingBusinessId is NOT set — the only source of business_id
// for check-name must be the URL-derived businessId state.
vi.mock('@/hooks/useOnboardingPersistence', () => ({
  useOnboardingPersistence: (_user: any, _state: any, restore: Function) => {
    // Call restore once after first invocation (the hook is called on every render)
    if (!draftRestored) {
      draftRestored = true;
      setTimeout(() => {
        restore({
          step: 'details',
          selectedCountry: 'NG',
          city: 'Lagos',
          state: 'Lagos',
          zipCode: '100001',
          selectedGroup: null,
          category: 'restaurant',
          selectedCapabilities: [],
          businessName: '',
          firstName: '',
          lastName: '',
          address: '123 Test St',
          phone: '+2341234567890',
          email: 'test@test.com',
          customBotCode: '',
          selectedPlan: 'free',
          waMethod: 'shared',
          // pendingBusinessId intentionally omitted — test proves URL-derived businessId works
          savedAt: Date.now(),
        });
      }, 10);
    }
  },
  clearOnboardingDraft: vi.fn(),
}));

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
    onChange: (e: any) => { p.onManualChange?.(e.target.value); },
    'data-testid': 'address-input',
  }),
}));
vi.mock('@/components/auth/PhoneInput', () => ({
  PhoneInput: (p: any) => React.createElement('input', { value: p.value || '', onChange: (e: any) => p.onChange?.(e.target.value), 'data-testid': 'phone-input' }),
}));

// ── Import wizard directly (not via next/dynamic page wrapper) ──
const { OnboardingWizard } = await import('@/app/get-started/OnboardingWizard');

describe('#456 — resumed-URL details flow sends business_id to check-name', () => {
  it('?step=details&business_id=xxx → check-name fetch includes business_id param', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    let container: HTMLElement;
    await act(async () => {
      const result = render(React.createElement(OnboardingWizard));
      container = result.container;
    });

    // Wait for auth init + draft restore to complete
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // The wizard should now be at the 'details' step (restored by mock draft).
    // Find the business name input — StepDetails renders it with a placeholder
    // containing "Business Name" or category-specific text like "Bukka Hut".
    const nameInput = container!.querySelector('input[placeholder*="Business" i]')
      || container!.querySelector('input[placeholder*="Brand" i]')
      || container!.querySelector('input[placeholder*="Bukka" i]')
      || container!.querySelector('input[placeholder*="Name" i]');

    // MUST find the name input — no silent pass without assertion
    expect(nameInput, 'Name input must be found on the details step').toBeTruthy();

    // Type a business name to trigger check-name
    await act(async () => {
      fireEvent.change(nameInput!, { target: { value: 'Test Business' } });
    });

    // Advance past the 500ms debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    // MUST find the check-name fetch call — no silent pass
    const checkNameCall = fetchCalls.find(c => c.url.includes('/api/onboarding/check-name'));
    expect(checkNameCall, 'check-name fetch must have been called').toBeDefined();

    // The URL must include business_id from the resumed URL (not pendingRetryId)
    expect(checkNameCall!.url).toContain(`business_id=${PENDING_BIZ_ID}`);

    vi.useRealTimers();
  });
});
