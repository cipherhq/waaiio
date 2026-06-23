import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { getPlatformFees } from '@/lib/getPlatformFees';
import type { SubscriptionTier } from '@/lib/constants';
import { logger } from '@/lib/logger';

/**
 * PATCH /api/dashboard/pending-transfers/[id]
 * Confirm or reject a pending bank transfer.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: transferId } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { action, reason, business_id } = body;

    if (!action || !['confirm', 'reject'].includes(action)) {
      return NextResponse.json({ error: 'action must be "confirm" or "reject"' }, { status: 400 });
    }
    if (!business_id) {
      return NextResponse.json({ error: 'business_id is required' }, { status: 400 });
    }

    // Verify ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id, subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat, payout_mode, reseller_id')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Business not found or access denied' }, { status: 403 });
    }

    const service = createServiceClient();

    // Fetch the transfer
    const { data: transfer } = await service
      .from('pending_transfers')
      .select('*')
      .eq('id', transferId)
      .eq('business_id', business_id)
      .maybeSingle();

    if (!transfer) {
      return NextResponse.json({ error: 'Transfer not found' }, { status: 404 });
    }

    if (transfer.status !== 'pending') {
      return NextResponse.json(
        { error: `Transfer already ${transfer.status}` },
        { status: 409 },
      );
    }

    // ── Reject ──
    if (action === 'reject') {
      const { error: rejectErr } = await service
        .from('pending_transfers')
        .update({
          status: 'rejected',
          rejected_reason: reason || null,
        })
        .eq('id', transferId);

      if (rejectErr) {
        logger.error('[PENDING_TRANSFERS] Reject error:', rejectErr.message);
        return NextResponse.json({ error: 'Failed to reject transfer' }, { status: 500 });
      }

      return NextResponse.json({ success: true, status: 'rejected' });
    }

    // ── Confirm ──
    const now = new Date().toISOString();

    // 1. Update pending_transfer status
    const { error: confirmErr } = await service
      .from('pending_transfers')
      .update({
        status: 'confirmed',
        confirmed_by: user.id,
        confirmed_at: now,
      })
      .eq('id', transferId);

    if (confirmErr) {
      logger.error('[PENDING_TRANSFERS] Confirm update error:', confirmErr.message);
      return NextResponse.json({ error: 'Failed to confirm transfer' }, { status: 500 });
    }

    // 2. Update related entity
    if (transfer.booking_id) {
      await service
        .from('bookings')
        .update({
          deposit_status: 'paid',
          status: 'confirmed',
          confirmed_at: now,
        })
        .eq('id', transfer.booking_id);
    }

    if (transfer.order_id) {
      await service
        .from('orders')
        .update({
          status: 'confirmed',
          paid_at: now,
        })
        .eq('id', transfer.order_id);
    }

    if (transfer.invoice_id) {
      await service
        .from('invoices')
        .update({
          status: 'paid',
          paid_at: now,
        })
        .eq('id', transfer.invoice_id);
    }

    // 3. Record platform fee (skip for direct_split businesses)
    if (business.payout_mode !== 'direct_split') {
      const tier = (business.subscription_tier || 'free') as SubscriptionTier;
      const isInTrial = tier === 'free' && new Date(business.trial_ends_at) > new Date();

      const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(
        transfer.expected_amount,
        tier,
        isInTrial,
        {
          feePercentage: business.custom_fee_percentage != null ? Number(business.custom_fee_percentage) : null,
          feeFlat: business.custom_fee_flat != null ? Number(business.custom_fee_flat) : null,
        },
      );

      // Calculate reseller commission if applicable
      let resellerId: string | null = business.reseller_id || null;
      let resellerCommission = 0;

      if (resellerId && feeTotal > 0) {
        const { data: reseller } = await service
          .from('resellers')
          .select('id, commission_percentage, status')
          .eq('id', resellerId)
          .maybeSingle();

        if (reseller && reseller.status === 'active' && reseller.commission_percentage > 0) {
          resellerCommission = Math.round(feeTotal * (Number(reseller.commission_percentage) / 100));
        } else {
          resellerId = null;
        }
      }

      const { error: feeErr } = await service.from('platform_fees').insert({
        business_id: business_id,
        booking_id: transfer.booking_id || null,
        invoice_id: transfer.invoice_id || null,
        order_id: transfer.order_id || null,
        transaction_amount: transfer.expected_amount,
        fee_percentage: feePercentage,
        fee_flat: feeFlat,
        fee_total: feeTotal,
        gateway_fee: 0,
        tier,
        is_direct_transfer: true,
        reseller_id: resellerId,
        reseller_commission: resellerCommission,
      });

      if (feeErr) {
        logger.error('[PENDING_TRANSFERS] Platform fee error (possible duplicate):', feeErr.message);
      }
    }

    // 4. Create payment record
    const { error: paymentErr } = await service.from('payments').insert({
      business_id: business_id,
      amount: transfer.expected_amount,
      currency: transfer.currency || 'NGN',
      status: 'success',
      payment_method: 'bank_transfer',
      gateway: 'direct',
      booking_id: transfer.booking_id || null,
      order_id: transfer.order_id || null,
      invoice_id: transfer.invoice_id || null,
      customer_phone: transfer.customer_phone || null,
      customer_name: transfer.customer_name || null,
      reference: transfer.reference_code || null,
      metadata: {
        pending_transfer_id: transferId,
        confirmed_by: user.id,
        proof_type: transfer.proof_type,
      },
    });

    if (paymentErr) {
      logger.error('[PENDING_TRANSFERS] Payment record error:', paymentErr.message);
    }

    return NextResponse.json({ success: true, status: 'confirmed' });
  } catch (err) {
    logger.error('[PENDING_TRANSFERS] PATCH error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
