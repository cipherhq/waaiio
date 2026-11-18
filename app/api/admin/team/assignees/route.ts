/**
 * GET /api/admin/team/assignees — who a support ticket can be assigned to
 * (#1108). The Support page read profiles.role, but platform roles live in Auth
 * app_metadata, so its "Assign to" list was always empty.
 *
 * Returns only id and display name for admin and support members. GET
 * /api/admin/team stays admin-only and keeps emails, roles and phones.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminPreflight, adminResponder } from '@/lib/admin-route';
import { listPlatformAdmins } from '@/scripts/admin-provision';

const METHODS = 'GET, OPTIONS';
const ASSIGNABLE_ROLES = new Set(['admin', 'support']);

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request, METHODS);
}

export async function GET(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  // Same roles that can open the Support page (admin/src/lib/permissions.ts).
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'support'] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const service = createServiceClient();
  try {
    // Roles come from Auth app_metadata (listPlatformAdmins), never profiles.role.
    const members = (await listPlatformAdmins(service)).filter(a => ASSIGNABLE_ROLES.has(a.role));
    const names = await displayNames(service, members.map(a => a.id));
    return reply({
      assignees: members.map(a => ({ id: a.id, name: names.get(a.id) || a.email.split('@')[0] || 'Admin' })),
    });
  } catch {
    return reply({ error: 'Could not load the support team' }, 500);
  }
}

/** First and last names from profiles, for display only. */
async function displayNames(service: ReturnType<typeof createServiceClient>, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data } = await service.from('profiles').select('id, first_name, last_name').in('id', ids);
  return new Map(((data || []) as Array<{ id: string; first_name: string | null; last_name: string | null }>)
    .map(p => [p.id, `${p.first_name || ''} ${p.last_name || ''}`.trim()]));
}
