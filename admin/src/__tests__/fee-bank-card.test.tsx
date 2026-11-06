/**
 * Platform fee bank account card (Owner decision 2026-11-06, "extra code required").
 * - The fee bank setting appears only on its own card, never in the general editor.
 * - The full account number is never shown; the card shows it masked.
 * - Opening the page makes no request for the card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { mockSettings, mockAdminDb, mockSupabase } = vi.hoisted(() => {
  const mockSettings: Array<Record<string, unknown>> = [];
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockImplementation(() => ({ data: [...mockSettings], error: null }));
  const mockAdminDb = { from: vi.fn().mockReturnValue(chain), rpc: vi.fn() };
  const mockSupabase = {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'tok', user: { id: 'u' } } } }) },
  };
  return { mockSettings, mockAdminDb, mockSupabase };
});

vi.mock('@/lib/supabase', () => ({ supabase: mockSupabase, adminDb: mockAdminDb }));
vi.mock('@/components/AdminLayout', () => ({
  useAdminSession: vi.fn().mockReturnValue({ userId: 'u', email: 'admin@test.com', role: 'admin' }),
}));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/formatters', () => ({ fmtDateTime: vi.fn((d: string) => d) }));

import PlatformSettings from '../pages/PlatformSettings';

describe('PlatformSettings — fee bank account card', () => {
  beforeEach(() => {
    mockSettings.length = 0;
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    mockSettings.push(
      { key: 'platform_bank_ng', value: { bank_code: '058', account_number: '0123456789', account_name: 'Waaiio Ltd' }, description: null, updated_by: null, updated_at: null, created_at: '2026-01-01T00:00:00Z' },
      { key: 'some_other_setting', value: 1, description: null, updated_by: null, updated_at: null, created_at: '2026-01-01T00:00:00Z' },
    );
  });

  async function openOtherTab() {
    await waitFor(() => expect(screen.getByRole('button', { name: /^Other/ })).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole('button', { name: /^Other/ }));
    await waitFor(() => expect(screen.getByText('some_other_setting')).toBeInTheDocument());
  }

  it('shows the account masked on its own card and never the full number, even on the Other tab', async () => {
    render(<PlatformSettings />);
    await waitFor(() => expect(screen.getByText('Platform fee bank account')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Waaiio Ltd · bank 058 · \*\*\*\*\*\*6789/)).toBeInTheDocument());
    await openOtherTab();
    expect(document.body.textContent).not.toContain('0123456789');
    expect(document.body.innerHTML).not.toContain('0123456789');
  });

  it('does not list the fee bank key in the general editor', async () => {
    render(<PlatformSettings />);
    await openOtherTab();
    expect(screen.queryByText('platform_bank_ng')).not.toBeInTheDocument();
  });

  it('makes no request for the card when the page opens', async () => {
    render(<PlatformSettings />);
    await waitFor(() => expect(screen.getByText('Platform fee bank account')).toBeInTheDocument());
    expect(fetch).not.toHaveBeenCalled();
  });
});
