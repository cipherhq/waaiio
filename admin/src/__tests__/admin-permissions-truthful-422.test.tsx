import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { sessionState } = vi.hoisted(() => ({
  sessionState: { role: 'admin' as 'admin' | 'support' | 'finance' | 'operations' },
}));

vi.mock('@/components/AdminLayout', () => ({
  useAdminSession: () => ({
    userId: 'admin-422',
    email: 'admin@waaiio.test',
    role: sessionState.role,
  }),
}));

import AdminPermissions from '@/pages/AdminPermissions';
import { ADMIN_PERMISSIONS, hasAccess } from '@/lib/permissions';

describe('#422 truthful Admin permissions reference', () => {
  beforeEach(() => {
    sessionState.role = 'admin';
  });

  it('renders as read-only and exposes no permission mutation controls', () => {
    render(<AdminPermissions />);

    expect(screen.getByText('Platform Access Reference')).toBeInTheDocument();
    expect(screen.getByText(/Dynamic permission editing is intentionally disabled/i)).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /Save Changes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Permissions saved successfully/i)).not.toBeInTheDocument();
  });

  it('shows access using the exact ADMIN_PERMISSIONS route authority', () => {
    render(<AdminPermissions />);

    expect(ADMIN_PERMISSIONS.businesses).toContain('support');
    expect(screen.getByLabelText('support can access businesses')).toBeInTheDocument();

    expect(ADMIN_PERMISSIONS.payments).not.toContain('support');
    expect(screen.getByLabelText('support cannot access payments')).toBeInTheDocument();

    expect(ADMIN_PERMISSIONS.payments).toContain('finance');
    expect(screen.getByLabelText('finance can access payments')).toBeInTheDocument();

    expect(ADMIN_PERMISSIONS.verification).toContain('operations');
    expect(screen.getByLabelText('operations can access verification')).toBeInTheDocument();
  });

  it('keeps the Permissions page itself admin-only in the reference matrix', () => {
    render(<AdminPermissions />);

    expect(screen.getByLabelText('admin can access permissions')).toBeInTheDocument();
    expect(screen.getByLabelText('support cannot access permissions')).toBeInTheDocument();
    expect(screen.getByLabelText('finance cannot access permissions')).toBeInTheDocument();
    expect(screen.getByLabelText('operations cannot access permissions')).toBeInTheDocument();
  });

  it('fails closed for unknown page keys', () => {
    expect(hasAccess('definitely-not-a-real-admin-page', 'admin')).toBe(false);
    expect(hasAccess('definitely-not-a-real-admin-page', 'support')).toBe(false);
  });

  it('does not render the access reference to a non-admin session', () => {
    sessionState.role = 'support';
    render(<AdminPermissions />);

    expect(screen.getByText('Access Restricted')).toBeInTheDocument();
    expect(screen.queryByText('Platform Access Reference')).not.toBeInTheDocument();
  });
});
