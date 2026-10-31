import type { SupabaseClient, User } from '@supabase/supabase-js';

/** Exhaustive, fail-closed email collision check for privileged invitation flows. */
export async function findAuthUser(service: SupabaseClient, email: string): Promise<User | null> {
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const match = data.users.find(user => user.email?.toLowerCase() === email.toLowerCase());
    if (match) return match;
    if (data.users.length < 100) return null;
  }
  throw new Error('Unable to complete existing-user check');
}

export async function authUserExists(service: SupabaseClient, email: string): Promise<boolean> {
  return (await findAuthUser(service, email)) !== null;
}
