import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { payoutPaidEmail } from '@/lib/email/templates';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { getCountry } from '@/lib/countries';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { logAdminAudit } from '@/lib/admin-audit';

/**
 * POST /api/admin/payouts/[id]/confirm-settlement
 *
 * Confirms that a manual bank transfer has been completed.
 * Transitions payout from 'approved' (with transfer_method='manual_bank')
 * to 'paid', requiring a non-empty transfer_reference as settlement evidence.
 *
 * This is the second step of the manual payout flow:
 *   1. Admin approves via /approve with transfer_method=manual_bank → status=approved
 *   2. Admin confirms settlement here with transfer_reference → status=paid
 *
 * Automated transfers (paystack_transfer, stripe_transfer) do not use this
 * endpoint — their settlement is confirmed by provider webhooks.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const serviceClient = createServiceClient();
  const body = await request.json();
  const { transfer_reference, notes, stepUpId } = body;

  // ── Require non-empty transfer reference ──
  if (!transfer_reference || typeof transfer_reference !== 'string' || transfer_reference.trim().length === 0) {
    return NextResponse.json({
      error: 'transfer_reference is required to confirm settlement',
    }, { status: 400 });
  }

  // ── Fetch and validate payout ──
  const { data: payout } = await serviceClient
    .from('business_payouts')
    .select('id, business_id, net_amount, status, transfer_method, payout_account_id, notes')
    .eq('id', id)
    .single();

  if (!payout) {
    return NextResponse.json({ error: 'Payout not found' }, { status: 404 });
  }

  // Only approved manual_bank payouts can be confirmed
  if (payout.status !== 'approved') {
    return NextResponse.json({
      error: `Payout status is '${payout.status}' — only 'approved' payouts can be confirmed`,
    }, { status: 400 });
  }

  if (payout.transfer_method !== 'manual_bank') {
    return NextResponse.json({
      error: `Payout transfer_method is '${payout.transfer_method}' — only manual_bank payouts use this endpoint. Automated transfers are confirmed by provider webhooks.`,
    }, { status: 400 });
  }

  // ── Business verification (defense in depth) ──
  const { data: bizCheck } = await serviceClient
    .from('businesses')
    .select('id, verification_level')
    .eq('id', payout.business_id)
    .single();

  if (!bizCheck) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  if (bizCheck.verification_level === 'unverified') {
    return NextResponse.json({
      error: 'Cannot confirm settlement: business is unverified',
    }, { status: 400 });
  }

  // SEC-005 Layer 4: Consume operation-bound step-up authorization
  // Placed after read-only validation so the token is not burned on a failing request.
  try {
    await consumeStepUp(admin, stepUpId, 'payout_confirm_settlement', id, {
      transfer_reference: transfer_reference.trim(),
      notes: notes ?? null,
    });
  } catch (err) {
    const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
    return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403 });
  }

  // ── Atomic CAS transition: approved → paid ──
  const { data: confirmResult } = await serviceClient
    .from('business_payouts')
    .update({
      status: 'paid',
      transfer_reference: transfer_reference.trim(),
      notes: notes || payout.notes || null,
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'approved')
    .eq('transfer_method', 'manual_bank')
    .select('id');

  if (!confirmResult || confirmResult.length === 0) {
    return NextResponse.json({
      error: 'Payout status has changed — cannot confirm settlement. Refresh and try again.',
    }, { status: 409 });
  }

  // ── Audit log — records admin attestation, not independent bank verification ──
  await logAdminAudit({
    actorId: admin.id,
    action: 'confirm_payout_settlement',
    entityType: 'business_payout',
    entityId: id,
    details: {
      business_id: payout.business_id,
      amount: payout.net_amount,
      transfer_reference: transfer_reference.trim(),
      attestation: 'Admin attested that the bank transfer has been completed',
    },
  });

  // ── Notification (non-blocking) ──
  const { data: biz } = await serviceClient
    .from('businesses')
    .select('name, owner_id, country_code')
    .eq('id', payout.business_id)
    .single();

  if (biz) {
    const cc = (biz.country_code || 'NG') as CountryCode;
    const amountStr = formatCurrency(Number(payout.net_amount), cc);

    const { data: ownerProfile } = await serviceClient
      .from('profiles')
      .select('email')
      .eq('id', biz.owner_id)
      .single();

    if (ownerProfile?.email) {
      const email = payoutPaidEmail(biz.name, amountStr, transfer_reference.trim());
      sendEmail({ to: ownerProfile.email, ...email }).catch(() => {});
    }

    try {
      await serviceClient.from('notifications').insert({
        business_id: payout.business_id,
        type: 'payment',
        channel: 'email',
        status: 'sent',
        subject: `Payout completed — ${amountStr}`,
        body: `Your payout of ${amountStr} for ${biz.name} has been sent to your bank account. Reference: ${transfer_reference.trim()}`,
        sent_at: new Date().toISOString(),
      });
    } catch { /* non-critical */ }
  }

  return NextResponse.json({ success: true, status: 'paid' });
}
