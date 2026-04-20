import { supabase } from './supabase';

export type AdminRole = 'admin' | 'support';

export interface AdminSession {
  userId: string;
  email: string;
  role: AdminRole;
}

const ALLOWED_ROLES: AdminRole[] = ['admin', 'support'];

export async function requireAdminSession(): Promise<AdminSession> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;

  const user = sessionData?.session?.user;
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

  return { userId: user.id, email: user.email || '', role: profile.role as AdminRole };
}

/** Check if current admin session has full admin privileges (not just support). */
export function isFullAdmin(session: AdminSession | null): boolean {
  return session?.role === 'admin';
}
