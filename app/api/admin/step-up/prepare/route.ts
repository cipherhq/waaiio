import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { prepareStepUp, StepUpError } from '@/lib/admin-step-up';
import type { StepUpAction } from '@/lib/admin-step-up';
import { channelChangeDescriptor, ChannelChangeError } from '@/lib/admin-channel-change';
import { adminCorsHeaders } from '@/lib/admin-cors';

const VALID_ACTIONS: StepUpAction[] = [
  'payout_approve', 'payout_reject', 'payout_generate', 'payout_confirm_settlement', 'payout_force_settle',
  'provider_config',
  'team_grant', 'team_revoke', 'impersonate', 'refund',
  'reseller_payout_approve', 'reseller_payout_reject', 'reseller_payout_mark_paid',
  'reseller_payout_generate',
  'commercial_config', 'messaging_config', 'messaging_suspension', 'business_status', 'channel_change_execute',
];

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin')) });
}

export async function POST(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'));
  try {
    const admin = await requirePlatformAdmin(request);
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

    const body = await request.json();
    const { actionType, targetId, params } = body;

    if (!actionType || !VALID_ACTIONS.includes(actionType)) {
      return NextResponse.json({ error: 'Invalid action type' }, { status: 400, headers: cors });
    }

    if (!params || typeof params !== 'object') {
      return NextResponse.json({ error: 'Params object required' }, { status: 400, headers: cors });
    }

    if (params.channel_change || actionType === 'channel_change_execute') {
      if (admin.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: cors });
      const bound = await channelChangeDescriptor(admin, params.channel_change);
      if (params.previewHash !== bound.hash || actionType !== bound.actionType || targetId !== bound.targetId) {
        throw new ChannelChangeError('Preview changed. Reload and review it again.');
      }
      const result = await prepareStepUp(admin, bound.actionType, bound.targetId, bound.descriptor);
      return NextResponse.json(result, { headers: cors });
    }
    const result = await prepareStepUp(admin, actionType, targetId ?? null, params);
    return NextResponse.json(result, { headers: cors });
  } catch (err) {
    if (err instanceof ChannelChangeError) {
      return NextResponse.json({ error: err.message, code: 'CHANNEL_CHANGE_RELOAD_REQUIRED' }, { status: err.status, headers: cors });
    }
    if (err instanceof StepUpError) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: cors });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers: cors });
  }
}
