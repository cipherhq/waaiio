/**
 * PlatformSettings admin discoverability — component interaction test (#218/#285)
 *
 * Proves the UI regression fix: absent commercial settings appear as
 * configurable "Not configured" placeholders in the correct group tab,
 * and creating them routes through save_commercial_config.
 *
 * Acceptance criteria:
 * 1. Payments & Payouts tab is visible when minimum_bank_transfer is absent
 * 2. Minimum Bank Transfer renders as "Not configured"
 * 3. Clicking Configure exposes the configuration UI
 * 4. Submitting uses save_commercial_config RPC, not direct insert
 * 5. After re-render, the placeholder is gone and the configured setting appears
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Hoisted mocks (vi.mock factories can't reference module-scope vars) ──

const { rpcCalls, insertCalls, mockSettings, mockAdminDb, mockSupabase } = vi.hoisted(() => {
  type MockSetting = {
    key: string;
    value: unknown;
    description: string | null;
    updated_by: string | null;
    updated_at: string | null;
    created_at: string;
  };

  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const insertCalls: Array<{ table: string; data: unknown }> = [];
  const mockSettings: MockSetting[] = [];

  function buildMockChain() {
    const chain: Record<string, any> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockImplementation(() => ({
      data: [...mockSettings],
      error: null,
    }));
    chain.insert = vi.fn().mockImplementation((data: unknown) => {
      insertCalls.push({ table: 'platform_settings', data });
      return { error: null };
    });
    chain.update = vi.fn().mockReturnValue(chain);
    chain.delete = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue({ error: null });
    return chain;
  }

  const mockAdminDb = {
    from: vi.fn(() => buildMockChain()),
    rpc: vi.fn().mockImplementation((fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'save_commercial_config') {
        const key = args.p_key as string;
        const existing = mockSettings.find(s => s.key === key);
        if (!existing) {
          mockSettings.push({
            key,
            value: args.p_value,
            description: null,
            updated_by: 'test-user-id',
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          });
        } else {
          existing.value = args.p_value;
        }
      }
      return { error: null };
    }),
  };

  const mockSupabase = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'test-user-id' } } },
      }),
    },
  };

  return { rpcCalls, insertCalls, mockSettings, mockAdminDb, mockSupabase };
});

vi.mock('@/lib/supabase', () => ({
  supabase: mockSupabase,
  adminDb: mockAdminDb,
}));

vi.mock('@/components/AdminLayout', () => ({
  useAdminSession: vi.fn().mockReturnValue({ userId: 'test-user-id', email: 'admin@test.com', role: 'admin' }),
}));

vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/formatters', () => ({
  fmtDateTime: vi.fn((d: string) => d),
}));

import PlatformSettings from '../pages/PlatformSettings';

/** Find the unconfigured placeholder row for a specific key */
function findUnconfiguredRow(key: string): HTMLElement | null {
  const keyLabels = screen.queryAllByText(key);
  for (const label of keyLabels) {
    const row = label.closest('[class*="bg-amber"]');
    if (row) return row as HTMLElement;
  }
  return null;
}

describe('PlatformSettings — absent setting discoverability (#218)', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    rpcCalls.length = 0;
    insertCalls.length = 0;
    mockSettings.length = 0;
    vi.clearAllMocks();

    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'test-user-id' } } },
    });

    // Start with settings that DON'T include minimum_bank_transfer
    mockSettings.push(
      {
        key: 'transfer_expiry_hours',
        value: 4,
        description: 'Hours before bank transfer link expires',
        updated_by: null,
        updated_at: null,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        key: 'pricing_tiers',
        value: { free: { feePercentage: 2.5 } },
        description: 'Tier pricing',
        updated_by: null,
        updated_at: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    );
  });

  async function navigateToPaymentsTab() {
    render(<PlatformSettings />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Payments & Payouts/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Payments & Payouts/i }));
  }

  it('1. Payments & Payouts tab is visible when minimum_bank_transfer is absent', async () => {
    render(<PlatformSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Payments & Payouts/i })).toBeInTheDocument();
    });
  });

  it('2. Minimum Bank Transfer renders as "Not configured" in Payments & Payouts tab', async () => {
    await navigateToPaymentsTab();

    // Find the specific row for minimum_bank_transfer
    const row = findUnconfiguredRow('minimum_bank_transfer');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('Not configured')).toBeInTheDocument();
    expect(within(row!).getByText('Minimum Bank Transfer')).toBeInTheDocument();
  });

  it('3. Clicking Configure exposes the configuration UI with value input', async () => {
    await navigateToPaymentsTab();

    const row = findUnconfiguredRow('minimum_bank_transfer');
    expect(row).not.toBeNull();

    // Click the Configure button within THIS row
    await user.click(within(row!).getByRole('button', { name: /Configure/i }));

    // Configuration UI should appear with value input and Create Setting button
    expect(screen.getByPlaceholderText(/\{"NG": 5000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Setting/i })).toBeInTheDocument();
  });

  it('4. Submitting uses save_commercial_config RPC for minimum_bank_transfer, not direct insert', async () => {
    await navigateToPaymentsTab();

    const row = findUnconfiguredRow('minimum_bank_transfer');
    expect(row).not.toBeNull();
    await user.click(within(row!).getByRole('button', { name: /Configure/i }));

    const valueInput = screen.getByPlaceholderText(/\{"NG": 5000/);
    await user.clear(valueInput);
    await user.type(valueInput, '{{"NG": 5000, "GH": 5000}');

    await user.click(screen.getByRole('button', { name: /Create Setting/i }));

    // Verify save_commercial_config was called
    await waitFor(() => {
      const commercialCall = rpcCalls.find(c => c.fn === 'save_commercial_config');
      expect(commercialCall).toBeDefined();
      expect(commercialCall!.args.p_key).toBe('minimum_bank_transfer');
    });

    // No direct platform_settings insert for this key
    const directInserts = insertCalls.filter(
      c => c.table === 'platform_settings' && JSON.stringify(c.data).includes('minimum_bank_transfer'),
    );
    expect(directInserts).toHaveLength(0);
  });

  it('5. After creation, placeholder is gone and configured setting renders', async () => {
    await navigateToPaymentsTab();

    const row = findUnconfiguredRow('minimum_bank_transfer');
    expect(row).not.toBeNull();
    await user.click(within(row!).getByRole('button', { name: /Configure/i }));

    const valueInput = screen.getByPlaceholderText(/\{"NG": 5000/);
    await user.clear(valueInput);
    await user.type(valueInput, '{{"NG": 10000}');

    await user.click(screen.getByRole('button', { name: /Create Setting/i }));

    // After save, loadData re-runs. The mock adds minimum_bank_transfer to mockSettings.
    // The unconfigured placeholder should be gone; the setting should render as configured.
    await waitFor(() => {
      const unconfiguredRow = findUnconfiguredRow('minimum_bank_transfer');
      expect(unconfiguredRow).toBeNull();
    });

    // The key should now appear as a configured setting (mono font key label, no amber bg)
    await waitFor(() => {
      const allKeyLabels = screen.getAllByText('minimum_bank_transfer');
      // At least one should be in a configured (non-amber) row
      const configuredLabel = allKeyLabels.find(el => {
        const container = el.closest('[class*="px-5"]');
        return container && !container.className.includes('bg-amber');
      });
      expect(configuredLabel).toBeDefined();
    });
  });
});
