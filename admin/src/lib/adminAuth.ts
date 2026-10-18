import { supabase } from './supabase';

export type AdminRole = 'admin' | 'support' | 'finance' | 'operations';

export interface AdminSession {
  id?: string;
  userId: string;
  email: string;
  role: AdminRole;
}

const ALLOWED_ROLES: AdminRole[] = ['admin', 'support', 'finance', 'operations'];

/**
 * Require a platform admin session with MFA assurance.
 *
 * Canonical authority: auth.users app_metadata.role
 * SEC-005: Also checks aal2 assurance level (defense-in-depth;
 * the server enforces this independently in requirePlatformAdmin).
 *
 * Does NOT trust profiles.role for admin authorization.
 * Does NOT fall back to profiles.role when app_metadata is absent.
 * Does NOT trust raw_user_meta_data.
 */
export async function requireAdminSession(): Promise<AdminSession> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;

  const session = sessionData?.session;
  const user = session?.user;
  if (!user) {
    throw new Error('No active session. Sign in as an admin and try again.');
  }

  // Canonical authority: app_metadata.role (set server-side, never user-writable)
  const appMetadataRole = user.app_metadata?.role as AdminRole | undefined;

  if (!appMetadataRole || !ALLOWED_ROLES.includes(appMetadataRole)) {
    throw new Error('Signed-in account does not have admin access.');
  }

  // SEC-005: Check MFA assurance level (client-side defense-in-depth)
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (!aalData || aalData.currentLevel !== 'aal2') {
    throw new Error('MFA verification required. Please complete two-factor authentication.');
  }

  return { userId: user.id, email: user.email || '', role: appMetadataRole };
}

/** Check if current admin session has full admin privileges (not just support). */
export function isFullAdmin(session: AdminSession | null): boolean {
  return session?.role === 'admin';
}
