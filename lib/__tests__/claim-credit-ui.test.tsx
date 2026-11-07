// @vitest-environment jsdom
/**
 * Claim-credit UI (Owner decision 2026-11-07): the first "Getting started"
 * step and the /dashboard/claim-credit page, rendered with fetch mocked.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BIZ = 'own';
const state = vi.hoisted(() => ({
  status: { phone_verified: false, credited: false, amount_minor: 500000, currency: 'NGN' } as Record<string, unknown>,
  statusOk: true,
  responses: {} as Record<string, { status: number; body: Record<string, unknown> }>,
  calls: [] as Array<{ url: string; body?: Record<string, unknown> }>,
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({ id: BIZ, bot_code: '', country_code: 'NG', category: 'salon' }),
  useCapabilities: () => ({ hasCapability: () => false }),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, gt: () => q, then: (r: (v: unknown) => unknown) => r({ count: 0, error: null }) };
      return q;
    },
  }),
}));
// Plain inputs stand in for the phone/code widgets (their own tests cover them).
vi.mock('@/components/auth/PhoneInput', () => ({
  PhoneInput: ({ value, onChange }: { value: string; onChange: (v: string) => void }) =>
    <input aria-label="phone" value={value} onChange={e => onChange(e.target.value)} />,
}));
vi.mock('@/components/auth/OtpInput', () => ({
  OtpInput: ({ value, onChange }: { value: string; onChange: (v: string) => void }) =>
    <input aria-label="code" value={value} onChange={e => onChange(e.target.value)} />,
}));

import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import ClaimCreditPage from '@/app/dashboard/claim-credit/page';
import { formatCurrencyCode } from '@/lib/constants';

const AMOUNT = formatCurrencyCode(5000, 'NGN');

function mockFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ url, body });
    if (url.startsWith('/api/trial-credit/status')) {
      return new Response(JSON.stringify(state.status), { status: state.statusOk ? 200 : 500 });
    }
    const key = url === '/api/trial-credit/claim' && body?.check ? 'check' : url;
    const r = state.responses[key] || { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }));
}

beforeEach(() => {
  state.status = { phone_verified: false, credited: false, amount_minor: 500000, currency: 'NGN' };
  state.statusOk = true;
  state.responses = {
    check: { status: 200, body: { ok: true } },
    '/api/auth/otp/send': { status: 200, body: { pin_id: 'pin-1' } },
    '/api/trial-credit/claim': { status: 200, body: { verified: true, credited: true } },
  };
  state.calls = [];
  localStorage.clear();
  mockFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Getting started: Claim your free messaging credit', () => {
  it('is the first step, links to the claim page, and asks for this business', async () => {
    render(<OnboardingChecklist />);
    await screen.findByRole('heading', { name: 'Getting started with Waaiio' });
    const links = screen.getAllByRole('link');
    expect(links[0].textContent).toContain('Claim your free messaging credit');
    expect(links[0].getAttribute('href')).toBe('/dashboard/claim-credit');
    expect(state.calls[0].url).toBe('/api/trial-credit/status?business_id=own');
    expect(screen.getByText('Claim your free messaging credit').classList.contains('line-through')).toBe(false);
  });

  it.each([
    [{ phone_verified: true, credited: false }],
    [{ phone_verified: false, credited: true }],
  ])('is done when %j', async (s) => {
    state.status = s;
    render(<OnboardingChecklist />);
    await screen.findByRole('heading', { name: 'Getting started with Waaiio' });
    expect(screen.getByText('Claim your free messaging credit').classList.contains('line-through')).toBe(true);
  });

  it('a failed status read leaves the step not done', async () => {
    state.statusOk = false;
    render(<OnboardingChecklist />);
    await screen.findByRole('heading', { name: 'Getting started with Waaiio' });
    expect(screen.getByText('Claim your free messaging credit').classList.contains('line-through')).toBe(false);
  });
});

describe('/dashboard/claim-credit page', () => {
  async function enterPhoneAndSend() {
    render(<ClaimCreditPage />);
    await screen.findByRole('heading', { name: `Verify your phone number to claim ${AMOUNT} free messaging credit` });
    fireEvent.change(screen.getByLabelText('phone'), { target: { value: '+2348012345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code on WhatsApp' }));
  }

  it('shows the amount and says not to use the number connected to Waaiio', async () => {
    render(<ClaimCreditPage />);
    expect(await screen.findByRole('heading', { name: `Verify your phone number to claim ${AMOUNT} free messaging credit` })).toBeTruthy();
    expect(screen.getByText(/personal number or your everyday business number/)).toBeTruthy();
    expect(screen.getByText(/Don.t use the number you connected to Waaiio/)).toBeTruthy();
  });

  it('checks the number, sends the code, then claims with the code and challenge', async () => {
    await enterPhoneAndSend();
    await screen.findByText(/We sent a 6-digit code/);
    expect(state.calls.find(c => c.body?.check)?.body).toEqual({ business_id: BIZ, phone: '+2348012345678', check: true });
    expect(state.calls.find(c => c.url === '/api/auth/otp/send')?.body).toEqual({ phone: '+2348012345678' });
    fireEvent.change(screen.getByLabelText('code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & claim' }));
    expect(await screen.findByText(`Your free messaging credit of ${AMOUNT.replace(/\s/g, ' ')} has been added.`)).toBeTruthy();
    expect(state.calls.find(c => c.url === '/api/trial-credit/claim' && !c.body?.check)?.body)
      .toEqual({ business_id: BIZ, phone: '+2348012345678', otp: '123456', pin_id: 'pin-1' });
  });

  it('a connected Waaiio number is refused before any code is sent', async () => {
    state.responses.check = { status: 400, body: { code: 'connected_number', message: "This number is connected to Waaiio and can't receive codes." } };
    await enterPhoneAndSend();
    expect((await screen.findByRole('alert')).textContent).toContain('connected to Waaiio');
    expect(state.calls.some(c => c.url === '/api/auth/otp/send')).toBe(false);
  });

  it('billing not on yet: verified, credit comes later', async () => {
    state.responses['/api/trial-credit/claim'] = { status: 200, body: { verified: true, credited: false, reason: 'financial_gate_off' } };
    await enterPhoneAndSend();
    await screen.findByText(/We sent a 6-digit code/);
    fireEvent.change(screen.getByLabelText('code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & claim' }));
    expect(await screen.findByText('Phone verified. Your free credit will be added automatically when message billing starts.')).toBeTruthy();
  });

  it('a number on another account shows the server message and stays on the code step', async () => {
    state.responses['/api/trial-credit/claim'] = { status: 409, body: { code: 'phone_in_use', message: 'This number is already linked to another Waaiio account.' } };
    await enterPhoneAndSend();
    await screen.findByText(/We sent a 6-digit code/);
    fireEvent.change(screen.getByLabelText('code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & claim' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already linked to another Waaiio account');
    expect(screen.getByRole('button', { name: 'Use a different number' })).toBeTruthy();
  });

  it('already credited: shows done, no form', async () => {
    state.status = { phone_verified: true, credited: true, amount_minor: 500000, currency: 'NGN' };
    render(<ClaimCreditPage />);
    expect(await screen.findByText('Your free messaging credit has been added.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Send code on WhatsApp' })).toBeNull());
  });
});
