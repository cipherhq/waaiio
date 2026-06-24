import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';

/**
 * POST /api/cron/expire-transfers
 * Expires unconfirmed pending transfers past their deadline.
 * Auth: CRON_SECRET (fail-closed).
 */
export async function POST(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  try {
    const service = createServiceClient();
    const now = new Date().toISOString();

    // Fetch expired pending transfers
    const { data: expired, error: fetchErr } = await service
      .from('pending_transfers')
      .select('id, booking_id, order_id, customer_phone, business_id, reference_code, businesses(name)')
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

      // Cancel related order
      if (transfer.order_id) {
        await service
          .from('orders')
          .update({ status: 'cancelled' })
          .eq('id', transfer.order_id)
          .in('status', ['pending']);
      }

      // Notify customer via WhatsApp + email fallback
      if (transfer.customer_phone && transfer.business_id) {
        try {
          const resolver = new ChannelResolver(service);
          const resolved = await resolver.resolveByBusinessId(transfer.business_id);
          if (resolved) {
            const waText = `⏰ Your bank transfer (Ref: *${transfer.reference_code || 'N/A'}*) has expired. The payment window has closed and your booking has been cancelled.\n\nSend *Hi* to start a new booking.`;

            // Look up customer email for fallback/dual delivery
            const bizName = (transfer as any).businesses?.name || 'the business';
            const customerEmail = await findCustomerEmail(service, transfer.customer_phone, transfer.business_id);
            const emailPayload = customerEmail
              ? (() => {
                  const { subject, html } = businessNotificationEmail({
                    businessName: bizName,
                    title: 'Transfer Expired',
                    message: `Your bank transfer (Ref: ${transfer.reference_code || 'N/A'}) has expired. The payment window has closed and your booking has been cancelled.`,
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
