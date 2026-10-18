/**
 * Shared admin audit-log writer.
 *
 * SEC-005: All admin_audit_logs writes go through the service client.
 * Authenticated INSERT is revoked — direct PostgREST writes are blocked.
 *
 * Usage:
 *   import { logAdminAudit } from '@/lib/admin-audit';
 *   await logAdminAudit({
 *     actorId: admin.userId,
 *     action: 'grant_platform_role',
 *     entityType: 'platform_team',
 *     entityId: targetUser.id,
 *     details: { role },
 *     ipAddress: request.headers.get('x-forwarded-for'),
 *   });
 */

interface AuditEntry {
  actorId: string | null;
  action: string;
  entityType?: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}

/**
 * Insert an admin audit log entry via the service client.
 * Never throws — audit failures must not block the calling operation.
 */
export async function logAdminAudit(entry: AuditEntry): Promise<{ error?: string }> {
  try {
    const { createServiceClient } = await import('@/lib/supabase/service');
    const supabase = createServiceClient();
    const { error } = await supabase.from('admin_audit_logs').insert({
      actor_id: entry.actorId,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      details: entry.details ?? null,
      ip_address: entry.ipAddress ?? null,
    });
    if (error) return { error: error.message };
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'unknown' };
  }
}
