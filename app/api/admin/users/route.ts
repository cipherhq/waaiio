/**
 * GET /api/admin/users — account status for the admin Users list (#1108 X2).
 *
 * Returns the IDs of suspended (Auth-banned) accounts and the platform role of
 * each platform team member, both from Supabase Auth. The page used to read
 * these from `profiles.metadata` and `profiles.role`, which never held them.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminPreflight, adminResponder } from '@/lib/admin-route';

const METHODS = 'GET, OPTIONS';
const PLATFORM_ROLES = new Set(['admin', 'support', 'finance', 'operations']);
const PER_PAGE = 1000;
const MAX_PAGES = 20;

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request, METHODS);
}

export async function GET(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);

  const service = createServiceClient();
  const suspendedIds: string[] = [];
  const platformRoles: Record<string, string> = {};
  const now = Date.now();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) return reply({ error: 'Could not load account status' }, 500);
    const users = data?.users || [];
    for (const u of users as Array<{ id: string; banned_until?: string | null; app_metadata?: Record<string, unknown> }>) {
      if (u.banned_until && new Date(u.banned_until).getTime() > now) suspendedIds.push(u.id);
      const role = u.app_metadata?.role;
      if (typeof role === 'string' && PLATFORM_ROLES.has(role)) platformRoles[u.id] = role;
    }
    if (users.length < PER_PAGE) return reply({ suspendedIds, platformRoles });
  }
  // Never report a partial list as complete.
  return reply({ error: 'Too many accounts to load status in one request' }, 500);
}
