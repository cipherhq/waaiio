import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { isCountryAmountKey, validateCountryAmounts } from '@/shared/country-amounts';
import { isTopupPackagesKey, validateTopupPackages } from '@/shared/topup-packages';

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
    const { key, value, description, expectedVersionId, stepUpId } = body;

    if (!key || value === undefined) {
      return NextResponse.json({ error: 'key and value are required' }, { status: 400, headers: cors });
    }

    // Validate country-amount keys (minimum_bank_transfer, minimum_payout)
    if (isCountryAmountKey(key)) {
      const errors = validateCountryAmounts(key, value);
      if (errors) {
        return NextResponse.json(
          { error: errors.map(e => e.message).join('; '), code: 'validation_error', details: errors },
          { status: 400, headers: cors },
        );
      }
    }

    // Validate messaging_topup_packages shape
    if (isTopupPackagesKey(key)) {
      const errors = validateTopupPackages(value);
      if (errors) {
        return NextResponse.json(
          { error: errors.map(e => e.message).join('; '), code: 'validation_error', details: errors },
          { status: 400, headers: cors },
        );
      }
    }

    // SEC-005 Layer 4: Consume operation-bound step-up authorization
    try {
      await consumeStepUp(admin, stepUpId, 'commercial_config', key, {
        key, value, description: description ?? null,
        expected_version_id: expectedVersionId ?? null,
      });
    } catch (err) {
      const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
      return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403, headers: cors });
    }

    // Call svc_ wrapper via service client
    const service = createServiceClient();
    const { data, error } = await service.rpc('svc_save_commercial_config', {
      p_actor_user_id: admin.userId,
      p_key: key,
      p_value: value,
      p_description: description ?? null,
      p_expected_version_id: expectedVersionId ?? null,
    });

    if (error) {
      if (error.message.includes('version conflict')) {
        return NextResponse.json({ error: error.message, code: 'version_conflict' }, { status: 409, headers: cors });
      }
      return NextResponse.json({ error: error.message }, { status: 500, headers: cors });
    }

    return NextResponse.json({ versionId: data }, { headers: cors });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
  }
}
