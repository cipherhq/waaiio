import { NextResponse, type NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';

/**
 * POST /api/admin/channel-changes/[id]/reject
 * Reject or cancel a channel change request. Terminal status.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const body = await request.json();
  const action = body.action === 'cancel' ? 'cancelled' : 'rejected';

  const service = createServiceClient();

  const { data: updated, error } = await service
    .from('channel_change_approvals')
    .update({ status: action })
    .eq('id', id)
    .in('status', ['pending', 'approved'])
    .select('id, request_type, business_id')
    .maybeSingle();

  if (error || !updated) {
    return NextResponse.json({ error: 'Request not found or already terminal' }, { status: 409 });
  }

  await logAdminAudit({
    actorId: admin.userId,
    action: `channel_change_${action}`,
    entityType: 'channel_change_approval',
    entityId: id,
    details: { request_type: updated.request_type, business_id: updated.business_id },
  });

  return NextResponse.json({ success: true });
}
