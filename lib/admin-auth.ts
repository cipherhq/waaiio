/**
 * Platform administrator authorization.
 *
 * Canonical authority: auth.users app_metadata.role + verified JWT aal claim.
 *
 * This module provides the single shared helper that all /api/admin/* routes
 * and the admin application must use. It does NOT trust profiles.role for
 * admin authorization decisions.
 *
 * SEC-005: Every privileged admin access path requires server-verified aal2.
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
  /** The verified aal claim from the incoming JWT. */
  aal: string;
  /** The raw bearer token for downstream MFA operations. */
  bearerToken: string;
}

/**
 * Decode JWT payload claims AFTER the token has been validated by getUser().
 *
 * This is safe because getUser() already verified the JWT signature and
 * validity against the Supabase Auth server. We read claims from the
 * validated token — not from an unverified source.
 */
function getVerifiedJwtClaims(token: string): {
  aal?: string;
  amr?: Array<{ method: string; timestamp: number }>;
  session_id?: string;
  sub?: string;
  exp?: number;
} | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // base64url decode
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(base64, 'base64').toString());
    return payload;
  } catch {
    return null;
  }
}

/**
 * Verify the caller is a legitimate platform administrator with aal2.
 *
 * Checks ONLY auth.users app_metadata.role (set server-side by Supabase Auth
 * admin operations, never user-writable) AND the verified JWT aal claim.
 *
 * Does NOT trust:
 * - profiles.role
 * - raw_user_meta_data / user_metadata
 * - Client-declared aal headers, cookies, or localStorage
 *
 * Bearer-to-cookie fallback rule: If an Authorization header is present but
 * the Bearer token is invalid, we FAIL CLOSED — we do NOT silently switch
 * to cookie-based auth. Cookie fallback is only used when NO Authorization
 * header is present.
 *
 * Returns null when authorization fails (caller should return 401/403).
 */
export async function requirePlatformAdmin(
  request: NextRequest,
  options?: { requiredRole?: PlatformAdminRole | PlatformAdminRole[] },
): Promise<PlatformAdmin | null> {
  const { createServiceClient } = await import('@/lib/supabase/service');
  const supabase = createServiceClient();

  let userId: string | undefined;
  let email: string | undefined;
  let appMetadataRole: string | undefined;
  let token: string | undefined;
  let jwtAal: string | undefined;

  const authHeader = request.headers.get('Authorization');
  const hasExplicitBearer = !!(authHeader && authHeader.startsWith('Bearer '));

  if (hasExplicitBearer) {
    token = authHeader!.replace('Bearer ', '');

    // Validate the JWT against the Supabase Auth server (cryptographic verification)
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      // Bearer token was provided but is invalid.
      // FAIL CLOSED: do NOT fall back to cookie auth.
      await logAdminAuthEvent(supabase, {
        action: 'admin_auth_denied',
        details: { reason: 'invalid_bearer_token' },
        ipAddress: getRequestIp(request),
      });
      return null;
    }

    userId = data.user.id;
    email = data.user.email;
    appMetadataRole = data.user.app_metadata?.role;

    // Read aal from the now-validated JWT
    const claims = getVerifiedJwtClaims(token);
    jwtAal = claims?.aal;
  } else {
    // No Authorization header — use cookie-based session
    const { createClient } = await import('@/lib/supabase/server');
    const cookieSupabase = await createClient();
    const { data: { user } } = await cookieSupabase.auth.getUser();
    if (user) {
      userId = user.id;
      email = user.email;
      appMetadataRole = user.app_metadata?.role;

      // For cookie auth, get the session to read aal
      const { data: sessionData } = await cookieSupabase.auth.getSession();
      if (sessionData?.session?.access_token) {
        token = sessionData.session.access_token;
        const claims = getVerifiedJwtClaims(token);
        jwtAal = claims?.aal;
      }
    }
  }

  if (!userId || !token) {
    return null;
  }

  // Validate app_metadata role — the ONLY trusted authority
  if (!appMetadataRole || !PLATFORM_ADMIN_ROLES.includes(appMetadataRole as PlatformAdminRole)) {
    await logAdminAuthEvent(supabase, {
      action: 'admin_auth_denied',
      actorId: userId,
      details: { reason: 'invalid_role', role: appMetadataRole ?? null },
      ipAddress: getRequestIp(request),
    });
    return null;
  }

  const role = appMetadataRole as PlatformAdminRole;

  // Check required role if specified
  if (options?.requiredRole) {
    const required = Array.isArray(options.requiredRole) ? options.requiredRole : [options.requiredRole];
    if (!required.includes(role)) {
      return null;
    }
  }

  // SEC-005: Require aal2 (Supabase native MFA verified)
  if (jwtAal !== 'aal2') {
    await logAdminAuthEvent(supabase, {
      action: 'admin_auth_denied',
      actorId: userId,
      details: { reason: 'aal2_required', current_aal: jwtAal ?? 'missing' },
      ipAddress: getRequestIp(request),
    });
    return null;
  }

  return { id: userId, userId, email: email || '', role, aal: jwtAal, bearerToken: token };
}

/**
 * Verify that a stored user ID still has platform admin authority.
 * Used by impersonation validation to re-check the admin's status.
 * Does NOT check aal — that is checked at impersonation initiation.
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

/**
 * Extract the AMR (Authentication Methods Reference) from a validated JWT.
 * Used by step-up authorization to check MFA recency.
 */
export function getAmrFromToken(token: string): Array<{ method: string; timestamp: number }> | null {
  const claims = getVerifiedJwtClaims(token);
  return claims?.amr ?? null;
}

/**
 * Extract the session ID from a validated JWT.
 */
export function getSessionIdFromToken(token: string): string | null {
  const claims = getVerifiedJwtClaims(token);
  return claims?.session_id ?? null;
}

// ---------------------------------------------------------------------------
// Admin auth audit logging
// ---------------------------------------------------------------------------

function getRequestIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

interface AdminAuthLogEntry {
  action: string;
  actorId?: string;
  details: Record<string, unknown>;
  ipAddress: string;
}

async function logAdminAuthEvent(
  supabase: ReturnType<typeof import('@/lib/supabase/service').createServiceClient>,
  entry: AdminAuthLogEntry,
): Promise<void> {
  try {
    await supabase.from('admin_audit_logs').insert({
      actor_id: entry.actorId ?? null,
      action: entry.action,
      entity_type: 'admin_auth',
      details: entry.details,
      ip_address: entry.ipAddress,
    });
  } catch {
    // Audit logging failure must not block the auth flow
  }
}
