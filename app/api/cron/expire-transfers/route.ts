import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';
import { hasProtectedProof, hasSuccessfulPayment } from '@/lib/payments/stale-transfers';

/**
 * GET /api/cron/expire-transfers (Vercel Cron sends GET; POST kept for manual runs)
 * Expires unconfirmed pending transfers past their deadline.
 * Auth: CRON_SECRET (fail-closed).
 */
export async function GET(request: NextRequest) {
  return POST(request);
}

export async function POST(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  try {
    const service = createServiceClient();
    const now = new Date().toISOString();

    // Fetch expired pending transfers
    const { data: expired, error: fetchErr } = await service
      .from('pending_transfers')
      .select('id, booking_id, order_id, reservation_id, invoice_id, customer_phone, business_id, reference_code, metadata, expires_at, proof_protected, proof_submitted_at, proof_image_url, proof_text, businesses(name)')
      .eq('status', 'pending')
      .lt('expires_at', now);

    if (fetchErr) {
      logger.error('[EXPIRE_TRANSFERS] Fetch error:', fetchErr.message);
      return NextResponse.json({ error: 'Failed to fetch expired transfers' }, { status: 500 });
    }

    if (!expired || expired.length === 0) {
      return NextResponse.json({ expired: 0 });
    }

    let expiredCount = 0;

    for (const transfer of expired) {
      // M393: Order-linked transfers delegate to canonical cancel RPC
      if (transfer.order_id) {
        // Do NOT pre-mark transfer expired — the RPC owns terminal state
        const { data: cancelResult, error: cancelErr } = await service.rpc('cancel_stale_order_atomic', {
          p_order_id: transfer.order_id,
        });

        if (cancelErr) {
          logger.error(`[EXPIRE_TRANSFERS] cancel_stale_order_atomic error for transfer ${transfer.id}:`, cancelErr.message);
          continue;
        }

        // Only count + notify if canonical cancellation actually won
        if (!cancelResult?.cancelled) {
          // Payment/confirmation/extension won after preselection — no false expiry
          logger.info(`[EXPIRE_TRANSFERS] Order ${transfer.order_id} not cancelled (reason: ${cancelResult?.reason}), skipping transfer ${transfer.id}`);
          continue;
        }

        // Canonical cancel succeeded — transfer was expired by the RPC
        // Fall through to notification
      } else {
        // Non-order transfers.
        // A receipt sent in time is held for the merchant, never expired (contract #736 §5.4;
        // same rule cancel_stale_order_atomic applies to orders).
        if (hasProtectedProof(transfer)) {
          if (!transfer.proof_protected) {
            const { error: protectErr } = await service
              .from('pending_transfers')
              .update({ proof_protected: true })
              .eq('id', transfer.id)
              .eq('status', 'pending');
            if (protectErr) logger.error(`[EXPIRE_TRANSFERS] Failed to protect transfer ${transfer.id}:`, protectErr.message);
          }
          continue;
        }

        // Paid another way (e.g. card) meanwhile: close the unused offer quietly —
        // no "expired" message, booking untouched (Owner Option A, 2026-11-12).
        let paidOtherwise: boolean;
        try {
          paidOtherwise = await hasSuccessfulPayment(service, transfer);
        } catch (payErr) {
          logger.error(`[EXPIRE_TRANSFERS] Payment lookup failed for transfer ${transfer.id}:`, payErr);
          continue;
        }
        if (paidOtherwise) {
          const { error: cancelErr } = await service
            .from('pending_transfers')
            .update({ status: 'cancelled' })
            .eq('id', transfer.id)
            .eq('status', 'pending');
          if (cancelErr) logger.error(`[EXPIRE_TRANSFERS] Failed to close paid transfer ${transfer.id}:`, cancelErr.message);
          continue;
        }

        // Mark transfer as expired
        const { error: updateErr } = await service
          .from('pending_transfers')
          .update({ status: 'expired' })
          .eq('id', transfer.id)
          .eq('status', 'pending'); // Guard against race conditions

        if (updateErr) {
          logger.error(`[EXPIRE_TRANSFERS] Failed to expire transfer ${transfer.id}:`, updateErr.message);
          continue;
        }

        // Cancel related booking
        if (transfer.booking_id) {
          await service
            .from('bookings')
            .update({ status: 'cancelled' })
            .eq('id', transfer.booking_id)
            .in('status', ['pending']);
        }
      }

      // Notify customer via WhatsApp + email fallback
      if (transfer.customer_phone && transfer.business_id) {
        try {
          const resolver = new ChannelResolver(service);
          // R28/B5: Order-linked transfers use exact channel, not arbitrary business resolver
          const transferMeta = ((transfer as any).metadata || {}) as Record<string, unknown>;
          const exactChannelId = transfer.order_id ? (transferMeta._inbound_channel_id as string | undefined) : undefined;
          const resolved = exactChannelId
            ? await resolver.resolveByChannelIdForBusiness(exactChannelId, transfer.business_id)
            : transfer.order_id
              ? null  // Order transfer without exact channel — skip notification
              : await resolver.resolveByBusinessId(transfer.business_id);
          // Order-specific vs booking copy
          const entityCopy = transfer.order_id
            ? 'your order has been cancelled'
            : 'your booking has been cancelled';
          if (resolved) {
            const waText = `⏰ Your bank transfer (Ref: *${transfer.reference_code || 'N/A'}*) has expired. The payment window has closed and ${entityCopy}.\n\nSend *Hi* to start over.`;

            // Look up customer email for fallback/dual delivery
            const bizName = (transfer as any).businesses?.name || 'the business';
            const customerEmail = await findCustomerEmail(service, transfer.customer_phone, transfer.business_id);
            const emailPayload = customerEmail
              ? (() => {
                  const { subject, html } = businessNotificationEmail({
                    businessName: bizName,
                    title: 'Transfer Expired',
                    message: `Your bank transfer (Ref: ${transfer.reference_code || 'N/A'}) has expired. The payment window has closed and ${entityCopy}.`,
                    details: {
                      'Reference': transfer.reference_code || 'N/A',
                      'Status': 'Expired',
                    },
                  });
                  return { address: customerEmail, subject, html };
                })()
              : null;

            await sendOrEmail({
              supabase: service,
              sender: resolved.sender,
              to: transfer.customer_phone,
              text: waText,
              email: emailPayload,
              businessName: bizName,
              alwaysEmail: true,
              // #721: free-form transactional notice; without a category the
              // financial authorization guard refuses it (missing_message_category).
              messageCategory: 'service',
            });
          }
        } catch (notifyErr) {
          logger.error(`[EXPIRE_TRANSFERS] Failed to notify customer for transfer ${transfer.id}:`, notifyErr);
        }
      }

      expiredCount++;
    }

    logger.info(`[EXPIRE_TRANSFERS] Expired ${expiredCount} transfers`);
    return NextResponse.json({ expired: expiredCount });
  } catch (err) {
    logger.error('[EXPIRE_TRANSFERS] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
