import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { canonicalCustomerPhone } from '@/lib/customer-suspension';

/**
 * Platform-wide customer suspension (#1103).
 *
 * GET  — suspended numbers (admin, support).
 * POST — suspend or unsuspend one canonical number (admin, with step-up). The
 *        change and its audit row are written together by
 *        svc_set_customer_suspension (M547).
 */

export const dynamic = 'force-dynamic';

const METHODS = 'GET, POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), METHODS) });
}

export async function GET(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'), METHODS);
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'support'] });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const { data, error } = await createServiceClient()
    .from('customer_suspensions')
    .select('phone, reason, suspended_at')
    .order('suspended_at', { ascending: false });
  if (error) return NextResponse.json({ error: 'Unable to load suspended customers' }, { status: 500, headers: cors });
  return NextResponse.json({ suspensions: data ?? [] }, { headers: cors });
}

export async function POST(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'), METHODS);
  try {
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

    const body = await request.json().catch(() => null);
    const { phone, suspended, reason, stepUpId } = (body ?? {}) as Record<string, unknown>;

    if (typeof phone !== 'string' || canonicalCustomerPhone(phone) !== phone) {
      return NextResponse.json({ error: 'phone must be the canonical number (country code and digits only)' }, { status: 400, headers: cors });
    }
    if (typeof suspended !== 'boolean') {
      return NextResponse.json({ error: 'suspended (boolean) is required' }, { status: 400, headers: cors });
    }
    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
      return NextResponse.json({ error: 'reason must be text' }, { status: 400, headers: cors });
    }
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (trimmed.length > 500 || (suspended && trimmed.length < 3)) {
      return NextResponse.json({ error: suspended ? 'A reason (3 to 500 characters) is required' : 'reason is too long' }, { status: 400, headers: cors });
    }

    // The step-up is bound to exactly what the admin confirmed.
    try {
      await consumeStepUp(admin, typeof stepUpId === 'string' ? stepUpId : '', 'customer_suspension', phone, {
        phone, suspended, reason: (reason as string | null | undefined) ?? null,
      });
    } catch (err) {
      const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
      return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403, headers: cors });
    }

    const { data, error } = await createServiceClient().rpc('svc_set_customer_suspension', {
      p_actor_id: admin.userId,
      p_phone: phone,
      p_suspend: suspended,
      p_reason: trimmed || null,
      p_ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    });
    if (error || !data) {
      return NextResponse.json({ error: 'Unable to save the suspension' }, { status: 500, headers: cors });
    }
    if (data.changed !== true) {
      return NextResponse.json({
        error: suspended ? 'This number is already suspended' : 'This number is not suspended',
        suspended: data.suspended === true,
      }, { status: 409, headers: cors });
    }
    return NextResponse.json({ suspended, phone }, { headers: cors });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
  }
}
