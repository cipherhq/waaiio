import { adminApiFetch } from './adminApi';

export interface AuditEntry {
  action: string;
  entity_type?: string;
  entity?: string;
  entity_id: string;
  details?: Record<string, unknown>;
}

export interface AuditResult {
  ok: boolean;
  error?: string;
}

/** Window event fired when an audit entry could not be recorded (shown by AuditFailureNotice). */
export const AUDIT_FAILED_EVENT = 'waaiio:audit-failed';

/**
 * Record an admin action through POST /api/admin/audit (#1108 X1).
 *
 * The browser client cannot write admin_audit_logs (M439 revoked it), so the
 * old direct insert was dropped without a trace. Failures are never thrown,
 * because the action itself already happened, but they are returned, logged
 * and announced so the admin knows the audit trail has a gap.
 */
export async function logAudit(entry: AuditEntry): Promise<AuditResult> {
  let result: AuditResult;
  try {
    const res = await adminApiFetch('/api/admin/audit', {
      action: entry.action,
      entity_type: entry.entity_type || entry.entity || null,
      entity_id: entry.entity_id,
      details: entry.details || {},
    });
    const body = await res.json().catch(() => null) as { recorded?: boolean; error?: string } | null;
    result = res.ok && body?.recorded === true
      ? { ok: true }
      : { ok: false, error: body?.error || `Audit request failed (${res.status})` };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : 'Audit request failed' };
  }
  if (!result.ok) {
    console.error(`[audit] ${entry.action} was not recorded: ${result.error}`);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(AUDIT_FAILED_EVENT, { detail: { action: entry.action, error: result.error } }));
    }
  }
  return result;
}
