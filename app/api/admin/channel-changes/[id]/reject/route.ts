import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';
import { channelChangeFailure, channelChangeOptions, channelChangeResponse } from '@/lib/admin-channel-change';

export const OPTIONS = channelChangeOptions;
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return channelChangeResponse(request, { error: 'Forbidden' }, 403);
  try {
    const { id } = await params;
    const body = await request.json();
    if (!['cancel', 'reject'].includes(body.action)) return channelChangeResponse(request, { error: 'Invalid action' }, 400);
    const action = body.action === 'cancel' ? 'cancelled' : 'rejected';
    let query = createServiceClient().from('channel_change_approvals').update({ status: action })
      .eq('id', id).in('status', ['pending', 'approved']);
    if (action === 'cancelled') query = query.eq('requester_admin_id', admin.userId);
    const { data: updated, error } = await query.select('id, request_type, business_id').maybeSingle();
    if (error || !updated) return channelChangeResponse(request, { error: 'Request unavailable or already terminal' }, 409);
    await logAdminAudit({ actorId: admin.userId, action: `channel_change_${action}`, entityType: 'channel_change_approval', entityId: id,
      details: { request_type: updated.request_type, business_id: updated.business_id } });
    return channelChangeResponse(request, { success: true });
  } catch (error) { return channelChangeFailure(request, error); }
}
