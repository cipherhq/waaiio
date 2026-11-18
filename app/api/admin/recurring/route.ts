/**
 * GET /api/admin/recurring — recurring customer payments for the admin
 * Recurring Payments page (#1108 X3). Read only.
 *
 * customer_subscriptions has no admin read policy, so the browser read showed
 * an empty list. Card authorization and gateway customer/plan codes are never
 * returned. Pause/resume/cancel/retry stay off: they need gateway calls.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminPreflight, adminResponder, businessNames } from '@/lib/admin-route';

const METHODS = 'GET, OPTIONS';
// Display columns from M017; no authorization_code, gateway_customer_code or gateway_plan_code.
const COLUMNS = 'id, business_id, user_id, service_id, amount, currency, frequency, status, gateway, gateway_subscription_code, card_last_four, card_brand, next_charge_at, last_charged_at, charge_count, total_charged, failure_count, customer_name, customer_phone, customer_email, setup_channel, cancelled_at, paused_at, created_at';

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request, METHODS);
}

export async function GET(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  // Same roles that can open the Recurring Payments page (admin/src/lib/permissions.ts).
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'finance'] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const service = createServiceClient();
  const { data, error } = await service.from('customer_subscriptions').select(COLUMNS)
    .order('created_at', { ascending: false }).limit(1000);
  if (error) return reply({ error: 'Could not load recurring payments' }, 500);
  const rows = (data || []) as unknown as Array<{ business_id: string; service_id: string | null }>;

  const names = await businessNames(service, rows.map(r => r.business_id));
  const serviceIds = [...new Set(rows.map(r => r.service_id).filter((id): id is string => !!id))];
  const services = new Map<string, { name: string; billing_type: string | null }>();
  if (serviceIds.length > 0) {
    const { data: svc } = await service.from('services').select('id, name, billing_type').in('id', serviceIds);
    for (const s of (svc || []) as Array<{ id: string; name: string; billing_type: string | null }>) services.set(s.id, s);
  }
  return reply({
    records: rows.map(r => {
      const svc = r.service_id ? services.get(r.service_id) : undefined;
      return {
        ...r,
        business_name: names.get(r.business_id) || 'Unknown',
        service_name: svc?.name || 'Payment',
        service_billing_type: svc?.billing_type || 'one_time',
      };
    }),
  });
}
