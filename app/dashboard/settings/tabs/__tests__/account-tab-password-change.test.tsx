// @vitest-environment jsdom
/**
 * Settings > Change Password sends the current password to the server, which
 * confirms it before the new one is set. The form must not change the password
 * straight from the browser session.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateUser = vi.hoisted(() => vi.fn(async () => ({ error: null })));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useCapabilities: () => [] }));
vi.mock('@/components/dashboard/ReAuthModal', () => ({ ReAuthModal: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const chain: Record<string, any> = {};
      for (const key of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'gte', 'lte']) chain[key] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      chain.single = () => Promise.resolve({ data: null, error: null });
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      return chain;
    },
    auth: {
      updateUser,
      getUser: async () => ({ data: { user: { id: 'user-1', email: 'owner@example.com' } }, error: null }),
      mfa: { listFactors: async () => ({ data: { totp: [] }, error: null }) },
      signOut: vi.fn(),
    },
  }),
}));

import { AccountTab } from '@/app/dashboard/settings/tabs/AccountTab';

const fetchMock = vi.fn();

function renderTab() {
  const props = {
    business: {
      id: 'business-1', name: 'TestBiz', slug: 'testbiz', bot_code: 'TESTBIZ', status: 'active',
      subscription_tier: 'free', category: 'shop', metadata: {}, country_code: 'NG',
    },
    capabilities: [], country: 'NG', curr: 'NGN', saving: false, saved: false,
    setSaving: vi.fn(), setSaved: vi.fn(), openSections: ['plan'], toggleSection: vi.fn(),
  } as unknown as React.ComponentProps<typeof AccountTab>;
  render(<AccountTab {...props} />);
}

function fillAndSubmit(current: string, next: string) {
  fireEvent.change(screen.getByPlaceholderText('Enter current password'), { target: { value: current } });
  fireEvent.change(screen.getByPlaceholderText('Min 6 characters'), { target: { value: next } });
  fireEvent.change(screen.getByPlaceholderText('Re-enter new password'), { target: { value: next } });
  fireEvent.click(screen.getByRole('button', { name: 'Update Password' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const passwordCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/account/password');

describe('Settings: Change Password', () => {
  it('sends the current and new password to the server and never updates the password from the browser', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    renderTab();
    fillAndSubmit('old-secret', 'new-secret');
    await waitFor(() => expect(passwordCalls()).toHaveLength(1));
    const [, init] = passwordCalls()[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ currentPassword: 'old-secret', newPassword: 'new-secret' });
    expect(await screen.findByText('Password updated successfully.')).toBeTruthy();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('shows the server message when the current password is wrong', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Current password is incorrect.' }), { status: 403 }));
    renderTab();
    fillAndSubmit('wrong', 'new-secret');
    expect(await screen.findByText('Current password is incorrect.')).toBeTruthy();
    expect(screen.queryByText('Password updated successfully.')).toBeNull();
    expect(updateUser).not.toHaveBeenCalled();
  });
});
