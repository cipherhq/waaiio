/**
 * Component tests for the TopupPackagesEditor within PlatformSettings.
 *
 * Tests: real component render via PlatformSettings + vitest/jsdom.
 *
 * Acceptance criteria (task §4):
 *  TC1.  Messaging tab is visible even when messaging_topup_packages is absent
 *  TC2.  messaging_topup_packages renders as "Not configured" when absent
 *  TC3.  An existing seeded value loads into the form (NGN amount + label visible)
 *  TC4.  Save click sends exact JSON shape to /api/admin/platform-settings/commercial
 *        (major → minor conversion; blank description omitted)
 *  TC5.  Negative amount shows error and Save is disabled (client-side)
 *  TC6.  Zero amount shows error and Save is disabled (client-side)
 *  TC7.  Decimal amount (non-integer major) shows "whole-number" error AND Save is disabled
 *  TC8.  Empty label shows error and Save is disabled
 *  TC9.  Duplicate amounts within a currency show error and Save is disabled
 *  TC10. Source-code assertion: save goes through saveCommercialViaStepUp
 *  TC11. Data loss: unknown currency + unknown field on package blocks Save with clear error
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const { mockSettings, mockAdminDb, mockSupabase } = vi.hoisted(() => {
  type MockSetting = {
    key: string;
    value: unknown;
    description: string | null;
    updated_by: string | null;
    updated_at: string | null;
    created_at: string;
  };

  const mockSettings: MockSetting[] = [];

  function buildMockChain() {
    const chain: Record<string, any> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockImplementation(() => ({
      data: [...mockSettings],
      error: null,
    }));
    chain.insert = vi.fn().mockReturnValue({ error: null });
    chain.update = vi.fn().mockReturnValue(chain);
    chain.delete = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue({ error: null });
    return chain;
  }

  const mockAdminDb = {
    from: vi.fn(() => buildMockChain()),
    rpc: vi.fn().mockResolvedValue({ error: null }),
  };

  const mockSupabase = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'test-admin-id' }, access_token: 'mock-token' } },
      }),
    },
  };

  return { mockSettings, mockAdminDb, mockSupabase };
});

vi.mock('@/lib/supabase', () => ({
  supabase: mockSupabase,
  adminDb: mockAdminDb,
}));

vi.mock('@/components/AdminLayout', () => ({
  useAdminSession: vi.fn().mockReturnValue({ userId: 'test-admin-id', email: 'admin@test.com', role: 'admin' }),
}));

vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/formatters', () => ({
  fmtDateTime: vi.fn((d: string) => d),
}));

// Mock useStepUp so stepUp.execute() immediately calls onAuthorized without showing a dialog.
vi.mock('@/hooks/useStepUp', () => ({
  useStepUp: vi.fn(() => ({
    execute: vi.fn(async ({ onAuthorized }: { onAuthorized: (id: string) => Promise<void> }) => {
      await onAuthorized('mock-step-up-id');
    }),
    pending: null,
    state: { phase: 'idle', description: '', error: null },
  })),
}));

// Suppress StepUpDialog rendering — the real dialog requires a DOM portal.
vi.mock('@/components/StepUpDialog', () => ({
  StepUpDialog: () => null,
}));

// Prevent actual fetch calls from going out
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ success: true }),
}));

import PlatformSettings from '../pages/PlatformSettings';

function seedTopupPackages(value: unknown) {
  mockSettings.push({
    key: 'messaging_topup_packages',
    value,
    description: 'Top-up packages per currency',
    updated_by: null,
    updated_at: null,
    created_at: '2026-01-01T00:00:00Z',
  });
}

async function navigateToMessagingTab() {
  render(<PlatformSettings />);
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /Messaging/i })).toBeInTheDocument();
  });
  await userEvent.click(screen.getByRole('button', { name: /Messaging/i }));
}

describe('PlatformSettings — Messaging tab / TopupPackagesEditor', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    mockSettings.length = 0;
    vi.clearAllMocks();
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'test-admin-id' }, access_token: 'mock-token' } },
    });
    // Re-stub fetch after clearAllMocks so it is still a mock
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ versionId: 'v1' }),
    }));
  });

  // TC1
  it('1. Messaging tab is visible even when messaging_topup_packages is absent', async () => {
    render(<PlatformSettings />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Messaging/i })).toBeInTheDocument();
    });
  });

  // TC2
  it('2. messaging_topup_packages renders as "Not configured" when absent', async () => {
    await navigateToMessagingTab();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByTestId('unconfigured-messaging_topup_packages')).toBeInTheDocument();
  });

  // TC3 — seeded value loads into the form
  it('3. Existing seeded value loads into the form', async () => {
    seedTopupPackages({
      NGN: [
        { amount_minor: 100000, label: '₦1,000 credit' },
        { amount_minor: 500000, label: '₦5,000 credit', description: 'Best value' },
      ],
      GHS: [
        { amount_minor: 10000, label: 'GH₵100 credit' },
      ],
    });

    await navigateToMessagingTab();

    // Editor should be rendered
    expect(screen.getByTestId('topup-packages-editor')).toBeInTheDocument();

    // NGN amounts: 100000 minor → 1000 major, 500000 → 5000 major
    const ngnRows = [
      screen.getByTestId('package-row-NGN-0'),
      screen.getByTestId('package-row-NGN-1'),
    ];
    expect(within(ngnRows[0]).getByTestId('amount-input-NGN-0')).toHaveValue(1000);
    expect(within(ngnRows[0]).getByTestId('label-input-NGN-0')).toHaveValue('₦1,000 credit');
    expect(within(ngnRows[1]).getByTestId('amount-input-NGN-1')).toHaveValue(5000);
    expect(within(ngnRows[1]).getByTestId('description-input-NGN-1')).toHaveValue('Best value');

    // GHS
    const ghsRow = screen.getByTestId('package-row-GHS-0');
    expect(within(ghsRow).getByTestId('amount-input-GHS-0')).toHaveValue(100);
  });

  // TC4 — Save sends exact JSON shape: major→minor conversion, blank description omitted
  it('4. Save sends exact minor-unit JSON body to commercial route', async () => {
    seedTopupPackages({});

    await navigateToMessagingTab();

    const editor = screen.getByTestId('topup-packages-editor');

    // Add NGN package
    await user.click(within(editor).getByTestId('add-row-NGN'));
    await user.clear(screen.getByTestId('amount-input-NGN-0'));
    await user.type(screen.getByTestId('amount-input-NGN-0'), '1000');
    await user.type(screen.getByTestId('label-input-NGN-0'), '₦1,000 credit');
    // Leave description blank intentionally

    // Add USD package
    await user.click(within(editor).getByTestId('add-row-USD'));
    await user.clear(screen.getByTestId('amount-input-USD-0'));
    await user.type(screen.getByTestId('amount-input-USD-0'), '10');
    await user.type(screen.getByTestId('label-input-USD-0'), '$10 credit');

    // Save must be enabled
    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    expect(saveBtn).not.toBeDisabled();

    // Click Save
    await user.click(saveBtn);

    // useStepUp.execute called onAuthorized('mock-step-up-id') immediately,
    // which called fetch with the exact body.
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const fetchBody = JSON.parse(fetchCall[1]?.body as string);

    expect(fetchBody.key).toBe('messaging_topup_packages');
    expect(fetchBody.stepUpId).toBe('mock-step-up-id');
    expect(fetchBody.description).toBeNull();

    // NGN: 1000 major × 100 = 100000 minor
    expect(fetchBody.value.NGN).toEqual([
      { amount_minor: 100000, label: '₦1,000 credit' },
    ]);
    // USD: 10 major × 100 = 1000 minor; no description key
    expect(fetchBody.value.USD).toEqual([
      { amount_minor: 1000, label: '$10 credit' },
    ]);
    // Blank description must NOT be present in the package object
    expect(fetchBody.value.NGN[0]).not.toHaveProperty('description');
    expect(fetchBody.value.USD[0]).not.toHaveProperty('description');
  });

  // TC5 — negative amount
  it('5. Negative amount shows error and Save is disabled', async () => {
    seedTopupPackages({});

    await navigateToMessagingTab();
    const editor = screen.getByTestId('topup-packages-editor');

    await user.click(within(editor).getByTestId('add-row-NGN'));

    const amountInput = screen.getByTestId('amount-input-NGN-0');
    const labelInput = screen.getByTestId('label-input-NGN-0');

    await user.type(labelInput, 'test');
    await user.clear(amountInput);
    await user.type(amountInput, '-500');

    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    expect(saveBtn).toBeDisabled();
  });

  // TC6 — zero amount
  it('6. Zero amount shows error and Save is disabled', async () => {
    seedTopupPackages({});

    await navigateToMessagingTab();
    const editor = screen.getByTestId('topup-packages-editor');

    await user.click(within(editor).getByTestId('add-row-NGN'));

    const amountInput = screen.getByTestId('amount-input-NGN-0');
    const labelInput = screen.getByTestId('label-input-NGN-0');

    await user.type(labelInput, 'test');
    await user.clear(amountInput);
    await user.type(amountInput, '0');

    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    expect(saveBtn).toBeDisabled();
  });

  // TC7 — decimal amount: "whole-number" error visible AND Save is disabled
  // Root fix: serializeTopupPackages now produces amount_minor=0 for non-integer major
  // (instead of Math.round which silently rounded 1000.5 → 100050, a valid integer).
  it('7. Decimal amount shows "whole-number" error and Save is disabled', async () => {
    seedTopupPackages({});

    await navigateToMessagingTab();
    const editor = screen.getByTestId('topup-packages-editor');

    await user.click(within(editor).getByTestId('add-row-NGN'));

    // Add a label so the only error is the decimal amount
    const labelInput = screen.getByTestId('label-input-NGN-0');
    await user.type(labelInput, 'test');

    // Use fireEvent.change to set a decimal value — bypasses the keydown
    // blocker (which prevents '.' from being typed), simulating a paste or
    // programmatic set from a browser autofill.
    const amountInput = screen.getByTestId('amount-input-NGN-0');
    fireEvent.change(amountInput, { target: { value: '1000.5' } });

    // The UI must show the "whole number" error
    expect(screen.getByText(/whole.number/i)).toBeInTheDocument();

    // Save must be disabled: serializeTopupPackages now emits amount_minor=0
    // for non-integer major, so validateTopupPackages catches am<=0.
    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    expect(saveBtn).toBeDisabled();
  });

  // TC8 — empty label
  it('8. Empty label shows error and Save is disabled', async () => {
    seedTopupPackages({});

    await navigateToMessagingTab();
    const editor = screen.getByTestId('topup-packages-editor');
    await user.click(within(editor).getByTestId('add-row-NGN'));

    const amountInput = screen.getByTestId('amount-input-NGN-0');
    await user.clear(amountInput);
    await user.type(amountInput, '1000');
    // Leave label empty

    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    expect(saveBtn).toBeDisabled();
  });

  // TC9 — duplicate amounts
  it('9. Duplicate amounts within a currency show error and Save is disabled', async () => {
    seedTopupPackages({
      NGN: [
        { amount_minor: 100000, label: '₦1,000 credit' },
      ],
    });

    await navigateToMessagingTab();

    // Add a second NGN row
    const editor = screen.getByTestId('topup-packages-editor');
    await user.click(within(editor).getByTestId('add-row-NGN'));

    // Fill in the same amount (1000 major = 100000 minor) and a label
    const amountInput = screen.getByTestId('amount-input-NGN-1');
    const labelInput = screen.getByTestId('label-input-NGN-1');

    await user.clear(amountInput);
    await user.type(amountInput, '1000');
    await user.type(labelInput, 'Duplicate');

    // Should show duplicate error and disable Save
    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    expect(saveBtn).toBeDisabled();
    expect(screen.getByText(/[Dd]uplicate/)).toBeInTheDocument();
  });

  // TC10 — source-code assertion
  it('10. Source-code assertion: messaging_topup_packages save uses saveCommercialViaStepUp', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve('src/pages/PlatformSettings.tsx'), 'utf-8');
    // messaging_topup_packages is in COMMERCIAL_KEYS
    expect(src).toContain("'messaging_topup_packages'");
    // Save path uses the step-up server route
    expect(src).toContain('saveCommercialViaStepUp');
    expect(src).toContain('/api/admin/platform-settings/commercial');
    // TopupPackagesEditor is defined
    expect(src).toContain('TopupPackagesEditor');
    // isTopupPackagesKey is used to branch the editor
    expect(src).toContain('isTopupPackagesKey');
  });

  // TC11 — data-loss: unknown currency + unknown field on package blocks Save
  // Verifies: (a) warning banner visible before any edit, (b) Save is disabled even
  // after an edit, because the serializer re-injects unknown data for the validator to catch.
  it('11. Unknown currency and unknown field on package block Save with clear error', async () => {
    // EUR is not an allowed currency; bonus is not a known package field.
    seedTopupPackages({
      NGN: [{ amount_minor: 100000, label: '₦1,000 credit', bonus: 'extra' }],
      EUR: [{ amount_minor: 10000, label: '€100 credit' }],
    });

    await navigateToMessagingTab();

    // Editor is shown (not "Not configured") since the key exists
    expect(screen.getByTestId('topup-packages-editor')).toBeInTheDocument();

    // Data-loss warning banner is visible immediately — no edit needed
    expect(screen.getByTestId('data-loss-warning')).toBeInTheDocument();
    // The unknown currency name must appear in the warning
    expect(screen.getByText(/EUR/)).toBeInTheDocument();

    // Make an edit to trigger `changed=true` and show the Save button.
    // Even after a valid edit, Save must remain disabled because the serializer
    // re-injects the unknown currency/fields so the validator catches them.
    const editor = screen.getByTestId('topup-packages-editor');
    await user.click(within(editor).getByTestId('add-row-GHS'));
    await user.type(screen.getByTestId('amount-input-GHS-0'), '100');
    await user.type(screen.getByTestId('label-input-GHS-0'), 'GH₵100 test');

    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    expect(saveBtn).toBeDisabled();
  });
});
