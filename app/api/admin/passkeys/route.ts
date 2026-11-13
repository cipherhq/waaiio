import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { verifiedPasskeyFactorIds } from '@/lib/admin-passkey';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * The signed-in admin's own passkeys (Owner decision 2026-11-12).
 *
 * GET  — list passkeys and whether each is approved.
 * POST — { action: 'approve' | 'remove', factorId, stepUpId }. Both consume an
 *        authenticator-code step-up bound to this factor. A passkey only
 *        earns passkey privileges once approved (lib/admin-passkey.ts).
 */

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin')) });
}

export async function GET(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'));
  const admin = await requirePlatformAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const passkeys = (admin.factors ?? []).filter(f => f.factor_type === 'webauthn');
  const { data, error } = await createServiceClient()
    .from('admin_passkey_approvals')
    .select('factor_id, approved_at')
    .eq('admin_user_id', admin.userId);
  if (error) return NextResponse.json({ error: 'Could not load passkeys' }, { status: 500, headers: cors });

  const approved = new Map((data ?? []).map((r: { factor_id: string; approved_at: string }) => [r.factor_id, r.approved_at]));
  return NextResponse.json({
    passkeys: passkeys.map(f => ({ id: f.id, status: f.status, approvedAt: approved.get(f.id) ?? null })),
  }, { headers: { ...cors, 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'));
  const admin = await requirePlatformAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const body = await request.json().catch(() => null);
  const { action, factorId, stepUpId } = (body ?? {}) as Record<string, unknown>;
  if ((action !== 'approve' && action !== 'remove') || typeof factorId !== 'string' || !factorId) {
    return NextResponse.json({ error: 'action and factorId required' }, { status: 400, headers: cors });
  }
  if (typeof stepUpId !== 'string' || !stepUpId) {
    return NextResponse.json({ error: 'Step-up authorization required', code: 'step_up_required' }, { status: 403, headers: cors });
  }

  const ownPasskey = (admin.factors ?? []).some(f => f.id === factorId && f.factor_type === 'webauthn');
  if (!ownPasskey) return NextResponse.json({ error: 'Passkey not found' }, { status: 404, headers: cors });
  if (action === 'approve' && !verifiedPasskeyFactorIds(admin).includes(factorId)) {
    return NextResponse.json({ error: 'Finish setting up this passkey first' }, { status: 409, headers: cors });
  }

  const stepUpAction = action === 'approve' ? 'passkey_approve' : 'passkey_remove';
  try {
    await consumeStepUp(admin, stepUpId, stepUpAction, factorId, { factor_id: factorId });
  } catch (err) {
    const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
    return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403, headers: cors });
  }

  const service = createServiceClient();
  if (action === 'approve') {
    const { error } = await service
      .from('admin_passkey_approvals')
      .insert({ factor_id: factorId, admin_user_id: admin.userId, step_up_id: stepUpId });
    if (error && error.code !== '23505') {
      return NextResponse.json({ error: 'Could not approve passkey' }, { status: 500, headers: cors });
    }
  } else {
    // Drop the approval first: if deleting the factor then fails, the passkey
    // is untrusted (fail safe) rather than trusted and undeletable.
    const { error: approvalError } = await service
      .from('admin_passkey_approvals')
      .delete()
      .eq('factor_id', factorId)
      .eq('admin_user_id', admin.userId);
    if (approvalError) return NextResponse.json({ error: 'Could not remove passkey' }, { status: 500, headers: cors });
    const { error: factorError } = await service.auth.admin.mfa.deleteFactor({ id: factorId, userId: admin.userId });
    if (factorError) return NextResponse.json({ error: 'Could not remove passkey' }, { status: 502, headers: cors });
  }

  logAdminAudit({
    actorId: admin.userId,
    action: action === 'approve' ? 'admin_passkey_approved' : 'admin_passkey_removed',
    entityType: 'admin_passkey',
    entityId: factorId,
    details: { step_up_id: stepUpId },
    ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown',
  });

  return NextResponse.json({ success: true }, { headers: cors });
}
