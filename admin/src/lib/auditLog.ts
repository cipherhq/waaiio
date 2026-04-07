import { supabase } from './supabase';

export interface AuditEntry {
  action: string;
  entity_type: string;
  entity_id: string;
  details?: Record<string, unknown>;
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const { data: session } = await supabase.auth.getSession();
    const actorId = session?.session?.user?.id;
    if (!actorId) return;

    await supabase.from('admin_audit_logs').insert({
      actor_id: actorId,
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      details: entry.details || {},
    });
  } catch {
    // Audit logging is best-effort
  }
}
