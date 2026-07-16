import { supabase } from './supabase';

export type AdminRole = 'admin' | 'support' | 'finance' | 'operations';

export interface AdminSession {
  id?: string;
  userId: string;
  email: string;
  role: AdminRole;
}

const ALLOWED_ROLES: AdminRole[] = ['admin', 'support', 'finance', 'operations'];

export async function requireAdminSession(): Promise<AdminSession> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;

  const session = sessionData?.session;
  const user = session?.user;
  if (!user) {
    throw new Error('No active session. Sign in as an admin and try again.');
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) throw profileError;
  if (!profile || !ALLOWED_ROLES.includes(profile.role as AdminRole)) {
    throw new Error('Signed-in account does not have admin access.');
  }

  const dbRole = profile.role as AdminRole;

  // Cross-check JWT app_metadata.role against DB role for defense-in-depth.
  // If someone manages to UPDATE their own profiles.role, the JWT still has
  // the authoritative role set by the server via auth.admin.updateUserById().
  const jwtRole = user.app_metadata?.role as AdminRole | undefined;

  let effectiveRole: AdminRole;
  if (jwtRole && ALLOWED_ROLES.includes(jwtRole)) {
    // Both sources exist — use the MORE RESTRICTIVE one
    const roleRank: Record<AdminRole, number> = { operations: 0, support: 1, finance: 1, admin: 2 };
    effectiveRole = (roleRank[jwtRole] ?? 0) <= (roleRank[dbRole] ?? 0) ? jwtRole : dbRole;
  } else {
    // Legacy user without app_metadata.role — fall back to DB
    effectiveRole = dbRole;
  }

  // Warn on mismatch so we can audit and backfill app_metadata
  if (jwtRole && jwtRole !== dbRole) {
    console.warn(`[ADMIN AUTH] Role mismatch: JWT=${jwtRole}, DB=${dbRole}. Using ${effectiveRole}`);
  }

  return { userId: user.id, email: user.email || '', role: effectiveRole };
}

/** Check if current admin session has full admin privileges (not just support). */
export function isFullAdmin(session: AdminSession | null): boolean {
  return session?.role === 'admin';
}
