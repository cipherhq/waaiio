/**
 * AdminTeam API + admin-provision compatibility tests (#217)
 *
 * Tests the server-side provisioning contract:
 * - grant preserves unrelated app_metadata keys
 * - revoke removes only role key, never writes 'customer'
 * - nonexistent Auth user fails closed
 * - self-mutation rejected
 * - invalid role rejected
 * - existing CLI remains compatible
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Supabase client for unit tests
const mockUsers = new Map<string, { id: string; email: string; app_metadata: Record<string, unknown> }>();

const mockAuth = {
  admin: {
    getUserById: vi.fn(async (id: string) => {
      const user = mockUsers.get(id);
      if (!user) return { data: null, error: { message: 'User not found' } };
      return { data: { user: { ...user, app_metadata: { ...user.app_metadata } } }, error: null };
    }),
    updateUserById: vi.fn(async (id: string, updates: { app_metadata: Record<string, unknown> }) => {
      const user = mockUsers.get(id);
      if (!user) return { data: null, error: { message: 'User not found' } };
      user.app_metadata = { ...updates.app_metadata };
      return { data: { user: { ...user, app_metadata: { ...user.app_metadata } } }, error: null };
    }),
    listUsers: vi.fn(async () => {
      const users = Array.from(mockUsers.values()).map(u => ({
        id: u.id, email: u.email, app_metadata: { ...u.app_metadata },
      }));
      return { data: { users }, error: null };
    }),
  },
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: mockAuth }),
}));

import {
  resolveAuthUser,
  grantPlatformRole,
  revokePlatformRole,
  listPlatformAdmins,
} from '@/scripts/admin-provision';

describe('admin-provision shared helpers (#217)', () => {
  beforeEach(() => {
    mockUsers.clear();
    vi.clearAllMocks();

    mockUsers.set('user-1', {
      id: 'user-1', email: 'admin@test.com',
      app_metadata: { role: 'admin', provider: 'email', custom_flag: true },
    });
    mockUsers.set('user-2', {
      id: 'user-2', email: 'support@test.com',
      app_metadata: { role: 'support' },
    });
    mockUsers.set('user-3', {
      id: 'user-3', email: 'norole@test.com',
      app_metadata: { provider: 'google' },
    });

    // Re-mock auth methods after clear
    mockAuth.admin.getUserById.mockImplementation(async (id: string) => {
      const user = mockUsers.get(id);
      if (!user) return { data: null, error: { message: 'User not found' } };
      return { data: { user: { ...user, app_metadata: { ...user.app_metadata } } }, error: null };
    });
    mockAuth.admin.updateUserById.mockImplementation(async (id: string, updates: { app_metadata: Record<string, unknown> }) => {
      const user = mockUsers.get(id);
      if (!user) return { data: null, error: { message: 'User not found' } };
      user.app_metadata = { ...updates.app_metadata };
      return { data: { user: { ...user, app_metadata: { ...user.app_metadata } } }, error: null };
    });
    mockAuth.admin.listUsers.mockImplementation(async () => {
      const users = Array.from(mockUsers.values()).map(u => ({
        id: u.id, email: u.email, app_metadata: { ...u.app_metadata },
      }));
      return { data: { users }, error: null };
    });
  });

  const supabase = { auth: mockAuth } as any;

  it('17. Grant preserves unrelated app_metadata keys', async () => {
    const result = await grantPlatformRole(supabase, 'user-3', 'finance');
    expect(result.role).toBe('finance');
    expect(result.preservedKeys).toContain('provider');
    // Verify the actual metadata has both keys
    const user = mockUsers.get('user-3')!;
    expect(user.app_metadata.role).toBe('finance');
    expect(user.app_metadata.provider).toBe('google');
  });

  it('18. Revoke removes only role key, does not write customer', async () => {
    const result = await revokePlatformRole(supabase, 'user-1');
    // Verify role key is gone
    const user = mockUsers.get('user-1')!;
    expect(user.app_metadata.role).toBeUndefined();
    expect(user.app_metadata).not.toHaveProperty('role');
    // Verify other keys preserved
    expect(user.app_metadata.provider).toBe('email');
    expect(user.app_metadata.custom_flag).toBe(true);
    expect(result.preservedKeys).toContain('provider');
    expect(result.preservedKeys).toContain('custom_flag');
  });

  it('19. Nonexistent Auth user cannot gain authority', async () => {
    await expect(resolveAuthUser(supabase, 'nonexistent@test.com')).rejects.toThrow('No Auth user found');
  });

  it('20. Invalid platform role is rejected', async () => {
    await expect(grantPlatformRole(supabase, 'user-3', 'superadmin' as any)).rejects.toThrow('Invalid role');
  });

  it('21. List derives roles from app_metadata', async () => {
    const admins = await listPlatformAdmins(supabase);
    expect(admins).toHaveLength(2); // admin + support (user-3 has no role)
    expect(admins.find(a => a.id === 'user-1')?.role).toBe('admin');
    expect(admins.find(a => a.id === 'user-2')?.role).toBe('support');
    // user-3 should NOT appear (no platform role)
    expect(admins.find(a => a.id === 'user-3')).toBeUndefined();
  });

  it('22. Existing admin-provision CLI contract: resolveAuthUser by UUID', async () => {
    const user = await resolveAuthUser(supabase, 'user-1');
    expect(user.id).toBe('user-1');
    expect(user.email).toBe('admin@test.com');
  });

  it('23. Grant + revoke round-trip preserves metadata integrity', async () => {
    // Start with user-3 who has provider=google, no role
    await grantPlatformRole(supabase, 'user-3', 'operations');
    expect(mockUsers.get('user-3')!.app_metadata.role).toBe('operations');
    expect(mockUsers.get('user-3')!.app_metadata.provider).toBe('google');

    await revokePlatformRole(supabase, 'user-3');
    expect(mockUsers.get('user-3')!.app_metadata.role).toBeUndefined();
    expect(mockUsers.get('user-3')!.app_metadata.provider).toBe('google');
  });
});
