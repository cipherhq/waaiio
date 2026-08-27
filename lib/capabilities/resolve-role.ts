import type { SupabaseClient } from '@supabase/supabase-js';

export type BusinessRole = 'owner' | 'admin' | 'manager' | 'staff' | 'finance' | 'support';

export type RoleResolution =
  | { ok: true; role: BusinessRole; isOwner: boolean }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'db_error' };

export async function resolveBusinessRole(
  service: SupabaseClient,
  businessId: string,
  userId: string,
): Promise<RoleResolution> {
  // 1. Check businesses.owner_id
  const { data: biz, error: bizErr } = await service
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', userId)
    .maybeSingle();

  if (bizErr) return { ok: false, error: 'db_error' };
  if (biz) return { ok: true, role: 'owner', isOwner: true };

  // 2. Check business_members (active only)
  const { data: member, error: memberErr } = await service
    .from('business_members')
    .select('role')
    .eq('business_id', businessId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();

  if (memberErr) return { ok: false, error: 'db_error' };
  if (member) return { ok: true, role: member.role as BusinessRole, isOwner: false };

  return { ok: false, error: 'not_found' };
}
