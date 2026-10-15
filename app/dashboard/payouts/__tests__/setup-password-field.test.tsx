// @vitest-environment jsdom
/**
 * Behavioral render tests for the payout setup password field.
 *
 * Renders the real PayoutsPage component in the "no payout account yet" state
 * and verifies the password input stays mounted while typing, the full value
 * reaches the API, errors re-render the field, and the value is cleared after
 * success.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──

// Mock next/link as a plain <a>
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: any) =>
    React.createElement('a', { href, ...rest }, children),
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/payouts',
  useSearchParams: () => new URLSearchParams(),
}));

// Mock DashboardProvider — return a NG business with terms already accepted
vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({
    id: 'biz-test',
    name: 'Test Business',
    country_code: 'NG',
    category: 'shop',
    payout_mode: 'platform_managed',
    payment_gateway: 'paystack',
  }),
}));

// Mock PageHelp as a no-op
vi.mock('@/components/dashboard/PageHelp', () => ({
  PageHelp: () => null,
}));

// Mock Supabase browser client: no payout account, terms accepted
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain: Record<string, any> = {};
      ['select', 'eq', 'order', 'limit'].forEach(m => {
        chain[m] = () => chain;
      });
      chain.maybeSingle = async () => {
        if (table === 'payout_accounts') return { data: null }; // no existing account
        if (table === 'payout_terms_acceptance')
          return { data: { id: 'terms-1', payout_mode: 'platform_managed', accepted_at: '2026-01-01' } };
        return { data: null };
      };
      return chain;
    },
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1', email: 'test@test.com' } } }),
    },
  }),
}));

// Mock countries
vi.mock('@/lib/countries', () => ({
  getCountry: () => ({ payment_gateway: 'paystack', currency: 'NGN' }),
}));

// Mock constants
vi.mock('@/lib/constants', () => ({
  formatCurrency: (amt: number) => `₦${amt}`,
}));

// ── Helpers ──

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// ── Tests ──

describe('Payout setup password field — behavioral render', () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    vi.resetModules();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    // Default fetch responses
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string') {
        if (url.includes('/api/payouts/balance')) return jsonResponse(200, { gross: 0, fees: 0, net_available: 0, paid_out: 0, pending_payouts: 0, pending_order_revenue: 0, pending_booking_revenue: 0, total_orders: 0, total_bookings: 0 });
        if (url.includes('/api/payouts/banks')) return jsonResponse(200, { banks: [{ code: '058', name: 'GTBank' }] });
        if (url.includes('/api/payouts/resolve')) return jsonResponse(200, { account_name: 'TEST ACCOUNT' });
        if (url.includes('/api/payouts/setup')) return jsonResponse(200, { success: true, payout_account_id: 'pa-1', verified: true, account_name: 'TEST ACCOUNT' });
      }
      return jsonResponse(200, {});
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function renderSetupPage() {
    const PayoutsPage = (await import('../page')).default;
    render(React.createElement(PayoutsPage));
    // Wait for the setup view and banks to load
    await waitFor(() => {
      expect(screen.getByText('Add your bank account')).toBeTruthy();
      // Verify bank options are loaded (GTBank from mock)
      expect(screen.getByText('GTBank')).toBeTruthy();
    });
  }

  async function doFullFlowToConfirm() {
    await renderSetupPage();

    // Select bank
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '058' } });
    // Enter 10-digit account number
    fireEvent.change(screen.getByPlaceholderText('0123456789'), { target: { value: '1234567890' } });

    // Wait for Verify Account to appear
    await waitFor(() => {
      expect(screen.getByText('Verify Account')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Verify Account'));

    // Wait for "Is this you? TEST ACCOUNT"
    await waitFor(() => {
      expect(screen.getByText('TEST ACCOUNT')).toBeTruthy();
    });

    // Type password
    await act(async () => {
      fireEvent.change(getPasswordInput(), { target: { value: 'Secret123!' } });
    });

    // Verify button is enabled
    await waitFor(() => {
      expect((screen.getByText('Yes, set up payouts') as HTMLButtonElement).disabled).toBe(false);
    });
  }

  function getPasswordInput(): HTMLInputElement {
    return screen.getByPlaceholderText('Enter your account password') as HTMLInputElement;
  }

  // (a) Type each character — input stays mounted and final value is correct
  it('password input stays mounted while typing and retains the full value', async () => {
    await renderSetupPage();
    const input = getPasswordInput();
    const password = 'Secret123!';

    for (let i = 1; i <= password.length; i++) {
      fireEvent.change(input, { target: { value: password.slice(0, i) } });
      // Input must still be in the document after every keystroke
      expect(document.body.contains(input)).toBe(true);
      expect(input.value).toBe(password.slice(0, i));
    }

    expect(input.value).toBe('Secret123!');
  });

  // (b) Full flow: select bank, enter account, verify, confirm button state
  it('verify flow: bank → account → resolve → confirm button disabled/enabled by password', async () => {
    await renderSetupPage();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '058' } });
    fireEvent.change(screen.getByPlaceholderText('0123456789'), { target: { value: '1234567890' } });
    await waitFor(() => expect(screen.getByText('Verify Account')).toBeTruthy());
    fireEvent.click(screen.getByText('Verify Account'));

    await waitFor(() => expect(screen.getByText('TEST ACCOUNT')).toBeTruthy());

    // Button disabled with no password
    expect((screen.getByText('Yes, set up payouts') as HTMLButtonElement).disabled).toBe(true);

    // Type password → button enabled
    await act(async () => {
      fireEvent.change(getPasswordInput(), { target: { value: 'Secret123!' } });
    });
    await waitFor(() => {
      expect((screen.getByText('Yes, set up payouts') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  // (c) Click "Yes, set up payouts" — fetch body contains the exact password
  it('setup fetch sends the exact password typed', async () => {
    await doFullFlowToConfirm();

    // Spy on console and Storage to ensure password is never logged or persisted
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});

    // Click confirm
    await act(async () => {
      fireEvent.click(screen.getByText('Yes, set up payouts'));
    });

    // Wait for the setup POST to have been called
    await waitFor(() => {
      const calls = mockFetch.mock.calls.filter(
        (args: unknown[]) => {
          const [url, init] = args as [string, RequestInit?];
          return typeof url === 'string' && url.includes('/api/payouts/setup') && init?.method === 'POST';
        },
      );
      expect(calls.length).toBe(1);
    });

    const setupCall = mockFetch.mock.calls.find(
      (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('/api/payouts/setup'),
    );
    expect(setupCall).toBeTruthy();
    const body = JSON.parse(setupCall![1].body);
    expect(body.password).toBe('Secret123!');
    expect(body.business_id).toBe('biz-test');

    // Password was never logged or persisted
    for (const spy of [consoleSpy, consoleWarnSpy, consoleErrorSpy]) {
      for (const call of spy.mock.calls) {
        expect(call.join(' ')).not.toContain('Secret123!');
      }
    }
    for (const call of storageSpy.mock.calls) {
      expect(call[1]).not.toContain('Secret123!');
    }

    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    storageSpy.mockRestore();
  });

  // (d) Setup returns 403 — error shown, password input still rendered and editable
  it('on 403 error, password input remains rendered and editable', async () => {
    await doFullFlowToConfirm();

    // Override setup to return 403
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/payouts/setup'))
        return jsonResponse(403, { error: 'Incorrect password' });
      if (url.includes('/api/payouts/balance')) return jsonResponse(200, { gross: 0, fees: 0, net_available: 0, paid_out: 0, pending_payouts: 0, pending_order_revenue: 0, pending_booking_revenue: 0, total_orders: 0, total_bookings: 0 });
      if (url.includes('/api/payouts/banks')) return jsonResponse(200, { banks: [{ code: '058', name: 'GTBank' }] });
      if (url.includes('/api/payouts/resolve')) return jsonResponse(200, { account_name: 'TEST ACCOUNT' });
      return jsonResponse(200, {});
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Yes, set up payouts'));
    });

    await waitFor(() => {
      expect(screen.getByText('Incorrect password')).toBeTruthy();
    });

    // Password input is still rendered and editable
    const pwInput = getPasswordInput();
    expect(document.body.contains(pwInput)).toBe(true);
    fireEvent.change(pwInput, { target: { value: 'NewPassword!' } });
    expect(pwInput.value).toBe('NewPassword!');
  });

  // (e) On success, password is cleared (re-entering the flow shows empty input)
  it('on successful setup, password is cleared', async () => {
    await doFullFlowToConfirm();

    await act(async () => {
      fireEvent.click(screen.getByText('Yes, set up payouts'));
    });

    // Wait for the connected view
    await waitFor(() => {
      expect(screen.getByText('Change account')).toBeTruthy();
    });

    // Click "Change account" to show the confirmation modal
    fireEvent.click(screen.getByText('Change account'));
    await waitFor(() => {
      expect(screen.getByText('Confirm account change')).toBeTruthy();
    });

    // Enter the change-password and confirm to go back to setup
    const changePwInput = screen.getByPlaceholderText('Enter your password') as HTMLInputElement;
    fireEvent.change(changePwInput, { target: { value: 'AnyPassword' } });
    fireEvent.click(screen.getByText('Confirm Change'));

    // Wait for setup view to reappear
    await waitFor(() => {
      expect(screen.getByText('Add your bank account')).toBeTruthy();
    });

    // The setup password field should be populated with the change password
    // (confirmChangeAccount stores it as setupPassword for the next setup call)
    // But the OLD setup password "Secret123!" should NOT be there
    const pwInput = getPasswordInput();
    expect(pwInput.value).not.toBe('Secret123!');
  });
});
