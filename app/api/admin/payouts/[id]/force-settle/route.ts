import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';

/**
 * POST /api/admin/payouts/[id]/force-settle
 *
 * Records settlement for a manual bank transfer that was already executed
 * but whose normal confirmation failed due to a concurrent refund reducing
 * the available balance.
 *
 * This is a recovery operation, not a normal workflow. It:
 * 1. Requires MFA step-up (payout_force_settle)
 * 2. Verifies the payout is approved + manual_bank
 * 3. Creates a reconciliation adjustment for any refund-caused shortfall
 * 4. Transitions to paid with full audit trail
 * 5. All atomic — any failure rolls back everything
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (process.env.ENABLE_PAYOUTS !== 'true') {
    return NextResponse.json({ error: 'Payouts are currently disabled' }, { status: 503 });
  }

  const { id } = await params;

  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const serviceClient = createServiceClient();
  const body = await request.json();
  const { transfer_reference, reason, attestation, stepUpId } = body;

  if (!transfer_reference || typeof transfer_reference !== 'string' || transfer_reference.trim().length === 0) {
    return NextResponse.json({ error: 'transfer_reference is required' }, { status: 400 });
  }
  if (transfer_reference.trim().length > 100) {
    return NextResponse.json({ error: 'transfer_reference must be 100 characters or fewer' }, { status: 400 });
  }
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    return NextResponse.json({ error: 'reason is required explaining why force-settle is necessary' }, { status: 400 });
  }
  if (attestation !== true) {
    return NextResponse.json({ error: 'attestation: true is required to confirm the bank transfer was already executed' }, { status: 400 });
  }

  // Pre-flight: verify payout exists and is eligible before burning step-up
  const { data: payout } = await serviceClient
    .from('business_payouts')
    .select('id, status, transfer_method')
    .eq('id', id)
    .single();

  if (!payout) {
    return NextResponse.json({ error: 'Payout not found' }, { status: 404 });
  }
  if (payout.status !== 'approved') {
    return NextResponse.json({ error: `Payout status is '${payout.status}' — only approved payouts can be force-settled` }, { status: 400 });
  }
  if (payout.transfer_method !== 'manual_bank') {
    return NextResponse.json({ error: 'Only manual_bank payouts can be force-settled' }, { status: 400 });
  }

  // SEC-005: step-up MFA
  try {
    await consumeStepUp(admin, stepUpId, 'payout_force_settle', id, {
      transfer_reference: transfer_reference.trim(),
      reason: reason.trim(),
      attestation: true,
    });
  } catch (err) {
    const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
    return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403 });
  }

  // Call the atomic RPC
  const { data: rpcResult, error: rpcError } = await serviceClient.rpc(
    'force_settle_executed_transfer',
    {
      p_payout_id: id,
      p_transfer_ref: transfer_reference.trim(),
      p_reason: reason.trim(),
      p_attestation: true,
      p_admin_id: admin.id,
    },
  );

  if (rpcError) {
    const msg: string = rpcError.message || '';
    if (msg.includes('payout_not_found')) return NextResponse.json({ error: 'Payout not found' }, { status: 404 });
    if (msg.includes('ineligible_status') || msg.includes('cas_conflict')) {
      return NextResponse.json({ error: 'Payout status has changed — cannot force-settle' }, { status: 409 });
    }
    if (msg.includes('ineligible_method')) return NextResponse.json({ error: 'Only manual_bank payouts can be force-settled' }, { status: 400 });
    if (msg.includes('attestation_required')) return NextResponse.json({ error: 'Attestation required' }, { status: 400 });
    if (msg.includes('reason_required')) return NextResponse.json({ error: 'Reason required' }, { status: 400 });
    return NextResponse.json({ error: 'Force-settle failed — please retry' }, { status: 500 });
  }

  if (!rpcResult || (Array.isArray(rpcResult) && rpcResult.length === 0)) {
    return NextResponse.json({ error: 'Force-settle returned no result' }, { status: 500 });
  }

  const adjustmentAmount = Array.isArray(rpcResult) ? rpcResult[0]?.adjustment_amount : rpcResult?.adjustment_amount;

  return NextResponse.json({
    success: true,
    status: 'paid',
    reconciliation_adjustment: adjustmentAmount || 0,
  });
}
