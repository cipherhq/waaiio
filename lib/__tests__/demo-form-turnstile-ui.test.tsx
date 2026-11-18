// @vitest-environment jsdom
/**
 * Bot check (Cloudflare Turnstile) on the rendered white-label "Book a Demo" form.
 *
 * Renders the real DemoForm. Cloudflare's browser script is replaced by a small
 * window.turnstile stub (jsdom cannot load it). The site key is read at module
 * load, like the contact form, so each test imports a fresh copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Opts = { sitekey: string; callback: (t: string) => void; 'expired-callback': () => void };
let widget: { opts: Opts | null; reset: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
function installTurnstile() {
  widget = { opts: null, reset: vi.fn(), remove: vi.fn() };
  (window as unknown as { turnstile: unknown }).turnstile = {
    render: (_el: HTMLElement, opts: Opts) => { widget.opts = opts; return 'widget-1'; },
    reset: widget.reset,
    remove: widget.remove,
  };
}

const fetchMock = vi.fn();
const demoCalls = () => fetchMock.mock.calls.filter(c => c[0] === '/api/demo-request');

async function loadForm(siteKey: string) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', siteKey);
  return (await import('@/app/(marketing)/white-label/DemoForm')).default;
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText(/Business Name/), { target: { value: 'Acme' } });
  fireEvent.change(screen.getByLabelText(/Contact Name/), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByLabelText(/Work Email/), { target: { value: 'ada@acme.test' } });
  fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '+15551234567' } });
  fireEvent.change(screen.getByLabelText(/Industry/), { target: { value: 'Hospitality' } });
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Book a Demo' }));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete (window as unknown as { turnstile?: unknown }).turnstile;
});

describe('DemoForm — bot check widget', () => {
  it('renders Turnstile with the configured site key', async () => {
    installTurnstile();
    const DemoForm = await loadForm('site-key-1');
    render(<DemoForm />);
    await waitFor(() => expect(widget.opts).not.toBeNull());
    expect(widget.opts!.sitekey).toBe('site-key-1');
  });

  it('loads Cloudflare\'s script when it is not on the page yet', async () => {
    const DemoForm = await loadForm('site-key-1');
    render(<DemoForm />);
    const script = document.head.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]');
    expect(script).not.toBeNull();
  });

  it('blocks sending until the check is done, then sends the token', async () => {
    installTurnstile();
    const DemoForm = await loadForm('site-key-1');
    render(<DemoForm />);
    await waitFor(() => expect(widget.opts).not.toBeNull());
    fillRequired();

    submit();
    expect(await screen.findByText('Please complete the verification check.')).toBeTruthy();
    // Announced to screen readers (#1109 follow-up).
    expect(screen.getByRole('alert').textContent).toBe('Please complete the verification check.');
    expect(demoCalls()).toHaveLength(0);

    act(() => widget.opts!.callback('tok-123'));
    submit();
    await screen.findByText('Request received!');
    expect(JSON.parse(demoCalls()[0][1].body).turnstileToken).toBe('tok-123');
  });

  it('gets a fresh token after the server refuses one', async () => {
    installTurnstile();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Security check failed. Please try again.' }), { status: 403 }));
    const DemoForm = await loadForm('site-key-1');
    render(<DemoForm />);
    await waitFor(() => expect(widget.opts).not.toBeNull());
    fillRequired();
    act(() => widget.opts!.callback('tok-used'));
    submit();
    expect(await screen.findByText('Security check failed. Please try again.')).toBeTruthy();
    expect(widget.reset).toHaveBeenCalledWith('widget-1');

    // The used token is dropped, so the next try waits for a new one.
    submit();
    expect(await screen.findByText('Please complete the verification check.')).toBeTruthy();
    expect(demoCalls()).toHaveLength(1);
  });

  it('shows the widget again for "Submit another request"', async () => {
    installTurnstile();
    const DemoForm = await loadForm('site-key-1');
    render(<DemoForm />);
    await waitFor(() => expect(widget.opts).not.toBeNull());
    fillRequired();
    act(() => widget.opts!.callback('tok-1'));
    submit();
    await screen.findByText('Request received!');
    expect(widget.remove).toHaveBeenCalledWith('widget-1');

    widget.opts = null;
    fireEvent.click(screen.getByRole('button', { name: 'Submit another request' }));
    await waitFor(() => expect(widget.opts).not.toBeNull());
  });

  it('without a site key: no widget, and the form sends as before', async () => {
    installTurnstile();
    const DemoForm = await loadForm('');
    render(<DemoForm />);
    fillRequired();
    submit();
    await screen.findByText('Request received!');
    expect(widget.opts).toBeNull();
    expect(JSON.parse(demoCalls()[0][1].body).turnstileToken).toBeUndefined();
  });
});
