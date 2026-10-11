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
  /** Session ID extracted from the verified access token. */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Verified JWT claims via supabase.auth.getClaims()
//
// getClaims(token) performs cryptographic verification:
//   - If JWKS is available (RS256): verifies the signature locally using
//     the project's public key.
//   - If HMAC (HS256) or WebCrypto unavailable: falls back to getUser(token)
//     which validates server-side.
//
// We ALSO call getUser(token) independently to reject revoked sessions.
// getClaims alone proves the token was once valid; getUser proves the
// session is STILL active. Both must agree on the same subject (sub).
//
// app_metadata.role comes from getUser (server-authoritative, never
// user-writable). Claims (aal, session_id, amr) come from getClaims.
// ---------------------------------------------------------------------------

interface VerifiedClaims {
  userId: string;
  email: string;
  appMetadataRole: string | undefined;
  aal: string | undefined;
  sessionId: string | undefined;
  amr: Array<{ method: string; timestamp: number }> | undefined;
}

type SupabaseClient = ReturnType<typeof import('@/lib/supabase/service').createServiceClient>;

/**
 * Validate a bearer token via getClaims + getUser, extract claims.
 *
 * 1. getClaims(token) — cryptographic signature verification + claim extraction.
 * 2. getUser(token) — session-validity check (rejects revoked sessions).
 * 3. Require getClaims.sub === getUser.id (identity consistency).
 *
 * Returns null if the token is forged, expired, revoked, or malformed.
 */
async function getVerifiedClaims(
  supabase: SupabaseClient,
  token: string,
): Promise<VerifiedClaims | null> {
  // Step 1: Cryptographic verification via getClaims
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
  if (claimsError || !claimsData?.claims) return null;

  const claims = claimsData.claims as Record<string, unknown>;
  const sub = claims.sub as string | undefined;
  if (!sub) return null;

  // Step 2: Session-validity check — rejects revoked/expired sessions
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) return null;

  // Step 3: Identity consistency — getClaims sub must equal getUser id
  if (userData.user.id !== sub) return null;

  return {
    userId: sub,
    email: userData.user.email || '',
    appMetadataRole: userData.user.app_metadata?.role,
    aal: claims.aal as string | undefined,
    sessionId: claims.session_id as string | undefined,
    amr: claims.amr as Array<{ method: string; timestamp: number }> | undefined,
  };
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

    // Validate AND extract claims via getClaims + getUser
    claims = await getVerifiedClaims(supabase, token);

    if (!claims) {
      // Bearer token was provided but is invalid/forged/revoked.
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
    // getSession supplies an UNTRUSTED token candidate. We extract it,
    // then verify it through getClaims + getUser on the service client
    // (same verification path as Bearer tokens — no separate trust boundary).
    const { createClient } = await import('@/lib/supabase/server');
    const cookieSupabase = await createClient();

    const { data: sessionData } = await cookieSupabase.auth.getSession();
    token = sessionData?.session?.access_token;
    if (!token) return null;

    // Verify the cookie token through the same getClaims + getUser path
    claims = await getVerifiedClaims(supabase, token);
    if (!claims) return null;
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

  return { id: userId, userId, email: email || '', role, aal: jwtAal, bearerToken: token, sessionId: claims.sessionId };
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
  supabase: SupabaseClient,
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
