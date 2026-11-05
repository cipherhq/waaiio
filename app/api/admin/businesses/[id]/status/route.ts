import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { consumeStepUp } from '@/lib/admin-step-up';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['active', 'pending', 'suspended']);
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin')) });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const headers = { ...adminCorsHeaders(request.headers.get('origin')), 'Cache-Control': 'private, no-store' };
  const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
  try {
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) return reply({ error: 'Unauthorized' }, 403);
    const { id } = await params;
    if (!UUID.test(id)) return reply({ error: 'Invalid business ID' }, 400);
    let body;
    try { body = await request.json(); } catch { return reply({ error: 'Invalid request body' }, 400); }
    if (!body || Array.isArray(body) || typeof body !== 'object' ||
        Object.keys(body).some(key => !['status', 'previous_status', 'stepUpId'].includes(key)) ||
        !STATUSES.has(body.status) || !STATUSES.has(body.previous_status)) {
      return reply({ error: 'Invalid status update' }, 400);
    }
    if (typeof body.stepUpId !== 'string' || !UUID.test(body.stepUpId)) {
      return reply({ error: 'Step-up authorization required', code: 'step_up_required' }, 403);
    }
    const service = createServiceClient();
    const { data: before, error: readError } = await service.from('businesses')
      .select('id, name, status').eq('id', id).maybeSingle();
    if (readError) return reply({ error: 'Could not read business' }, 500);
    if (!before) return reply({ error: 'Business not found' }, 404);
    if (before.status !== body.previous_status) return reply({ error: 'Status changed. Refresh and authorize again.' }, 409);
    try {
      await consumeStepUp(admin, body.stepUpId, 'business_status', id, {
        business_id: id, previous_status: body.previous_status, status: body.status,
      });
    } catch {
      return reply({ error: 'Step-up authorization required', code: 'step_up_required' }, 403);
    }
    const { data: saved, error } = await service.from('businesses').update({ status: body.status })
      .eq('id', id).eq('status', body.previous_status).select('id, name, status').maybeSingle();
    if (error) return reply({ error: 'Failed to update status. Refresh before authorizing again.' }, 500);
    if (!saved || saved.id !== id) return reply({ error: 'Status changed. Refresh and authorize again.' }, 409);
    const audit = await logAdminAudit({
      actorId: admin.userId, action: 'change_business_status', entityType: 'business', entityId: id,
      details: { previous_status: before.status, new_status: saved.status, business_name: saved.name },
      ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    });
    return reply({ business: { id: saved.id, status: saved.status }, auditRecorded: !audit.error });
  } catch {
    return reply({ error: 'Unable to confirm update. Refresh before retrying.' }, 500);
  }
}
