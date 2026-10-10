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

// ---------------------------------------------------------------------------
// Verified JWT claims contract
//
// Claims are read from the JWT payload ONLY after getUser(token) has
// validated the token's signature, expiry, and issuer against the Supabase
// Auth server (GoTrue JWKS/HMAC check). getUser() is the cryptographic
// verification step. The payload is trustworthy BECAUSE validation succeeded.
//
// Callers must NEVER decode claims from an unvalidated token. The only
// entry point is getVerifiedClaims() which performs both validation and
// claim extraction atomically.
// ---------------------------------------------------------------------------

interface VerifiedClaims {
  userId: string;
  email: string;
  appMetadataRole: string | undefined;
  aal: string | undefined;
  sessionId: string | undefined;
  amr: Array<{ method: string; timestamp: number }> | undefined;
}

/**
 * Validate a bearer token AND extract its claims in a single operation.
 *
 * Step 1: getUser(token) validates the JWT against the Supabase Auth server.
 * Step 2: If valid, decode the payload to read aal, session_id, amr.
 *
 * Returns null if the token is invalid, expired, or malformed.
 */
async function getVerifiedClaims(
  supabase: ReturnType<typeof import('@/lib/supabase/service').createServiceClient>,
  token: string,
): Promise<VerifiedClaims | null> {
  // Step 1: Cryptographic verification via Supabase Auth server
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  // Step 2: Read claims from the now-validated JWT payload
  const payload = decodeJwtPayload(token);
  if (!payload) return null;

  return {
    userId: data.user.id,
    email: data.user.email || '',
    appMetadataRole: data.user.app_metadata?.role,
    aal: payload.aal as string | undefined,
    sessionId: payload.session_id as string | undefined,
    amr: payload.amr as Array<{ method: string; timestamp: number }> | undefined,
  };
}

/** Decode JWT payload — ONLY called after getUser() validation succeeds. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base64, 'base64').toString());
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

  let claims: VerifiedClaims | null = null;
  let token: string | undefined;

  const authHeader = request.headers.get('Authorization');
  const hasExplicitBearer = !!(authHeader && authHeader.startsWith('Bearer '));

  if (hasExplicitBearer) {
    token = authHeader!.replace('Bearer ', '');

    // Validate AND extract claims atomically via getVerifiedClaims
    claims = await getVerifiedClaims(supabase, token);

    if (!claims) {
      // Bearer token was provided but is invalid.
      // FAIL CLOSED: do NOT fall back to cookie auth.
      await logAdminAuthEvent(supabase, {
        action: 'admin_auth_denied',
        details: { reason: 'invalid_bearer_token' },
        ipAddress: getRequestIp(request),
      });
      return null;
    }
  } else {
    // No Authorization header — use cookie-based session.
    // SECURITY: getSession() does NOT verify the JWT — it trusts the cookie.
    // We MUST call getUser() first, which validates the token server-side
    // via the Supabase Auth server, before reading any claims.
    const { createClient } = await import('@/lib/supabase/server');
    const cookieSupabase = await createClient();

    // Step 1: Validate the cookie JWT via the Auth server (getUser verifies)
    const { data: { user }, error: userError } = await cookieSupabase.auth.getUser();
    if (userError || !user) {
      return null;
    }

    // Step 2: Token is validated. Extract the raw JWT for claim decoding.
    // getSession() is safe here ONLY because getUser() just proved the
    // cookie token is genuine. We never trust getSession() alone.
    const { data: sessionData } = await cookieSupabase.auth.getSession();
    token = sessionData?.session?.access_token;
    if (!token) return null;

    // Step 3: Build verified claims from validated user + decoded JWT payload
    const payload = decodeJwtPayload(token);
    claims = {
      userId: user.id,
      email: user.email || '',
      appMetadataRole: user.app_metadata?.role,
      aal: payload?.aal as string | undefined,
      sessionId: payload?.session_id as string | undefined,
      amr: payload?.amr as Array<{ method: string; timestamp: number }> | undefined,
    };
  }

  if (!claims || !token) {
    return null;
  }

  const { userId, email, appMetadataRole, aal: jwtAal } = claims;

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
