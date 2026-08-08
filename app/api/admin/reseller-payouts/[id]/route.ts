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
    const auth = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

    // Input validation
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Invalid payout ID' }, { status: 400 });
    }

    const body = await request.json();
    const { action, notes } = body;

    if (!action || !['approve', 'reject', 'mark_paid'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action. Must be approve, reject, or mark_paid' }, { status: 400 });
    }

    const service = createServiceClient();

    // ── mark_paid: use atomic RPC with reseller-level advisory lock ──
    if (action === 'mark_paid') {
      const { data: rpcResult, error: rpcErr } = await service.rpc('mark_reseller_payout_paid', {
        p_payout_id: id,
        p_admin_id: auth.id,
      });

      if (rpcErr) {
        logger.error(`[ADMIN_RESELLER_PAYOUTS] mark_paid RPC error for ${id}:`, rpcErr.message);
        return NextResponse.json({ error: 'Failed to mark payout as paid' }, { status: 500 });
      }

      if (!rpcResult?.success) {
        const reason = rpcResult?.reason;
        if (reason === 'not_found') {
          return NextResponse.json({ error: 'Payout not found' }, { status: 404 });
        }
        if (reason === 'not_approved') {
          return NextResponse.json({ error: 'Only approved payouts can be marked as paid' }, { status: 400 });
        }
        if (reason === 'insufficient_balance') {
          return NextResponse.json({
            error: 'Insufficient balance',
            details: {
              total_earned: rpcResult.total_earned,
              total_paid: rpcResult.total_paid,
              available: rpcResult.available,
              payout_amount: rpcResult.requested,
            },
          }, { status: 400 });
        }
        if (reason === 'status_changed') {
          return NextResponse.json({ error: 'Payout status has changed — please refresh and try again' }, { status: 409 });
        }
        return NextResponse.json({ error: reason || 'mark_paid failed' }, { status: 400 });
      }

      // Audit log (server-side, separate write — failure logged but does not roll back payout)
      const { error: auditErr } = await service.from('admin_audit_logs').insert({
        actor_id: auth.id,
        action: 'reseller_payout_mark_paid',
        entity_type: 'reseller_payout',
        entity_id: id,
        details: {
          available_after: rpcResult.available_after,
          ...(notes ? { notes } : {}),
        },
      });
      if (auditErr) {
        logger.error(`[ADMIN_RESELLER_PAYOUTS] Audit log failed for mark_paid ${id}:`, auditErr.message);
      }

      logger.info(`[ADMIN_RESELLER_PAYOUTS] Payout ${id} mark_paid: available_after=${rpcResult.available_after}`);
      return NextResponse.json({ success: true, available_after: rpcResult.available_after });
    }

    // ── approve / reject: CAS UPDATE ──

    // Fetch the payout for pre-check and audit context
    const { data: payout, error: fetchErr } = await service
      .from('reseller_payouts')
      .select('id, reseller_id, status, net_amount, notes')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !payout) {
      return NextResponse.json({ error: 'Payout not found' }, { status: 404 });
    }

    let updateData: Record<string, unknown> = {};
    let allowedSourceStatuses: string[] = [];

    if (action === 'approve') {
      if (payout.status !== 'pending') {
        return NextResponse.json({ error: 'Only pending payouts can be approved' }, { status: 400 });
      }
      allowedSourceStatuses = ['pending'];
      updateData = {
        status: 'approved',
        approved_by: auth.id,
        notes: notes || payout.notes,
      };
    } else if (action === 'reject') {
      if (payout.status !== 'pending' && payout.status !== 'approved') {
        return NextResponse.json({ error: 'Only pending or approved payouts can be rejected' }, { status: 400 });
      }
      allowedSourceStatuses = ['pending', 'approved'];
      updateData = {
        status: 'rejected',
        notes: notes || payout.notes,
      };
    }

    // Atomic CAS: include expected source status in UPDATE
    const { data: updated, error: updateErr } = await service
      .from('reseller_payouts')
      .update(updateData)
      .eq('id', id)
      .in('status', allowedSourceStatuses)
      .select()
      .maybeSingle();

    if (updateErr) {
      logger.error(`[ADMIN_RESELLER_PAYOUTS] Update error for ${id}:`, updateErr.message);
      return NextResponse.json({ error: 'Failed to update payout' }, { status: 500 });
    }

    if (!updated) {
      return NextResponse.json({ error: 'Payout status has changed — please refresh and try again' }, { status: 409 });
    }

    // Audit log (server-side, separate write — failure logged but does not roll back)
    const { error: auditErr } = await service.from('admin_audit_logs').insert({
      actor_id: auth.id,
      action: `reseller_payout_${action}`,
      entity_type: 'reseller_payout',
      entity_id: id,
      details: {
        reseller_id: payout.reseller_id,
        previous_status: payout.status,
        new_status: updated.status,
        net_amount: payout.net_amount,
        ...(notes ? { notes } : {}),
      },
    });
    if (auditErr) {
      logger.error(`[ADMIN_RESELLER_PAYOUTS] Audit log failed for ${action} ${id}:`, auditErr.message);
    }

    logger.info(`[ADMIN_RESELLER_PAYOUTS] Payout ${id} ${action}: status=${updated.status}`);
    return NextResponse.json({ payout: updated });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
