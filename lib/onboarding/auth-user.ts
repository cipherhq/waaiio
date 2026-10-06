import type { SupabaseClient } from '@supabase/supabase-js';

/** Exhaustive, fail-closed email collision check for privileged invitation flows. */
export async function authUserExists(service: SupabaseClient, email: string): Promise<boolean> {
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    if (data.users.some(user => user.email?.toLowerCase() === email.toLowerCase())) return true;
    if (data.users.length < 100) return false;
  }
  throw new Error('Unable to complete existing-user check');
}
