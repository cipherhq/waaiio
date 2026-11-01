import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { channelChangeFailure, channelChangeOptions, channelChangeResponse, mutateChannelChange, safeChannelOperation } from '@/lib/admin-channel-change';

export const OPTIONS = channelChangeOptions;
export async function GET(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return channelChangeResponse(request, { error: 'Forbidden' }, 403);
  try {
    const status = request.nextUrl.searchParams.get('status');
    let query = createServiceClient().from('channel_change_approvals')
      .select('id,request_type,business_id,owner_user_id,status,reason,target_action,target_channel_id,target_candidate_id,requester_admin_id,approver_admin_id,request_version,created_at,executed_at,snapshot_wa_method,verification_record,requester_step_up_verified_at,approver_step_up_verified_at')
      .order('created_at', { ascending: false }).limit(100);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    const requests = (data || []).map(row => ({ ...row, verification_record: safeChannelOperation(row).verification_record }));
    return channelChangeResponse(request, { requests });
  } catch (error) { return channelChangeFailure(request, error); }
}
export async function POST(request: NextRequest) { return mutateChannelChange(request, 'create'); }
