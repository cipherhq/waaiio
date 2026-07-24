import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const auth = await requirePlatformAdmin(request, { requiredRole: ['admin', 'finance'] });
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

    const body = await request.json();
    const { action, notes } = body;

    if (!action || !['approve', 'reject', 'mark_paid'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action. Must be approve, reject, or mark_paid' }, { status: 400 });
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

    let updateData: Record<string, any> = {};

    if (action === 'approve') {
      if (payout.status !== 'pending') {
        return NextResponse.json({ error: 'Only pending payouts can be approved' }, { status: 400 });
      }
      updateData = {
        status: 'approved',
        approved_by: auth.id,
        notes: notes || payout.notes,
      };
    } else if (action === 'reject') {
      if (payout.status !== 'pending' && payout.status !== 'approved') {
        return NextResponse.json({ error: 'Only pending or approved payouts can be rejected' }, { status: 400 });
      }
      updateData = {
        status: 'rejected',
        notes: notes || payout.notes,
      };
    } else if (action === 'mark_paid') {
      if (payout.status !== 'approved') {
        return NextResponse.json({ error: 'Only approved payouts can be marked as paid' }, { status: 400 });
      }

      // Re-verify balance before paying: sum earned - sum already paid
      const { data: allFees } = await service
        .from('platform_fees')
        .select('reseller_commission')
        .eq('reseller_id', payout.reseller_id);

      const totalEarned = (allFees || []).reduce((sum: number, f: any) => sum + (f.reseller_commission || 0), 0);

      const { data: paidPayouts } = await service
        .from('reseller_payouts')
        .select('net_amount')
        .eq('reseller_id', payout.reseller_id)
        .eq('status', 'paid');

      const totalPaidOut = (paidPayouts || []).reduce((sum: number, p: any) => sum + (p.net_amount || 0), 0);

      const availableBalance = totalEarned - totalPaidOut;

      if (payout.net_amount > availableBalance) {
        return NextResponse.json({
          error: 'Insufficient balance',
          details: {
            total_earned: totalEarned,
            total_paid_out: totalPaidOut,
            available: availableBalance,
            payout_amount: payout.net_amount,
          },
        }, { status: 400 });
      }

      updateData = {
        status: 'paid',
        paid_at: new Date().toISOString(),
        notes: notes || payout.notes,
      };
    }

    const { data: updated, error: updateErr } = await service
      .from('reseller_payouts')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (updateErr) {
      logger.error(`[ADMIN_RESELLER_PAYOUTS] Update error for ${id}:`, updateErr.message);
      return NextResponse.json({ error: 'Failed to update payout' }, { status: 500 });
    }

    logger.info(`[ADMIN_RESELLER_PAYOUTS] Payout ${id} ${action}: status=${updated.status}`);
    return NextResponse.json({ payout: updated });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
