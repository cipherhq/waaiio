/**
 * GET /api/admin/recurring — recurring customer payments for the admin
 * Recurring Payments page (#1108 X3).
 *
 * customer_subscriptions has no admin read policy, so the browser read showed
 * an empty list. Card authorization and gateway customer/plan codes are never
 * returned.
 *
 * POST /api/admin/recurring — { subscriptionId, businessId, action, reason,
 * stepUpId } with action pause | resume | cancel | retry (Owner decisions
 * 2026-11-18). Full admin with a single-use step-up bound to every field.
 * Pause/resume/cancel reach the gateway first, as the merchant dashboard does;
 * no refund and no customer message. Retry only resets the failure count so
 * the daily retry cron charges the saved card.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { logAdminAudit } from '@/lib/admin-audit';
import { createServiceClient } from '@/lib/supabase/service';
import { adminPreflight, adminRequestIp, adminResponder, businessNames, readJsonObject, UUID_RE } from '@/lib/admin-route';
import { RECURRING_ACTIONS, recurringAdminAction, type RecurringAction } from '@/lib/admin-subscription-actions';
import { recurringStepUp, SUBSCRIPTION_STEP_UP_ACTION } from '@/lib/admin-subscription-step-up';

export const dynamic = 'force-dynamic';
const METHODS = 'GET, POST, OPTIONS';
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

export async function POST(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  try {
    // Same rule as the page's buttons (isFullAdmin).
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) return reply({ error: 'Unauthorized' }, 403);

    const body = await readJsonObject(request);
    if (!body) return reply({ error: 'Invalid request body' }, 400);
    const { subscriptionId, businessId, action, reason, stepUpId } = body;
    if (typeof subscriptionId !== 'string' || !UUID_RE.test(subscriptionId)) return reply({ error: 'A valid subscriptionId is required' }, 400);
    if (typeof businessId !== 'string' || !UUID_RE.test(businessId)) return reply({ error: 'A valid businessId is required' }, 400);
    if (typeof action !== 'string' || !(RECURRING_ACTIONS as readonly string[]).includes(action)) {
      return reply({ error: 'action must be pause, resume, cancel or retry' }, 400);
    }
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
      return reply({ error: 'A reason (3 to 500 characters) is required' }, 400);
    }

    try {
      const binding = recurringStepUp(subscriptionId, businessId, action as RecurringAction, reason);
      await consumeStepUp(admin, typeof stepUpId === 'string' ? stepUpId : '', SUBSCRIPTION_STEP_UP_ACTION, binding.targetId, binding.params);
    } catch (err) {
      return reply({ error: err instanceof StepUpError ? err.message : 'Step-up authorization required', code: 'step_up_required' }, 403);
    }

    const result = await recurringAdminAction(createServiceClient(), {
      subscriptionId, businessId, action: action as RecurringAction, reason: reason.trim(),
    });
    let auditRecorded: boolean | undefined;
    if (result.audit) {
      const { error } = await logAdminAudit({ actorId: admin.userId, ...result.audit, ipAddress: adminRequestIp(request) });
      auditRecorded = !error;
    }
    return reply(auditRecorded === undefined ? result.body : { ...result.body, auditRecorded }, result.status);
  } catch {
    return reply({ error: 'Internal server error' }, 500);
  }
}
