/**
 * Admin Provisioning Tests
 *
 * Proves:
 * - Identity resolution uses ONLY Supabase Auth, never public.profiles
 * - Metadata is preserved through grant and revoke
 * - All Auth admin API errors fail closed
 * - Spoofed profile emails have no effect
 */
import { describe, it, expect, vi } from 'vitest';

// ── Mock Supabase client builder ──

interface MockUser {
  id: string;
  email: string;
  app_metadata: Record<string, unknown>;
  raw_user_meta_data?: Record<string, unknown>;
}

function buildMockClient(options: {
  users?: MockUser[];
  getUserByIdError?: string;
  updateError?: string;
  listError?: string;
  updateReturnsNull?: boolean;
}) {
  const { users = [], getUserByIdError, updateError, listError, updateReturnsNull } = options;
  // Track all metadata updates
  const updatedMetadata = new Map<string, Record<string, unknown>>();

  return {
    auth: {
      admin: {
        getUserById: vi.fn().mockImplementation(async (id: string) => {
          if (getUserByIdError) return { data: null, error: { message: getUserByIdError } };
          // Return updated metadata if it was changed
          const updated = updatedMetadata.get(id);
          const user = users.find(u => u.id === id);
          if (!user) return { data: { user: null }, error: null };
          return { data: { user: { ...user, app_metadata: updated || { ...user.app_metadata } } }, error: null };
        }),
        listUsers: vi.fn().mockImplementation(async () => {
          if (listError) return { data: { users: [] }, error: { message: listError } };
          return { data: { users }, error: null };
        }),
        updateUserById: vi.fn().mockImplementation(async (id: string, opts: { app_metadata: Record<string, unknown> }) => {
          if (updateError) return { data: null, error: { message: updateError } };
          if (updateReturnsNull) return { data: { user: null }, error: null };
          const user = users.find(u => u.id === id);
          if (!user) return { data: { user: null }, error: null };
          // Store the updated metadata
          updatedMetadata.set(id, { ...opts.app_metadata });
          return { data: { user: { ...user, app_metadata: { ...opts.app_metadata } } }, error: null };
        }),
      },
    },
    // Verify profiles is never queried
    from: vi.fn().mockImplementation(() => {
      throw new Error('public.profiles must not be queried for identity resolution');
    }),
  };
}

// Rich test metadata that must survive grant/revoke
const RICH_METADATA = {
  provider: 'example',
  plan: 'business',
  tenant: 'tenant-1',
  nested: { enabled: true, features: ['a', 'b'] },
};

// ═══════════════════════════════════════════════════════════
// 1. Identity resolution
// ═══════════════════════════════════════════════════════════

describe('resolveAuthUser', () => {
  it('UUID resolves through Auth admin API', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const client = buildMockClient({ users: [{ id: uuid, email: 'admin@test.com', app_metadata: {} }] });
    const { resolveAuthUser } = await import('@/scripts/admin-provision');
    const result = await resolveAuthUser(client as any, uuid);
    expect(result.id).toBe(uuid);
    expect(result.email).toBe('admin@test.com');
    expect(client.auth.admin.getUserById).toHaveBeenCalledWith(uuid);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('email lookup uses Auth admin listUsers, never profiles', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const client = buildMockClient({ users: [{ id: uuid, email: 'admin@test.com', app_metadata: {} }] });
    const { resolveAuthUser } = await import('@/scripts/admin-provision');
    const result = await resolveAuthUser(client as any, 'admin@test.com');
    expect(result.id).toBe(uuid);
    expect(client.auth.admin.listUsers).toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it('zero matching Auth emails fails', async () => {
    const client = buildMockClient({ users: [] });
    const { resolveAuthUser } = await import('@/scripts/admin-provision');
    await expect(resolveAuthUser(client as any, 'nobody@test.com')).rejects.toThrow('No Auth user found');
  });

  it('multiple matching Auth emails fails', async () => {
    const client = buildMockClient({
      users: [
        { id: 'u1', email: 'dup@test.com', app_metadata: {} },
        { id: 'u2', email: 'dup@test.com', app_metadata: {} },
      ],
    });
    const { resolveAuthUser } = await import('@/scripts/admin-provision');
    await expect(resolveAuthUser(client as any, 'dup@test.com')).rejects.toThrow('Multiple Auth users');
  });

  it('spoofed profile email has no effect — profiles table never queried', async () => {
    // A user has spoofed their public.profiles.email to match an admin's email
    // resolveAuthUser must NOT query profiles — the from() mock throws
    const client = buildMockClient({ users: [] });
    const { resolveAuthUser } = await import('@/scripts/admin-provision');
    await expect(resolveAuthUser(client as any, 'spoofed@admin.com')).rejects.toThrow('No Auth user found');
    // from() was never called
    expect(client.from).not.toHaveBeenCalled();
  });

  it('getUserById error fails closed', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const client = buildMockClient({ getUserByIdError: 'Connection refused' });
    const { resolveAuthUser } = await import('@/scripts/admin-provision');
    await expect(resolveAuthUser(client as any, uuid)).rejects.toThrow('Auth lookup failed');
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Grant with metadata preservation
// ═══════════════════════════════════════════════════════════

describe('grantPlatformRole', () => {
  it('preserves unrelated scalar and nested metadata', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const client = buildMockClient({
      users: [{ id: uuid, email: 'a@t.com', app_metadata: { ...RICH_METADATA } }],
    });
    const { grantPlatformRole } = await import('@/scripts/admin-provision');
    const result = await grantPlatformRole(client as any, uuid, 'admin');

    expect(result.role).toBe('admin');
    expect(result.preservedKeys).toEqual(['provider', 'plan', 'tenant', 'nested']);

    // Verify the exact metadata passed to updateUserById
    const updateCall = client.auth.admin.updateUserById.mock.calls[0];
    const sentMeta = updateCall[1].app_metadata;
    expect(sentMeta.role).toBe('admin');
    expect(sentMeta.provider).toBe('example');
    expect(sentMeta.plan).toBe('business');
    expect(sentMeta.tenant).toBe('tenant-1');
    expect(sentMeta.nested).toEqual({ enabled: true, features: ['a', 'b'] });
  });

  it('getUserById error prevents update', async () => {
    const client = buildMockClient({ getUserByIdError: 'Connection refused' });
    const { grantPlatformRole } = await import('@/scripts/admin-provision');
    await expect(grantPlatformRole(client as any, 'u1', 'admin')).rejects.toThrow('Failed to fetch');
    expect(client.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('missing fetched user prevents update', async () => {
    const client = buildMockClient({ users: [] });
    const { grantPlatformRole } = await import('@/scripts/admin-provision');
    await expect(grantPlatformRole(client as any, 'nonexistent', 'admin')).rejects.toThrow('No Auth user');
    expect(client.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('update error is surfaced', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const client = buildMockClient({
      users: [{ id: uuid, email: 'a@t.com', app_metadata: {} }],
      updateError: 'Database unavailable',
    });
    const { grantPlatformRole } = await import('@/scripts/admin-provision');
    await expect(grantPlatformRole(client as any, uuid, 'admin')).rejects.toThrow('Failed to update');
  });

  it('update returning null user is treated as failure', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const client = buildMockClient({
      users: [{ id: uuid, email: 'a@t.com', app_metadata: {} }],
      updateReturnsNull: true,
    });
    const { grantPlatformRole } = await import('@/scripts/admin-provision');
    await expect(grantPlatformRole(client as any, uuid, 'admin')).rejects.toThrow('Update returned no user');
  });

  it('invalid role is rejected', async () => {
    const client = buildMockClient({ users: [{ id: 'u1', email: 'a@t.com', app_metadata: {} }] });
    const { grantPlatformRole } = await import('@/scripts/admin-provision');
    await expect(grantPlatformRole(client as any, 'u1', 'superadmin' as any)).rejects.toThrow('Invalid role');
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Revoke with metadata preservation
// ═══════════════════════════════════════════════════════════

describe('revokePlatformRole', () => {
  it('removes only role, preserves all unrelated metadata', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const client = buildMockClient({
      users: [{ id: uuid, email: 'a@t.com', app_metadata: { role: 'admin', ...RICH_METADATA } }],
    });
    const { revokePlatformRole } = await import('@/scripts/admin-provision');
    const result = await revokePlatformRole(client as any, uuid);

    expect(result.preservedKeys).toEqual(['provider', 'plan', 'tenant', 'nested']);

    // Verify the metadata sent to updateUserById has no role but keeps everything else
    const updateCall = client.auth.admin.updateUserById.mock.calls[0];
    const sentMeta = updateCall[1].app_metadata;
    expect(sentMeta).not.toHaveProperty('role');
    expect(sentMeta.provider).toBe('example');
    expect(sentMeta.plan).toBe('business');
    expect(sentMeta.tenant).toBe('tenant-1');
    expect(sentMeta.nested).toEqual({ enabled: true, features: ['a', 'b'] });
  });

  it('fetch error prevents update', async () => {
    const client = buildMockClient({ getUserByIdError: 'Connection refused' });
    const { revokePlatformRole } = await import('@/scripts/admin-provision');
    await expect(revokePlatformRole(client as any, 'u1')).rejects.toThrow('Failed to fetch');
    expect(client.auth.admin.updateUserById).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Source-level: no profiles query in provisioning script
// ═══════════════════════════════════════════════════════════

describe('Provisioning script safety', () => {
  it('script source never queries public.profiles for identity', () => {
    const code = require('fs').readFileSync('scripts/admin-provision.ts', 'utf-8');
    // Must not use .from('profiles') for identity resolution
    expect(code).not.toContain("from('profiles')");
    expect(code).not.toContain('.from("profiles")');
    // Must use auth.admin APIs
    expect(code).toContain('auth.admin.getUserById');
    expect(code).toContain('auth.admin.listUsers');
    expect(code).toContain('auth.admin.updateUserById');
  });
});
