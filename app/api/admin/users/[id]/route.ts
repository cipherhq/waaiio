/**
 * /api/admin/users/[id] — admin Users page account status and role (#1108 X2).
 *
 * The page used to write `profiles.metadata` (no such column) and
 * `profiles.role` with the browser client (no admin UPDATE policy), and
 * reported success either way.
 *
 * - Suspension is a Supabase Auth ban: the person cannot sign in or refresh a
 *   session until reactivated. It is the only account-level block that exists.
 * - The account role is `profiles.role`, limited to the account values of the
 *   `user_role` enum. Platform roles (admin, support, finance, operations) live
 *   in Auth app_metadata and are managed only on Admin Team, so platform team
 *   members and the signed-in admin are refused here.
 *
 *   GET                                                → { status, bannedUntil, platformRole }
 *   POST { action: 'suspend' | 'reactivate' }
 *   POST { action: 'set_role', role, previous_role }
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminPreflight, adminRequestIp, adminResponder, readJsonObject, UUID_RE } from '@/lib/admin-route';

const METHODS = 'GET, POST, OPTIONS';
const PLATFORM_ROLES = new Set(['admin', 'support', 'finance', 'operations']);
const ACCOUNT_ROLES = ['restaurant_owner', 'restaurant_staff'] as const;
// Supabase Auth has no permanent ban; 100 years is the conventional stand-in.
const SUSPEND_DURATION = '876000h';

type AuthUser = { id: string; email?: string | null; banned_until?: string | null; app_metadata?: Record<string, unknown> };

function isBanned(user: AuthUser): boolean {
  return !!user.banned_until && new Date(user.banned_until).getTime() > Date.now();
}

function platformRole(user: AuthUser): string | null {
  const role = user.app_metadata?.role;
  return typeof role === 'string' && PLATFORM_ROLES.has(role) ? role : null;
}

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request, METHODS);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const reply = adminResponder(request, METHODS);
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const { id } = await params;
  if (!UUID_RE.test(id)) return reply({ error: 'Invalid user ID' }, 400);

  const service = createServiceClient();
  const { data, error } = await service.auth.admin.getUserById(id);
  if (error || !data?.user) return reply({ error: 'User not found' }, 404);
  const user = data.user as AuthUser;
  return reply({
    status: isBanned(user) ? 'suspended' : 'active',
    bannedUntil: user.banned_until ?? null,
    platformRole: platformRole(user),
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const reply = adminResponder(request, METHODS);
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const { id } = await params;
  if (!UUID_RE.test(id)) return reply({ error: 'Invalid user ID' }, 400);
  const body = await readJsonObject(request);
  const action = body?.action;
  if (action !== 'suspend' && action !== 'reactivate' && action !== 'set_role') {
    return reply({ error: 'Invalid user action' }, 400);
  }
  if (id === admin.userId) return reply({ error: 'You cannot change your own account here.' }, 409);

  const service = createServiceClient();
  const { data: found, error: findError } = await service.auth.admin.getUserById(id);
  if (findError || !found?.user) return reply({ error: 'User not found' }, 404);
  const target = found.user as AuthUser;
  if (platformRole(target)) {
    return reply({ error: 'This person is on the platform team. Manage them on the Admin Team page.' }, 409);
  }
  const audit = (name: string, details: Record<string, unknown>) => logAdminAudit({
    actorId: admin.userId, action: name, entityType: 'profile', entityId: id,
    details: { email: target.email ?? null, ...details }, ipAddress: adminRequestIp(request),
  });

  if (action === 'set_role') {
    const { role, previous_role: previous } = body as Record<string, unknown>;
    if (typeof role !== 'string' || !(ACCOUNT_ROLES as readonly string[]).includes(role)) {
      return reply({ error: 'Invalid role' }, 400);
    }
    if (typeof previous !== 'string') return reply({ error: 'Previous role is required' }, 400);
    const { data: saved, error } = await service.from('profiles').update({ role })
      .eq('id', id).eq('role', previous).select('id, role').maybeSingle();
    if (error) return reply({ error: 'Failed to change role' }, 500);
    if (!saved) return reply({ error: 'Role was not changed. It may have changed already; refresh and try again.' }, 409);
    const logged = await audit('change_user_role', { previous_role: previous, new_role: saved.role });
    return reply({ role: saved.role, auditRecorded: !logged.error });
  }

  const suspend = action === 'suspend';
  if (isBanned(target) === suspend) {
    return reply({ error: suspend ? 'User is already suspended.' : 'User is not suspended.' }, 409);
  }
  const { data: updated, error } = await service.auth.admin.updateUserById(id, { ban_duration: suspend ? SUSPEND_DURATION : 'none' });
  if (error || !updated?.user) return reply({ error: 'Failed to update user status' }, 500);
  const nowBanned = isBanned(updated.user as AuthUser);
  if (nowBanned !== suspend) return reply({ error: 'User status did not change. Refresh and check.' }, 409);
  const logged = await audit(suspend ? 'suspend_user' : 'reactivate_user', {
    previous_status: suspend ? 'active' : 'suspended', new_status: suspend ? 'suspended' : 'active',
  });
  return reply({ status: suspend ? 'suspended' : 'active', auditRecorded: !logged.error });
}
