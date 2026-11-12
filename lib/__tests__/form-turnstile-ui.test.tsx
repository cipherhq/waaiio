// @vitest-environment jsdom
/**
 * Bot check (Cloudflare Turnstile) on the rendered public form page.
 *
 * Renders the real page and the real widget component. Cloudflare's browser
 * script is replaced by a small window.turnstile stub (jsdom cannot load it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useParams: () => ({ token: 'tokA' }) }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/components/ReturnToWhatsApp', () => ({ ReturnToWhatsApp: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

import PublicFormPage from '@/app/form/[token]/page';
import { TURNSTILE_TEST_SITE_KEY, TurnstileWidget, resolveTurnstileSiteKey } from '@/app/form/[token]/TurnstileWidget';

type Opts = { sitekey: string; appearance: string; action: string; callback: (t: string) => void; 'expired-callback': () => void; 'error-callback': () => void };

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const publicForm = {
  title: 'Guest list', description: null, business_name: 'Ada Salon', business_phone: null, business_logo: null,
  fields: [{ id: 'name', label: 'Name', type: 'text', required: false }],
};
const submitCalls = () => fetchMock.mock.calls.filter(c => c[0] === '/api/forms/submit');

let widget: { el: HTMLElement | null; opts: Opts | null; reset: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
function installTurnstile() {
  widget = { el: null, opts: null, reset: vi.fn(), remove: vi.fn() };
  (window as unknown as { turnstile: unknown }).turnstile = {
    render: (el: HTMLElement, opts: Opts) => { widget.el = el; widget.opts = opts; return 'widget-1'; },
    reset: widget.reset,
    remove: widget.remove,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => url.startsWith('/api/forms/public/') ? json(publicForm) : json({ success: true }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete (window as unknown as { turnstile?: unknown }).turnstile;
});

describe('public form page — bot check widget', () => {
  it('shows the widget and loads Cloudflare\'s script', async () => {
    render(<PublicFormPage />);
    await screen.findByText('Guest list');
    expect(screen.getByTestId('turnstile-widget')).toBeTruthy();
    const findScript = () => document.head.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]') as HTMLScriptElement | null;
    await waitFor(() => expect(findScript()).not.toBeNull());
    expect(findScript()!.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  });

  it('renders Turnstile in the widget box, mostly invisible, with the configured site key', async () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '0x4AAAAAAAunittestkey');
    installTurnstile();
    render(<PublicFormPage />);
    await waitFor(() => expect(widget.opts).not.toBeNull());
    expect(widget.el).toBe(screen.getByTestId('turnstile-widget'));
    expect(widget.opts).toMatchObject({ sitekey: '0x4AAAAAAAunittestkey', appearance: 'interaction-only', action: 'form_submit' });
  });

  it('uses Cloudflare\'s test site key outside production when none is set', async () => {
    installTurnstile();
    render(<PublicFormPage />);
    await waitFor(() => expect(widget.opts?.sitekey).toBe(TURNSTILE_TEST_SITE_KEY));
  });

  it('does not submit until the check has passed, then sends the token', async () => {
    installTurnstile();
    render(<PublicFormPage />);
    await waitFor(() => expect(widget.opts).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(/Please wait a moment while we check your browser/)).toBeTruthy();
    expect(submitCalls()).toEqual([]);

    act(() => { widget.opts!.callback('tok-123'); });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    expect(JSON.parse(submitCalls()[0][1].body)).toMatchObject({ token: 'tokA', turnstileToken: 'tok-123' });
    expect(await screen.findByText('Thank You!')).toBeTruthy();
  });

  it('gets a fresh token after the server refuses a submission', async () => {
    fetchMock.mockImplementation((url: string) => url.startsWith('/api/forms/public/')
      ? json(publicForm)
      : json({ error: 'Security check failed. Please try again.' }, 403));
    installTurnstile();
    render(<PublicFormPage />);
    await waitFor(() => expect(widget.opts).not.toBeNull());
    act(() => { widget.opts!.callback('tok-used'); });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Security check failed. Please try again.')).toBeTruthy();
    expect(widget.reset).toHaveBeenCalledWith('widget-1');

    // The spent token is dropped, so a second click waits for a new one.
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(/Please wait a moment while we check your browser/)).toBeTruthy();
    expect(submitCalls()).toHaveLength(1);
  });

  it('tells the visitor to refresh when the check cannot run', async () => {
    installTurnstile();
    render(<PublicFormPage />);
    await waitFor(() => expect(widget.opts).not.toBeNull());
    act(() => { widget.opts!['error-callback'](); });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(/security check could not load/)).toBeTruthy();
    expect(submitCalls()).toEqual([]);
  });

  it('with no site key (production without keys), reports an error and never renders', async () => {
    // NODE_ENV is fixed at compile time in this test environment, so the production key
    // choice is proved by resolveTurnstileSiteKey below and the empty key is passed here.
    installTurnstile();
    const onError = vi.fn();
    const onToken = vi.fn();
    render(<TurnstileWidget siteKey="" onToken={onToken} onError={onError} resetSignal={0} />);
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(widget.opts).toBeNull();
    expect(onToken).not.toHaveBeenCalled();
  });
});

describe('site key choice', () => {
  it('uses the configured key, else the test key outside production, else none', () => {
    expect(resolveTurnstileSiteKey('0x4AAAAAAAreal', 'production')).toBe('0x4AAAAAAAreal');
    expect(resolveTurnstileSiteKey(' 0x4AAAAAAAreal ', 'development')).toBe('0x4AAAAAAAreal');
    expect(resolveTurnstileSiteKey(undefined, 'development')).toBe(TURNSTILE_TEST_SITE_KEY);
    expect(resolveTurnstileSiteKey('', 'test')).toBe(TURNSTILE_TEST_SITE_KEY);
    expect(resolveTurnstileSiteKey(undefined, 'production')).toBe('');
    expect(resolveTurnstileSiteKey('   ', 'production')).toBe('');
  });
});
