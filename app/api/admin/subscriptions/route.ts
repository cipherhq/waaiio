/**
 * POST /api/admin/subscriptions — admin money actions on a merchant's Waaiio
 * plan (Owner decisions 2026-11-18). Full admin with step-up only.
 *
 * - { action: 'stop_renewal', subscriptionId, businessId, reason }: stops
 *   renewal at Paystack/Stripe; the plan stays until the paid period ends.
 *   No refund.
 * - { action: 'extend_trial', businessId, days }: adds 1–30 days to the
 *   Pro/Premium feature trial of a Free business that has never paid.
 *
 * The step-up is bound to the action, target and every confirmed field, and
 * is single-use, so a repeated click cannot run the action twice.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { logAdminAudit } from '@/lib/admin-audit';
import { createServiceClient } from '@/lib/supabase/service';
import { adminPreflight, adminRequestIp, adminResponder, readJsonObject, UUID_RE } from '@/lib/admin-route';
import { cancelPlanRenewal, extendFeatureTrial, MAX_TRIAL_EXTENSION_DAYS, type ActionResult } from '@/lib/admin-subscription-actions';

export const dynamic = 'force-dynamic';
const METHODS = 'POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request, METHODS);
}

export async function POST(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  try {
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) return reply({ error: 'Unauthorized' }, 403);

    const body = await readJsonObject(request);
    if (!body) return reply({ error: 'Invalid request body' }, 400);
    const { action, subscriptionId, businessId, reason, days, stepUpId } = body;
    if (typeof businessId !== 'string' || !UUID_RE.test(businessId)) return reply({ error: 'A valid businessId is required' }, 400);

    let targetId: string;
    let params: Record<string, unknown>;
    if (action === 'stop_renewal') {
      if (typeof subscriptionId !== 'string' || !UUID_RE.test(subscriptionId)) return reply({ error: 'A valid subscriptionId is required' }, 400);
      if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
        return reply({ error: 'A reason (3 to 500 characters) is required' }, 400);
      }
      targetId = subscriptionId;
      params = { action, businessId, reason };
    } else if (action === 'extend_trial') {
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_TRIAL_EXTENSION_DAYS) {
        return reply({ error: `days must be a whole number from 1 to ${MAX_TRIAL_EXTENSION_DAYS}` }, 400);
      }
      targetId = businessId;
      params = { action, businessId, days };
    } else {
      return reply({ error: 'action must be stop_renewal or extend_trial' }, 400);
    }

    try {
      await consumeStepUp(admin, typeof stepUpId === 'string' ? stepUpId : '', 'subscription_admin_action', targetId, params);
    } catch (err) {
      return reply({ error: err instanceof StepUpError ? err.message : 'Step-up authorization required', code: 'step_up_required' }, 403);
    }

    const service = createServiceClient();
    const result: ActionResult = action === 'stop_renewal'
      ? await cancelPlanRenewal(service, { subscriptionId: subscriptionId as string, businessId, reason: (reason as string).trim() })
      : await extendFeatureTrial(service, { businessId, days: days as number });

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
