import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin')) });
}

export async function POST(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'));
  try {
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

    const body = await request.json();
    const {
      messagingPricing, trialCreditMinorByCurrency,
      subscriptionIncludedMinorByTierCurrency, paystackPlanCodes,
      expectedVersionId, description, stepUpId,
    } = body;

    // SEC-005 Layer 4: Consume operation-bound step-up authorization
    try {
      await consumeStepUp(admin, stepUpId, 'messaging_config', 'messaging_bundle', {
        messaging_pricing: messagingPricing ?? null,
        trial_credit: trialCreditMinorByCurrency ?? null,
        subscription_included: subscriptionIncludedMinorByTierCurrency ?? null,
        paystack_plan_codes: paystackPlanCodes ?? null,
        expected_version_id: expectedVersionId ?? null,
      });
    } catch (err) {
      const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
      return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403, headers: cors });
    }

    // Call svc_ wrapper via service client
    const service = createServiceClient();
    const { data, error } = await service.rpc('svc_save_market_messaging_config', {
      p_actor_user_id: admin.userId,
      p_messaging_pricing: messagingPricing,
      p_trial_credit_minor_by_currency: trialCreditMinorByCurrency,
      p_subscription_included_minor_by_tier_currency: subscriptionIncludedMinorByTierCurrency,
      p_paystack_plan_codes: paystackPlanCodes ?? null,
      p_expected_version_id: expectedVersionId ?? null,
      p_description: description ?? null,
    });

    if (error) {
      if (error.message.includes('version_conflict')) {
        return NextResponse.json({ error: error.message, code: 'version_conflict' }, { status: 409, headers: cors });
      }
      return NextResponse.json({ error: error.message }, { status: 500, headers: cors });
    }

    return NextResponse.json({ versionId: data }, { headers: cors });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
  }
}
