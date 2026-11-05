// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The real onboarding wizard: on staging the sign-up form asks for the invite
// code and sends it to /api/auth/staging-signup. Production shows no field.

const STAGING_SUPABASE_URL = 'https://tqjvrzopvtczxfxiwmnz.supabase.co';
const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/get-started',
}));
vi.mock('next/link', () => ({ default: ({ children, ...p }: any) => React.createElement('a', p, children) }));
vi.mock('next/image', () => ({ default: (p: any) => React.createElement('img', p) }));
vi.mock('framer-motion', () => {
  const passthrough = (tag: string) => React.forwardRef(function Mock(p: any, r: any) {
    const { whileHover, transition, animate, initial, exit, style, ...rest } = p;
    return React.createElement(tag, { ...rest, ref: r }, p.children);
  });
  return {
    motion: { div: passthrough('div'), svg: passthrough('svg'), path: passthrough('path'), span: passthrough('span'), p: passthrough('p') },
    AnimatePresence: ({ children }: any) => children,
    useScroll: () => ({ scrollYProgress: { get: () => 0 } }),
    useTransform: () => 0,
  };
});
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      ...auth,
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn().mockResolvedValue({}),
    },
    from: vi.fn(() => {
      const chain: any = {
        select: () => chain, eq: () => chain, limit: () => chain,
        single: async () => ({ data: null }), maybeSingle: async () => ({ data: null }),
      };
      return chain;
    }),
  }),
}));
vi.mock('@/lib/supabase/safe-view-query', () => ({ queryChannelsPublic: vi.fn().mockResolvedValue({ data: null }) }));
vi.mock('@/lib/posthog/client', () => ({ getPostHogClient: () => ({ capture: vi.fn(), identify: vi.fn() }) }));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ isLoaded: true }) }));
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
vi.mock('qrcode.react', () => ({ default: () => null, QRCodeSVG: () => null, QRCodeCanvas: () => null }));
vi.mock('@/components/ui/AddressAutocomplete', () => ({ default: () => null }));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: () => null }));

const fetchMock = vi.fn();
const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  auth.getUser.mockResolvedValue({ data: { user: null } });
  auth.signInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Invalid login credentials' } });
  auth.signUp.mockResolvedValue({ data: { user: null, session: null }, error: null });
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ message: 'That invite code is not valid.' }), { status: 403 }));
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
});

async function renderWizard() {
  const { OnboardingWizard } = await import('@/app/get-started/OnboardingWizard');
  render(React.createElement(OnboardingWizard));
  await screen.findByText('Create your account');
}

// Email and password are found by placeholder; the new field by its label.
const field = (name: string) => (name === 'Email' ? screen.getByPlaceholderText('you@example.com')
  : name === 'Password' ? screen.getByPlaceholderText('Min. 6 characters') : screen.getByLabelText(name));
function fill(name: string, value: string) {
  fireEvent.change(field(name), { target: { value } });
}

describe('onboarding wizard: staging invite code', () => {
  it('on staging, asks for the invite code and sends it with the sign-up', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', STAGING_SUPABASE_URL);
    await renderWizard();

    fill('Email', 'tester@example.com');
    fill('Password', 'secret123');
    fill('Staging invite code', '  c0ffee-staging-invite-2026 ');
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/staging-signup', expect.anything()));
    const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/auth/staging-signup')!;
    expect(JSON.parse(init.body)).toEqual({ email: 'tester@example.com', password: 'secret123', inviteCode: 'c0ffee-staging-invite-2026' });
    // The server's refusal is shown to the tester.
    expect(await screen.findByText('That invite code is not valid.')).toBeTruthy();
  });

  it('on staging, the invite code field is required', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', STAGING_SUPABASE_URL);
    await renderWizard();
    expect((screen.getByLabelText('Staging invite code') as HTMLInputElement).required).toBe(true);
  });

  it('in production, shows no invite code field and never calls the staging route', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://cxcmiqotkowhxinjbytg.supabase.co');
    await renderWizard();
    expect(screen.queryByLabelText('Staging invite code')).toBeNull();

    fill('Email', 'owner@example.com');
    fill('Password', 'secret123');
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(auth.signUp).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/staging-signup')).toBe(false);
  });
});
