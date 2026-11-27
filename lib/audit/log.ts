import type { SupabaseClient } from '@supabase/supabase-js';

export type AuditAction =
  | 'create' | 'update' | 'delete'
  | 'enable' | 'disable'
  | 'login' | 'logout'
  | 'export' | 'import'
  | 'payout_request' | 'payout_approve' | 'payout_reject'
  | 'payout_account_lookup';

export type AuditEntityType =
  | 'booking' | 'order' | 'service' | 'product'
  | 'staff' | 'location' | 'promo_code' | 'webhook'
  | 'faq' | 'capability' | 'settings' | 'payout'
  | 'customer' | 'business';

export async function logAudit(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    userId?: string;
    action: AuditAction;
    entityType: AuditEntityType;
    entityId?: string;
    changes?: Record<string, unknown>;
    ipAddress?: string;
  },
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase.from('audit_log').insert({
    business_id: params.businessId,
    user_id: params.userId || null,
    action: params.action,
    entity_type: params.entityType,
    entity_id: params.entityId || null,
    changes: params.changes || null,
    ip_address: params.ipAddress || null,
  });
  return { error: error ?? null };
}
