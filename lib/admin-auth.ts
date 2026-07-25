/**
 * Platform administrator authorization.
 *
 * Canonical authority: auth.users app_metadata.role
 *
 * This module provides the single shared helper that all /api/admin/* routes
 * and the admin application must use. It does NOT trust profiles.role for
 * admin authorization decisions.
 *
 * Usage:
 *   const admin = await requirePlatformAdmin(request);
 *   if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
 *   // admin.userId, admin.role are now available
 */

import type { NextRequest } from 'next/server';

export type PlatformAdminRole = 'admin' | 'support' | 'finance' | 'operations';

const PLATFORM_ADMIN_ROLES: PlatformAdminRole[] = ['admin', 'support', 'finance', 'operations'];

export interface PlatformAdmin {
  id: string;
  userId: string;
  email: string;
  role: PlatformAdminRole;
}

/**
 * Verify the caller is a legitimate platform administrator.
 *
 * Checks ONLY auth.users app_metadata.role (set server-side by Supabase Auth
 * admin operations, never user-writable).
 *
 * Does NOT trust:
 * - profiles.role
 * - raw_user_meta_data
 * - user_metadata
 *
 * Returns null when authorization fails (caller should return 401/403).
 */
export async function requirePlatformAdmin(
  request: NextRequest,
  options?: { requiredRole?: PlatformAdminRole | PlatformAdminRole[] },
): Promise<PlatformAdmin | null> {
  const { createServiceClient } = await import('@/lib/supabase/service');
  const supabase = createServiceClient();

  // Extract token from Authorization header (admin panel sends Bearer)
  // or from cookie-based session (dashboard impersonation validation)
  let userId: string | undefined;
  let email: string | undefined;
  let appMetadataRole: string | undefined;

  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');

  if (token) {
    const { data } = await supabase.auth.getUser(token);
    if (data?.user) {
      userId = data.user.id;
      email = data.user.email;
      appMetadataRole = data.user.app_metadata?.role;
    }
  }

  // Fallback: cookie-based session
  if (!userId) {
    const { createClient } = await import('@/lib/supabase/server');
    const cookieSupabase = await createClient();
    const { data: { user } } = await cookieSupabase.auth.getUser();
    if (user) {
      userId = user.id;
      email = user.email;
      appMetadataRole = user.app_metadata?.role;
    }
  }

  if (!userId) return null;

  // Validate app_metadata role — the ONLY trusted authority
  if (!appMetadataRole || !PLATFORM_ADMIN_ROLES.includes(appMetadataRole as PlatformAdminRole)) {
    return null;
  }

  const role = appMetadataRole as PlatformAdminRole;

  // Check required role if specified
  if (options?.requiredRole) {
    const required = Array.isArray(options.requiredRole) ? options.requiredRole : [options.requiredRole];
    if (!required.includes(role)) return null;
  }

  return { id: userId, userId, email: email || '', role };
}

/**
 * Verify that a stored user ID still has platform admin authority.
 * Used by impersonation validation to re-check the admin's status.
 */
export async function verifyAdminRole(
  userId: string,
  options?: { requiredRole?: PlatformAdminRole | PlatformAdminRole[] },
): Promise<boolean> {
  const { createServiceClient } = await import('@/lib/supabase/service');
  const supabase = createServiceClient();
  const { data } = await supabase.auth.admin.getUserById(userId);
  if (!data?.user) return false;

  const appMetadataRole = data.user.app_metadata?.role;
  if (!appMetadataRole || !PLATFORM_ADMIN_ROLES.includes(appMetadataRole as PlatformAdminRole)) {
    return false;
  }

  if (options?.requiredRole) {
    const required = Array.isArray(options.requiredRole) ? options.requiredRole : [options.requiredRole];
    if (!required.includes(appMetadataRole as PlatformAdminRole)) return false;
  }

  return true;
}

/**
 * Check if a role is full admin (not just support/finance/operations).
 */
export function isFullPlatformAdmin(admin: PlatformAdmin | null): boolean {
  return admin?.role === 'admin';
}
