import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { isValidStatusTransition, type PromoCampaignStatus } from '@/lib/promotions/types';

type GovernanceAction = 'pause' | 'resume' | 'end';

/** Maps governance action to the resulting campaign status. */
const ACTION_STATUS_MAP: Record<GovernanceAction, PromoCampaignStatus> = {
  pause: 'paused',
  resume: 'active',
  end: 'ended',
};

const VALID_ACTIONS: GovernanceAction[] = ['pause', 'resume', 'end'];

function corsHeaders(origin?: string | null) {
  const allowedOrigins = [
    process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
    'http://localhost:8083',
  ];
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('Origin');
  return NextResponse.json({}, { headers: corsHeaders(origin) });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('Origin');

  // Admin-only: governance mutations require the 'admin' role exclusively.
  // 'operations' role is not permitted to execute irreversible campaign state changes.
  const admin = await requirePlatformAdmin(request, {
    requiredRole: ['admin'],
  });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: corsHeaders(origin) });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders(origin) });
  }

  const { campaignId, action, reason } = body as {
    campaignId?: string;
    action?: string;
    reason?: string;
  };

  if (!campaignId || typeof campaignId !== 'string') {
    return NextResponse.json({ error: 'campaignId is required' }, { status: 400, headers: corsHeaders(origin) });
  }
  if (!action || !VALID_ACTIONS.includes(action as GovernanceAction)) {
    return NextResponse.json(
      { error: `action must be one of: ${VALID_ACTIONS.join(', ')}` },
      { status: 400, headers: corsHeaders(origin) },
    );
  }

  const service = createServiceClient();

  // Fetch campaign
  const { data: campaign, error: fetchError } = await service
    .from('promo_campaigns')
    .select('id, business_id, name, status')
    .eq('id', campaignId)
    .maybeSingle();

  if (fetchError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404, headers: corsHeaders(origin) });
  }

  const currentStatus = campaign.status as PromoCampaignStatus;
  const targetStatus = ACTION_STATUS_MAP[action as GovernanceAction];

  // Validate the status transition is permitted
  if (!isValidStatusTransition(currentStatus, targetStatus)) {
    return NextResponse.json(
      {
        error: `Cannot '${action}' a campaign with status '${currentStatus}'. Invalid transition to '${targetStatus}'.`,
      },
      { status: 422, headers: corsHeaders(origin) },
    );
  }

  // For resume (→ active), use atomic activation with validation
  // For pause/end, use atomic governance RPC
  let result: Record<string, unknown> | null = null;
  let rpcError: { message: string } | null = null;

  if (targetStatus === 'active') {
    const { data, error } = await service.rpc('activate_promo_campaign', {
      p_campaign_id: campaignId,
      p_actor_id: admin.userId,
      p_actor_role: 'admin',
    });
    result = data;
    rpcError = error;
  } else {
    const { data, error } = await service.rpc('admin_promo_governance', {
      p_campaign_id: campaignId,
      p_target_status: targetStatus,
      p_actor_id: admin.userId,
      p_actor_role: admin.role,
      p_reason: reason?.trim() || null,
    });
    result = data;
    rpcError = error;
  }

  if (rpcError || !result || (result as Record<string, unknown>).success !== true) {
    logger.error('[ADMIN PROMOTIONS] governance RPC error or non-success result:', rpcError, result);
    return NextResponse.json(
      {
        error: (result as Record<string, unknown> | null)?.error || rpcError?.message || 'Governance action failed',
        validation_errors: (result as Record<string, unknown> | null)?.validation_errors || [],
      },
      { status: 422, headers: corsHeaders(origin) },
    );
  }

  return NextResponse.json(
    {
      success: true,
      campaign: result,
      action,
      from_status: currentStatus,
      to_status: targetStatus,
    },
    { headers: corsHeaders(origin) },
  );
}
