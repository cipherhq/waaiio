import { NextResponse, type NextRequest } from 'next/server';
import { requirePlatformAdmin, type PlatformAdmin } from '@/lib/admin-auth';
import { hashOperationParams, stableStringify } from '@/lib/admin-step-up';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';

export type ChannelChangeAction = 'create' | 'approve' | 'refresh' | 'execute';
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const pick = (value: unknown, keys: string[]): JsonObject => {
  const input = object(value);
  return Object.fromEntries(keys.filter(key => key in input).map(key => [key, input[key]]));
};

// Explicit projections also protect responses from old or unexpectedly populated rows.
export function safeChannelOperation(value: unknown): JsonObject {
  const op = object(value);
  const safe = pick(op, ['business_id', 'owner_user_id', 'country_code', 'snapshot_assigned_channel_id', 'snapshot_whatsapp_channel_id', 'snapshot_wa_method', 'request_type', 'target_action', 'reason', 'request_version', 'requester_admin_id', 'target_channel_id', 'target_candidate_id']);
  safe.target_snapshot = pick(op.target_snapshot, ['id', 'country_code', 'phone_number_id', 'phone_number', 'phone_number_normalized', 'connection_method', 'connection_source', 'provider', 'status', 'updated_at']);
  const verification = object(op.verification_record);
  safe.verification_record = {
    ...pick(verification, ['owner_reverified', 'verification_method', 'verified_by_admin_id', 'verified_at']),
    evidence_refs: Array.isArray(verification.evidence_refs) ? verification.evidence_refs.map(ref => ({
      ...pick(ref, ['type', 'document_id', 'request_id']),
      snapshot: pick(object(ref).snapshot, ['id', 'type', 'status', 'reviewed_at', 'reviewed_by', 'uploaded_at', 'completed_at', 'created_at']),
    })) : [],
  };
  return safe;
}

export class ChannelChangeError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export function channelChangeResponse(request: NextRequest, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { ...adminCorsHeaders(request.headers.get('origin'), 'GET, POST, OPTIONS'), 'Cache-Control': 'no-store' } });
}
export function channelChangeOptions(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), 'GET, POST, OPTIONS') });
}
export function channelChangeFailure(request: NextRequest, error: unknown) {
  if (error instanceof ChannelChangeError) return channelChangeResponse(request, { error: error.message, code: 'CHANNEL_CHANGE_RELOAD_REQUIRED' }, error.status);
  if (error instanceof SyntaxError) return channelChangeResponse(request, { error: 'Invalid JSON request' }, 400);
  return channelChangeResponse(request, { error: 'Unable to process channel change' }, 500);
}

export async function channelChangeDescriptor(admin: PlatformAdmin, value: unknown) {
  const input = object(value);
  const action = input.action as ChannelChangeAction;
  if (!['create', 'approve', 'refresh', 'execute'].includes(action)) throw new ChannelChangeError('Invalid action', 400);
  if (!admin.sessionId) throw new ChannelChangeError('Verified admin session required', 403);
  const details = object(input.details);
  const args = {
    p_action: action,
    p_actor_id: admin.userId,
    p_session_id: admin.sessionId,
    p_business_id: typeof input.business_id === 'string' ? input.business_id : null,
    p_approval_id: typeof input.approval_id === 'string' ? input.approval_id : null,
    p_details: action === 'create' ? details : action === 'approve' ? { review_confirmed: details.review_confirmed === true } : {},
  };
  const { data, error } = await createServiceClient().rpc('channel_change_action_descriptor', args);
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ChannelChangeError('Request, destination or evidence is no longer eligible. Reload and review it again.');
  }
  const descriptor = data as JsonObject;
  const operation = object(descriptor.operation);
  const hash = hashOperationParams(descriptor);
  return {
    args, descriptor, hash, authorizedText: stableStringify(descriptor),
    actionType: action === 'execute' ? 'channel_change_execute' as const : 'messaging_config' as const,
    targetId: String(action === 'approve' || action === 'execute' ? args.p_approval_id : operation.business_id),
  };
}

export async function mutateChannelChange(request: NextRequest, action: ChannelChangeAction, approvalId?: string) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return channelChangeResponse(request, { error: 'Forbidden' }, 403);
  try {
    const body = object(await request.json());
    if (typeof body.stepUpId !== 'string' || !body.stepUpId) throw new ChannelChangeError('Step-up MFA required', 403);
    if (typeof body.previewHash !== 'string') throw new ChannelChangeError('Review a fresh preview first', 400);
    const bound = await channelChangeDescriptor(admin, {
      action, business_id: action === 'create' ? body.business_id : undefined,
      approval_id: approvalId, details: action === 'create' ? body : { review_confirmed: body.review_confirmed },
    });
    if (bound.hash !== body.previewHash) throw new ChannelChangeError('Preview changed. Reload and review it again.');
    const service = createServiceClient();
    const { data, error } = action === 'execute'
      ? await service.rpc('execute_channel_change_approval', {
          p_approval_id: approvalId, p_executor_admin_id: admin.userId,
          p_executor_step_up_id: body.stepUpId, p_executor_session_id: admin.sessionId,
          p_executor_authorized_text: bound.authorizedText,
        })
      : await service.rpc('mutate_channel_change_approval', {
          ...bound.args, p_step_up_id: body.stepUpId, p_authorized_text: bound.authorizedText,
        });
    if (error) throw new ChannelChangeError('Authorization expired or request changed. Reload and obtain fresh approvals.');
    if (!data?.ok) throw new Error('Atomic operation did not succeed');
    return channelChangeResponse(request, { success: true, ...pick(data, ['id', 'request_version', 'status', 'new_channel_id']) });
  } catch (error) { return channelChangeFailure(request, error); }
}
