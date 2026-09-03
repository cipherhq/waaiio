/**
 * AdminTeam component regression tests for audit partial failure (#217)
 *
 * Proves the UI correctly handles:
 * 1. Grant returning 207 / ROLE_MUTATION_APPLIED_AUDIT_FAILED shows warning, not success
 * 2. Revoke returning 207 shows warning
 * 3. Normal 200 success retains normal behavior
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Hoisted mocks ──

const { mockFetch, mockGetSession } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  const mockGetSession = vi.fn();
  return { mockFetch, mockGetSession };
});

// Mock fetch globally
vi.stubGlobal('fetch', mockFetch);

// Mock supabase
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

// Mock AdminLayout
vi.mock('@/components/AdminLayout', () => ({
  useAdminSession: () => ({ userId: 'admin-1', email: 'admin@test.com', role: 'admin' }),
}));

// Mock components used by AdminTeam
vi.mock('@/components/Pagination', () => ({
  Pagination: () => null,
}));
vi.mock('@/components/DetailModal', () => ({
  DetailModal: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <div data-testid="detail-modal">{children}</div> : null,
  DetailRow: ({ label, value }: { label: string; value: unknown }) => <div>{label}: {String(value)}</div>,
}));
vi.mock('@/components/SummaryCard', () => ({
  SummaryCard: () => null,
}));
vi.mock('@/lib/formatters', () => ({
  fmtDateTime: (d: string) => d,
}));

import AdminTeam from '../pages/AdminTeam';

function setupMocks() {
  mockGetSession.mockResolvedValue({
    data: { session: { access_token: 'test-token' } },
  });

  // Default: GET returns one admin
  mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (opts?.method === 'GET' || !opts?.method) {
      return new Response(JSON.stringify({
        team: [{ id: 'admin-1', email: 'admin@test.com', role: 'admin', firstName: 'Admin', lastName: 'User', phone: null }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
}

describe('AdminTeam audit partial failure UI (#217)', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  async function openInviteAndSubmit(role = 'support', email = 'target@test.com') {
    render(<AdminTeam />);

    // Wait for team to load
    await waitFor(() => {
      expect(screen.getByText('Admin Team')).toBeInTheDocument();
    });

    // Click Add Team Member
    await user.click(screen.getByRole('button', { name: /Add Team Member/i }));

    // Fill email
    const emailInput = screen.getByPlaceholderText(/user@example.com or UUID/i);
    await user.clear(emailInput);
    await user.type(emailInput, email);

    // Click Assign Role
    await user.click(screen.getByRole('button', { name: /Assign Role/i }));
  }

  it('1. Grant 207 partial failure: shows warning, not green success', async () => {
    // Mock POST to return 207 audit partial failure
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return new Response(JSON.stringify({
          error: 'ROLE_MUTATION_APPLIED_AUDIT_FAILED',
          message: 'Role change was applied, but the audit record could not be written.',
          mutationApplied: true,
          auditRecorded: false,
          user: { id: 'target-1', email: 'target@test.com', role: 'support' },
          operation: 'grant_platform_role',
        }), { status: 207, headers: { 'Content-Type': 'application/json' } });
      }
      // GET list
      return new Response(JSON.stringify({ team: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await openInviteAndSubmit();

    // Must show the audit failure warning (red error box), NOT the green success
    await waitFor(() => {
      const warning = screen.getByText(/audit record could not be written/i);
      expect(warning).toBeInTheDocument();
    });

    // Must NOT show the green "has been assigned" success message
    expect(screen.queryByText(/has been assigned/i)).not.toBeInTheDocument();
  });

  it('2. Normal 200 success: shows green success message', async () => {
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          mutationApplied: true,
          auditRecorded: true,
          user: { id: 'target-1', email: 'target@test.com', role: 'support' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ team: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await openInviteAndSubmit();

    await waitFor(() => {
      expect(screen.getByText(/has been assigned/i)).toBeInTheDocument();
    });

    // Must NOT show audit failure warning
    expect(screen.queryByText(/audit record could not be written/i)).not.toBeInTheDocument();
  });

  it('3. Revoke 207 partial failure: shows warning via alert', async () => {
    // Setup: render with a team member to revoke
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'DELETE') {
        return new Response(JSON.stringify({
          error: 'ROLE_MUTATION_APPLIED_AUDIT_FAILED',
          mutationApplied: true,
          auditRecorded: false,
          user: { id: 'target-1', email: 'target@test.com' },
          operation: 'revoke_platform_role',
        }), { status: 207, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        team: [
          { id: 'admin-1', email: 'admin@test.com', role: 'admin', firstName: 'Admin', lastName: 'User', phone: null },
          { id: 'target-1', email: 'target@test.com', role: 'support', firstName: 'Target', lastName: 'User', phone: null },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    render(<AdminTeam />);

    // Wait for team to load and click the target row
    await waitFor(() => {
      expect(screen.getByText('target@test.com')).toBeInTheDocument();
    });
    await user.click(screen.getByText('target@test.com'));

    // Click Remove Platform Role in the detail modal
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Remove Platform Role/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Remove Platform Role/i }));

    // Confirm dialog was shown
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
    });

    // The 207 response triggers an alert about audit failure
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('audit'));
    });

    alertSpy.mockRestore();
    confirmSpy.mockRestore();
  });
});
