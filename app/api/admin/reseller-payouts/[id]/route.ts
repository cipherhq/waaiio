import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

async function getAdminAuth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !['admin', 'finance'].includes(profile.role)) return null;
  return { user, role: profile.role as string };
}

const VALID_ACTIONS = ['approve', 'reject', 'mark_paid'] as const;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const auth = await getAdminAuth();
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { action, notes } = body;

    if (!action || !VALID_ACTIONS.includes(action)) {
      return NextResponse.json({ error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}` }, { status: 400 });
    }

    // approve and reject require admin role; mark_paid allows admin or finance
    if ((action === 'approve' || action === 'reject') && auth.role !== 'admin') {
      return NextResponse.json({ error: 'Only admins can approve or reject payouts' }, { status: 403 });
    }

    const service = createServiceClient();

    // Fetch the payout
    const { data: payout, error: fetchErr } = await service
      .from('reseller_payouts')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !payout) {
      return NextResponse.json({ error: 'Payout not found' }, { status: 404 });
    }

    // State transition validation + compare-and-set
    const allowedFrom: Record<string, string[]> = {
      approve: ['pending'],
      reject: ['pending', 'approved'],
      mark_paid: ['approved'],
    };

    if (!allowedFrom[action].includes(payout.status)) {
      return NextResponse.json({
        error: `Cannot ${action} a payout in '${payout.status}' status`,
      }, { status: 400 });
    }

    let updateData: Record<string, unknown> = {};

    if (action === 'approve') {
      updateData = { status: 'approved', approved_by: auth.user.id, notes: notes || payout.notes };
    } else if (action === 'reject') {
      updateData = { status: 'rejected', notes: notes || payout.notes };
    } else if (action === 'mark_paid') {
      // Re-verify balance
      const { data: allFees } = await service
        .from('platform_fees')
        .select('reseller_commission')
        .eq('reseller_id', payout.reseller_id);

      const totalEarned = (allFees || []).reduce((sum: number, f: { reseller_commission: number | null }) => sum + (f.reseller_commission || 0), 0);

      const { data: paidPayouts } = await service
        .from('reseller_payouts')
        .select('net_amount')
        .eq('reseller_id', payout.reseller_id)
        .eq('status', 'paid');

      const totalPaidOut = (paidPayouts || []).reduce((sum: number, p: { net_amount: number }) => sum + (p.net_amount || 0), 0);

      if (payout.net_amount > totalEarned - totalPaidOut) {
        return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
      }

      updateData = { status: 'paid', paid_at: new Date().toISOString(), notes: notes || payout.notes };
    }

    // Compare-and-set: only update if status hasn't changed
    const { data: updated, error: updateErr } = await service
      .from('reseller_payouts')
      .update(updateData)
      .eq('id', id)
      .in('status', allowedFrom[action])
      .select()
      .maybeSingle();

    if (updateErr || !updated) {
      return NextResponse.json({ error: 'Payout was already processed by another administrator' }, { status: 409 });
    }

    // Mandatory audit — failure reverts the update
    const { error: auditErr } = await service.from('admin_audit_logs').insert({
      actor_id: auth.user.id,
      action: `reseller_payout_${action}`,
      entity_type: 'reseller_payout',
      entity_id: id,
      details: {
        reseller_id: payout.reseller_id,
        amount: payout.net_amount,
        previous_status: payout.status,
        new_status: updated.status,
        ...(action === 'reject' ? { reason: notes } : {}),
      },
    });

    if (auditErr) {
      // Revert the update
      await service.from('reseller_payouts')
        .update({ status: payout.status, approved_by: payout.approved_by, paid_at: payout.paid_at, notes: payout.notes })
        .eq('id', id);
      logger.error(`[RESELLER-PAYOUT] Audit failed, reverted ${id}:`, auditErr.message);
      return NextResponse.json({ error: 'Audit logging failed — action reverted' }, { status: 500 });
    }

    logger.info(`[RESELLER-PAYOUT] ${id} ${action}: ${payout.status} → ${updated.status}`);
    return NextResponse.json({ payout: updated });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
