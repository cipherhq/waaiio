import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import * as Sentry from '@sentry/nextjs';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';
import { createNotification } from '@/lib/bot/flows/shared/notifications';

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

    // R3-B9: Already-confirmed order transfer retry — exact fail-closed lookup
    if (transfer.status !== 'pending') {
      if (transfer.status === 'confirmed' && transfer.order_id && action === 'confirm') {
        // Exact fail-closed lookup: all provenance fields required
        const { data: directPayments, error: retryLookupErr } = await service
          .from('payments')
          .select('id, metadata, payment_authority_version')
          .eq('order_id', transfer.order_id)
          .eq('business_id', business_id)
          .eq('gateway', 'direct')
          .eq('status', 'success')
          .not('payment_authority_version', 'is', null);

        if (retryLookupErr) {
          logger.error('[PENDING_TRANSFERS] Retry lookup error:', retryLookupErr.message);
          return NextResponse.json({ error: 'Retry lookup failed' }, { status: 500 });
        }

        // Filter by durable provenance
        const candidates = (directPayments || []).filter((p: any) => {
          const meta = (p.metadata || {}) as Record<string, unknown>;
          return meta._direct_transfer === true && meta.pending_transfer_id === transferId;
        });

        if (candidates.length === 0) {
          return NextResponse.json({ error: 'No matching direct payment found for retry' }, { status: 409 });
        }
        if (candidates.length > 1) {
          logger.error(`[PENDING_TRANSFERS] CRITICAL: Multiple direct payments for transfer ${transferId} — fail closed`);
          Sentry.captureException(new Error(`Multiple direct payments for transfer ${transferId}`), {
            tags: { component: 'pending-transfers', operation: 'retry-lookup' },
          });
          return NextResponse.json({ error: 'Multiple matching payments — contact support' }, { status: 409 });
        }

        const exactPaymentId = candidates[0].id;
        let retryFinalizationStatus = 'pending';
        try {
          const { resumeSuccessfulPaymentFinalization } = await import('@/lib/payments/authority');
          const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
          const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
          const lifecycle = await resumeSuccessfulPaymentFinalization(
            service, exactPaymentId,
            (sb, pay) => processSuccessfulPayment(sb, pay),
            (sb, pay, opts) => sendProactiveConfirmation(sb, pay, { logPrefix: '[TRANSFER-RETRY]', exactEntityFamily: opts?.exactEntityFamily }),
          );
          retryFinalizationStatus = lifecycle.status;
          if (lifecycle.status === 'rejected') {
            logger.error(`[PENDING_TRANSFERS] Retry resume returned rejected: ${lifecycle.reason}`);
            Sentry.captureException(new Error(`Direct retry rejected: ${lifecycle.reason}`), {
              tags: { component: 'pending-transfers', operation: 'retry-resume' },
            });
          }
        } catch (resumeErr) {
          logger.error('[PENDING_TRANSFERS] Retry resume error (non-fatal):', resumeErr);
          Sentry.captureException(resumeErr, { tags: { component: 'pending-transfers', operation: 'retry-resume' } });
          retryFinalizationStatus = 'error';
        }
        return NextResponse.json({ success: true, status: 'confirmed', finalization_status: retryFinalizationStatus });
      }

      return NextResponse.json(
        { error: `Transfer already ${transfer.status}` },
        { status: 409 },
      );
    }

    // ── Reject ──
    if (action === 'reject') {
      // M393: Order-linked rejection uses atomic RPC (restores stock, cancels order)
      if (transfer.order_id) {
        const { data: rejectResult, error: rejectErr } = await service.rpc('reject_order_transfer_atomic', {
          p_transfer_id: transferId,
          p_order_id: transfer.order_id,
          p_business_id: business_id,
          p_reason: reason || 'merchant_rejected',
        });

        if (rejectErr) {
          logger.error('[PENDING_TRANSFERS] reject_order_transfer_atomic error:', rejectErr.message);
          return NextResponse.json({ error: 'Failed to reject transfer' }, { status: 500 });
        }

        if (!rejectResult?.rejected) {
          return NextResponse.json(
            { error: `Cannot reject: ${rejectResult?.reason || 'unknown'}` },
            { status: 409 },
          );
        }

        // Notify customer — order is cancelled, not just transfer rejected
        if (transfer.customer_phone) {
          try {
            const resolver = new ChannelResolver(service);
            // R28/B5: Exact channel only for new M393 order transfers — no arbitrary fallback
            const transferMeta = (transfer.metadata || {}) as Record<string, unknown>;
            const exactChannelId = transferMeta._inbound_channel_id as string | undefined;
            if (!exactChannelId) {
              logger.error(`[PENDING_TRANSFERS] Order transfer ${transferId} has no exact channel evidence — skipping notification`);
            }
            const resolved = exactChannelId
              ? await resolver.resolveByChannelIdForBusiness(exactChannelId, business_id)
              : null;
            if (resolved) {
              const { data: biz } = await service.from('businesses').select('name').eq('id', business_id).single();
              const bizName = biz?.name || 'the business';
              const rejectionReason = reason || 'No reason provided';
              const messageText = `❌ Your bank transfer (Ref: *${transfer.reference_code}*) was not verified by *${bizName}*.\nReason: ${rejectionReason}\n\nYour order has been cancelled. Send *Hi* to start a new order.`;

              const customerEmail = await findCustomerEmail(service, transfer.customer_phone, business_id);
              await sendOrEmail({
                supabase: service,
                sender: resolved.sender,
                to: transfer.customer_phone,
                text: messageText,
                businessName: bizName,
                alwaysEmail: true,
                email: customerEmail ? {
                  address: customerEmail,
                  subject: `Transfer Not Verified - ${bizName}`,
                  html: businessNotificationEmail({
                    businessName: bizName,
                    title: 'Transfer Not Verified',
                    message: `Your bank transfer (Ref: ${transfer.reference_code}) was not verified.\nReason: ${rejectionReason}\n\nYour order has been cancelled.`,
                    details: { 'Reference': transfer.reference_code, 'Reason': rejectionReason },
                  }).html,
                } : null,
              });
            }
          } catch (notifyErr) {
            logger.error('[PENDING_TRANSFERS] Rejection notification error:', notifyErr);
          }
        }

        return NextResponse.json({ success: true, status: 'rejected' });
      }

      // Non-order rejection: preserve existing behavior
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

      // Notify customer via WhatsApp (with email fallback) that their transfer was rejected
      if (transfer.customer_phone) {
        try {
          const resolver = new ChannelResolver(service);
          const resolved = await resolver.resolveByBusinessId(business_id);
          if (resolved) {
            const { data: biz } = await service
              .from('businesses')
              .select('name')
              .eq('id', business_id)
              .single();
            const bizName = biz?.name || 'the business';
            const rejectionReason = reason || 'No reason provided';
            const messageText = `❌ Your bank transfer (Ref: *${transfer.reference_code}*) was not verified by *${bizName}*.\nReason: ${rejectionReason}\n\nPlease try again or use the online payment link. Send *Hi* to start over.`;

            const customerEmail = await findCustomerEmail(service, transfer.customer_phone, business_id);
            await sendOrEmail({
              supabase: service,
              sender: resolved.sender,
              to: transfer.customer_phone,
              text: messageText,
              businessName: bizName,
              alwaysEmail: true,
              email: customerEmail ? {
                address: customerEmail,
                subject: `Transfer Not Verified - ${bizName}`,
                html: businessNotificationEmail({
                  businessName: bizName,
                  title: 'Transfer Not Verified',
                  message: `Your bank transfer (Ref: ${transfer.reference_code}) was not verified.\nReason: ${rejectionReason}\n\nPlease try again or use the online payment link.`,
                  details: {
                    'Reference': transfer.reference_code,
                    'Reason': rejectionReason,
                  },
                }).html,
              } : null,
            });
          }
        } catch (notifyErr) {
          logger.error('[PENDING_TRANSFERS] Rejection notification error:', notifyErr);
        }
      }

      return NextResponse.json({ success: true, status: 'rejected' });
    }

    // ── Confirm ──

    // M393: Order-linked confirmation uses atomic RPC
    if (transfer.order_id) {
      const { data: confirmResult, error: confirmErr } = await service.rpc('confirm_order_transfer_atomic', {
        p_transfer_id: transferId,
        p_order_id: transfer.order_id,
        p_business_id: business_id,
        p_confirmed_by: user.id,
      });

      if (confirmErr) {
        logger.error('[PENDING_TRANSFERS] confirm_order_transfer_atomic error:', confirmErr.message);
        return NextResponse.json({ error: 'Failed to confirm transfer' }, { status: 500 });
      }

      if (!confirmResult?.confirmed) {
        return NextResponse.json(
          { error: `Cannot confirm: ${confirmResult?.reason || 'unknown'}` },
          { status: 409 },
        );
      }

      // M394/Phase 2D: Delegate Stage 2→3 to canonical Payment Authority
      // R2 item 11: Downstream failure cannot undo financial success
      const paymentId = confirmResult.payment_id as string;
      let finalizationStatus = 'pending';
      try {
        const { resumeSuccessfulPaymentFinalization } = await import('@/lib/payments/authority');
        const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
        const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
        const lifecycle = await resumeSuccessfulPaymentFinalization(
          service, paymentId,
          (sb, pay) => processSuccessfulPayment(sb, pay),
          (sb, pay, opts) => sendProactiveConfirmation(sb, pay, { logPrefix: '[TRANSFER-CONFIRM]', exactEntityFamily: opts?.exactEntityFamily }),
        );
        finalizationStatus = lifecycle.status;
      } catch (resumeErr) {
        // Log but do NOT fail the financial confirmation
        logger.error('[PENDING_TRANSFERS] Payment Authority resume error (non-fatal):', resumeErr);
        Sentry.captureException(resumeErr, { tags: { component: 'pending-transfers', operation: 'resume-finalization' } });
        finalizationStatus = 'error';
      }

      return NextResponse.json({ success: true, status: 'confirmed', finalization_status: finalizationStatus });
    }

    // ── Non-order confirmation: preserve existing behavior ──
    const now = new Date().toISOString();

    // 1. Update pending_transfer status (guard with status='pending' to prevent double-confirm)
    const { data: confirmedRows, error: confirmErr } = await service
      .from('pending_transfers')
      .update({
        status: 'confirmed',
        confirmed_by: user.id,
        confirmed_at: now,
      })
      .eq('id', transferId)
      .eq('status', 'pending')
      .select('id');

    if (confirmErr) {
      logger.error('[PENDING_TRANSFERS] Confirm update error:', confirmErr.message);
      return NextResponse.json({ error: 'Failed to confirm transfer' }, { status: 500 });
    }

    if (!confirmedRows || confirmedRows.length === 0) {
      return NextResponse.json({ error: 'Transfer already confirmed or no longer pending' }, { status: 409 });
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

    if (transfer.invoice_id) {
      await service
        .from('invoices')
        .update({
          status: 'paid',
          paid_at: now,
        })
        .eq('id', transfer.invoice_id);
    }

    // 3. Record platform fee for analytics (zero fee — direct transfers included in subscription)
    await service.from('platform_fees').insert({
      business_id: business_id,
      booking_id: transfer.booking_id || null,
      invoice_id: transfer.invoice_id || null,
      order_id: null,
      transaction_amount: transfer.expected_amount,
      fee_percentage: 0,
      fee_flat: 0,
      fee_total: 0,
      gateway_fee: 0,
      tier: (business.subscription_tier || 'free') as string,
      is_direct_transfer: true,
    }).then(({ error }) => {
      if (error) logger.error('[PENDING_TRANSFERS] Analytics fee record error:', error.message);
    });

    // 4. Create payment record
    const { error: paymentErr } = await service.from('payments').insert({
      business_id: business_id,
      amount: transfer.expected_amount,
      currency: transfer.currency || 'NGN',
      status: 'success',
      payment_method: 'bank_transfer',
      gateway: 'direct',
      booking_id: transfer.booking_id || null,
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

    // 5. Notify customer via WhatsApp (with email fallback) that transfer was confirmed
    if (transfer.customer_phone) {
      try {
        const resolver = new ChannelResolver(service);
        const resolved = await resolver.resolveByBusinessId(business_id);
        if (resolved) {
          const { data: biz } = await service
            .from('businesses')
            .select('name, country_code')
            .eq('id', business_id)
            .single();
          const cc = (biz?.country_code || 'NG') as CountryCode;
          const bizName = biz?.name || 'Business';
          const amountFormatted = formatCurrency(transfer.expected_amount / 100, cc);
          const messageText = `✅ *Payment Confirmed!*\n\n💰 ${amountFormatted}\n🔑 Ref: *${transfer.reference_code}*\n🏢 ${bizName}\n\nYour booking is confirmed. Thank you!`;

          const customerEmail = await findCustomerEmail(service, transfer.customer_phone, business_id);
          await sendOrEmail({
            supabase: service,
            sender: resolved.sender,
            to: transfer.customer_phone,
            text: messageText,
            businessName: bizName,
            alwaysEmail: true,
            email: customerEmail ? {
              address: customerEmail,
              subject: `Payment Confirmed - ${bizName}`,
              html: businessNotificationEmail({
                businessName: bizName,
                title: 'Payment Confirmed',
                message: 'Your bank transfer has been verified and your booking is confirmed. Thank you!',
                details: {
                  'Amount': amountFormatted,
                  'Reference': transfer.reference_code,
                },
              }).html,
            } : null,
          });
        }
      } catch (notifyErr) {
        logger.error('[PENDING_TRANSFERS] Customer notification error:', notifyErr);
      }
    }

    // 6. In-app notification
    createNotification(service, {
      businessId: business_id,
      bookingId: transfer.booking_id || undefined,
      type: 'transfer_confirmed',
      channel: 'dashboard',
      body: `Bank transfer of ${formatCurrency(transfer.expected_amount / 100, 'NG')} confirmed. Ref: ${transfer.reference_code}`,
    }).catch(err => logger.error('[PENDING_TRANSFERS] Notification error:', err));

    return NextResponse.json({ success: true, status: 'confirmed' });
  } catch (err) {
    logger.error('[PENDING_TRANSFERS] PATCH error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
