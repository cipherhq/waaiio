// @vitest-environment jsdom
/**
 * #1175 F6, F7 (W3, W4) on the rendered pages where a merchant chooses a new
 * password: set new password, account activation and sign-up.
 * (Settings > change password: app/dashboard/settings/tabs/__tests__/account-tab-password-change.test.tsx.)
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthWeakPasswordError } from '@supabase/auth-js';

const W3 = 'Use at least 8 characters.';
const W4 = "This password has appeared in a data breach elsewhere, so it isn't safe. Please choose a different one.";

const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  updateUser: vi.fn(),
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
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ count: 0, data: null }).then(resolve),
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
const breach = () => new AuthWeakPasswordError('Password is known to be weak and easy to guess', 422, ['pwned']);

beforeEach(() => {
  vi.clearAllMocks();
  auth.getUser.mockResolvedValue({ data: { user: null } });
  auth.signInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Invalid login credentials' } });
  auth.signUp.mockResolvedValue({ data: { user: null, session: null }, error: null });
  auth.updateUser.mockResolvedValue({ data: {}, error: null });
  fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
  global.fetch = fetchMock as unknown as typeof fetch;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://cxcmiqotkowhxinjbytg.supabase.co');
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
});

describe('set new password page', () => {
  async function renderPage() {
    const { default: Page } = await import('@/app/(auth)/reset-password/page');
    render(React.createElement(Page));
  }
  function submit(password: string) {
    fireEvent.change(screen.getByPlaceholderText('Min. 8 characters'), { target: { value: password } });
    fireEvent.change(screen.getByPlaceholderText('Repeat your password'), { target: { value: password } });
    fireEvent.submit(screen.getByRole('button', { name: 'Update Password' }).closest('form')!);
  }

  it('shows W3 before typing, refuses 7 characters with W3, and never calls Supabase', async () => {
    await renderPage();
    expect(screen.getByText(W3)).toBeTruthy();
    expect((screen.getByPlaceholderText('Min. 8 characters') as HTMLInputElement).minLength).toBe(8);
    submit('seven77');
    expect((await screen.findByRole('alert')).textContent).toBe(W3);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('accepts 8 characters', async () => {
    await renderPage();
    submit('eight888');
    await waitFor(() => expect(auth.updateUser).toHaveBeenCalledWith({ password: 'eight888' }));
    expect(await screen.findByText('Password updated')).toBeTruthy();
  });

  it('shows W4 in plain words when Supabase refuses a breach-list password', async () => {
    auth.updateUser.mockResolvedValue({ data: {}, error: breach() });
    await renderPage();
    submit('password1');
    expect((await screen.findByRole('alert')).textContent).toBe(W4);
  });
});

describe('account activation page', () => {
  async function renderPage() {
    const { default: Page } = await import('@/app/activate/page');
    render(React.createElement(Page));
  }

  it('shows W3 before typing and keeps the button disabled under 8 characters', async () => {
    await renderPage();
    expect(screen.getByText(W3)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/New password/), { target: { value: 'seven77' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('button', { name: 'Activate account' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('button', { name: 'Activate account' }).closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe(W3);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('shows W4 instead of the raw Supabase message', async () => {
    auth.updateUser.mockResolvedValue({ data: {}, error: breach() });
    await renderPage();
    fireEvent.change(screen.getByLabelText(/New password/), { target: { value: 'password1' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));
    expect((await screen.findByRole('alert')).textContent).toBe(W4);
    expect(screen.queryByText(/known to be weak/)).toBeNull();
  });
});

describe('sign-up (onboarding wizard)', () => {
  async function renderWizard() {
    const { OnboardingWizard } = await import('@/app/get-started/OnboardingWizard');
    render(React.createElement(OnboardingWizard));
    await screen.findByText('Create your account');
  }
  function signUp(email: string, password: string) {
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: email } });
    fireEvent.change(screen.getByPlaceholderText('Min. 8 characters'), { target: { value: password } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
  }

  it('shows W3 before typing; a new email with 7 characters is refused with W3 and no account is created', async () => {
    await renderWizard();
    expect(screen.getByText(W3)).toBeTruthy();
    signUp('new@example.com', 'seven77');
    await waitFor(() => expect(screen.getAllByText(W3).length).toBe(2));
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('a new email with 8 characters signs up', async () => {
    await renderWizard();
    signUp('new@example.com', 'eight888');
    await waitFor(() => expect(auth.signUp).toHaveBeenCalledTimes(1));
  });

  it('F7: an existing account with an older 6-character password still signs in through sign-up', async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: { session: { access_token: 't' }, user: { id: 'user-1', email: 'old@example.com' } },
      error: null,
    });
    await renderWizard();
    signUp('old@example.com', 'six666');
    await waitFor(() => expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'old@example.com', password: 'six666' }));
    expect(screen.queryAllByText(W3).length).toBeLessThanOrEqual(1);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('shows W4 when Supabase refuses a breach-list password at sign-up', async () => {
    auth.signUp.mockResolvedValue({ data: { user: null, session: null }, error: breach() });
    await renderWizard();
    signUp('new@example.com', 'password1');
    expect(await screen.findByText(W4)).toBeTruthy();
  });
});
