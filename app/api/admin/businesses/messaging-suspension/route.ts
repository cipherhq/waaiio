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
    const { businessId, suspended, reason, stepUpId } = body;

    if (!businessId || typeof suspended !== 'boolean') {
      return NextResponse.json({ error: 'businessId and suspended (boolean) are required' }, { status: 400, headers: cors });
    }

    // SEC-005 Layer 4: Consume operation-bound step-up authorization
    try {
      await consumeStepUp(admin, stepUpId, 'messaging_suspension', businessId, {
        business_id: businessId, suspended, reason: reason ?? null,
      });
    } catch (err) {
      const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
      return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403, headers: cors });
    }

    // Call the svc_ wrapper via service client (service_role has EXECUTE)
    const service = createServiceClient();
    const { data, error } = await service.rpc('svc_toggle_messaging_suspension', {
      p_actor_user_id: admin.userId,
      p_business_id: businessId,
      p_suspended: suspended,
      p_reason: reason ?? null,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500, headers: cors });
    }

    return NextResponse.json(data, { headers: cors });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
  }
}
