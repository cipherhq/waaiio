/**
 * POST /api/admin/alerts — mark alerts read/unread or dismiss one (#1108 X2).
 *
 * The browser client has no admin UPDATE policy and no DELETE grant on
 * `alerts`, so these actions matched 0 rows while the page showed them done.
 *
 * Body: { action: 'mark_read' | 'mark_unread', id }
 *     | { action: 'mark_all_read', ids }   (admin only, as on the page)
 *     | { action: 'dismiss', id }          (admin only, as on the page)
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminPreflight, adminRequestIp, adminResponder, readJsonObject, UUID_RE } from '@/lib/admin-route';

const MAX_IDS = 500;

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request);
}

export async function POST(request: NextRequest) {
  const reply = adminResponder(request);
  // Same roles that can open the Alerts page (admin/src/lib/permissions.ts).
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'support', 'operations'] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);

  const body = await readJsonObject(request);
  const action = body?.action;
  const service = createServiceClient();
  const audit = (name: string, entityId: string | null, details: Record<string, unknown>) => logAdminAudit({
    actorId: admin.userId, action: name, entityType: 'alert', entityId, details, ipAddress: adminRequestIp(request),
  });

  if (action === 'mark_read' || action === 'mark_unread') {
    const id = body?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return reply({ error: 'Invalid alert ID' }, 400);
    const isRead = action === 'mark_read';
    const { data, error } = await service.from('alerts').update({ is_read: isRead }).eq('id', id).select('id, is_read').maybeSingle();
    if (error) return reply({ error: 'Failed to update alert' }, 500);
    if (!data) return reply({ error: 'Alert not found' }, 404);
    const logged = await audit(isRead ? 'mark_alert_read' : 'mark_alert_unread', id, {});
    return reply({ updated: 1, alert: data, auditRecorded: !logged.error });
  }

  if (admin.role !== 'admin') return reply({ error: 'Unauthorized' }, 403);

  if (action === 'mark_all_read') {
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS
        || ids.some(id => typeof id !== 'string' || !UUID_RE.test(id))) {
      return reply({ error: 'Invalid alert IDs' }, 400);
    }
    const { data, error } = await service.from('alerts').update({ is_read: true }).in('id', ids).select('id');
    if (error) return reply({ error: 'Failed to update alerts' }, 500);
    const updatedIds = ((data || []) as Array<{ id: string }>).map(r => r.id);
    if (updatedIds.length === 0) return reply({ error: 'No alerts were updated. Refresh and try again.' }, 409);
    const logged = await audit('mark_all_alerts_read', null, { requested: ids.length, updated: updatedIds.length });
    return reply({ updated: updatedIds.length, ids: updatedIds, auditRecorded: !logged.error });
  }

  if (action === 'dismiss') {
    const id = body?.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return reply({ error: 'Invalid alert ID' }, 400);
    const { data, error } = await service.from('alerts').delete().eq('id', id).select('id, business_id, type, title').maybeSingle();
    if (error) return reply({ error: 'Failed to dismiss alert' }, 500);
    if (!data) return reply({ error: 'Alert not found' }, 404);
    const logged = await audit('dismiss_alert', id, { business_id: data.business_id, type: data.type, title: data.title });
    return reply({ dismissed: 1, auditRecorded: !logged.error });
  }

  return reply({ error: 'Invalid alert action' }, 400);
}
