import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * PATCH /api/orders/[id]/tracking
 *
 * Atomic tracking mutation with audit log and durable notification intent.
 * The tracking edit commits atomically (RPC) and notification failure
 * does NOT roll back the committed tracking change.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const rateLimit = await rateLimitResponseAsync(
      getRateLimitKey(request, 'order-tracking-edit'),
      30,
      60_000,
    );
    if (rateLimit) return rateLimit;

    const { id: orderId } = await params;
    const body = await request.json();
    const { businessId, carrier, trackingNumber, notifyCustomer } = body;

    if (!orderId || !businessId) {
      return NextResponse.json(
        { error: 'orderId (path) and businessId (body) required' },
        { status: 400 },
      );
    }

    // ── Auth: verify user owns the business ──
    const authSupabase = await createClient();
    const {
      data: { user },
    } = await authSupabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const service = createServiceClient();

    // ── Capability enforcement: ordering/manage_existing ──
    const guard = await requireCapability(authSupabase, service, {
      businessId,
      userId: user.id,
      capability: 'ordering',
      action: 'manage_existing',
    });
    if (!guard.allowed) {
      return NextResponse.json(guard.denial, { status: guard.status });
    }

    // ── Atomic tracking mutation via RPC ──
    const { data: rpcResult, error: rpcError } = await service.rpc(
      'update_order_tracking',
      {
        p_order_id: orderId,
        p_business_id: businessId,
        p_user_id: user.id,
        p_carrier: carrier || null,
        p_tracking_number: trackingNumber || null,
        p_notify_customer: notifyCustomer === true,
      },
    );

    if (rpcError) {
      logger.error('[TRACKING-EDIT] RPC error:', rpcError);
      return NextResponse.json(
        { error: 'Failed to update tracking' },
        { status: 500 },
      );
    }

    const result = rpcResult as {
      success: boolean;
      error?: string;
      detail?: string;
      no_op?: boolean;
      revision?: number;
      notification_id?: string;
      pending_notification?: boolean;
      shipped_at?: string;
    };

    if (!result.success) {
      const statusMap: Record<string, number> = {
        order_not_found: 404,
        access_denied: 403,
        invalid_order_status: 422,
      };
      const httpStatus = statusMap[result.error ?? ''] ?? 400;
      return NextResponse.json(
        { error: result.error, detail: result.detail },
        { status: httpStatus },
      );
    }

    // ── Notification dispatch (fire-and-forget relative to tracking edit) ──
    let notificationStatus: 'not_requested' | 'sent' | 'failed' | 'indeterminate' =
      'not_requested';
    let providerMessageId: string | undefined;

    if (result.notification_id) {
      notificationStatus = await dispatchTrackingNotification(
        service,
        orderId,
        businessId,
        result.notification_id,
        carrier || null,
        trackingNumber || null,
      );
    }

    return NextResponse.json({
      success: true,
      no_op: result.no_op ?? false,
      revision: result.revision,
      shipped_at: result.shipped_at,
      notification: {
        status: notificationStatus,
        provider_message_id: providerMessageId,
      },
    });
  } catch (error) {
    logger.error('[TRACKING-EDIT] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

/**
 * Dispatches a tracking notification through the claim/dispatch/send/outcome
 * lifecycle. Notification failure does NOT roll back the tracking edit.
 */
async function dispatchTrackingNotification(
  service: ReturnType<typeof createServiceClient>,
  orderId: string,
  businessId: string,
  notificationId: string,
  carrier: string | null,
  trackingNumber: string | null,
): Promise<'sent' | 'failed' | 'indeterminate'> {
  try {
    // 1. Claim the notification
    const { data: claimResult, error: claimError } = await service.rpc(
      'claim_tracking_notification',
      { p_notification_id: notificationId, p_business_id: businessId },
    );

    if (claimError || !(claimResult as { success: boolean })?.success) {
      logger.warn('[TRACKING-NOTIF] Claim failed:', claimError ?? claimResult);
      return 'failed';
    }

    const claimToken = (claimResult as { claim_token: string }).claim_token;

    // 2. Mark dispatched (barrier — after this, no blind resend)
    const { data: dispatchResult, error: dispatchError } = await service.rpc(
      'mark_tracking_notification_dispatched',
      { p_notification_id: notificationId, p_claim_token: claimToken },
    );

    if (dispatchError || !(dispatchResult as { success: boolean })?.success) {
      logger.warn('[TRACKING-NOTIF] Dispatch barrier failed:', dispatchError ?? dispatchResult);
      return 'failed';
    }

    // 3. Send WhatsApp message
    let outcome: 'sent' | 'failed' | 'indeterminate' = 'indeterminate';
    let providerMessageId: string | null = null;
    let errorMessage: string | null = null;

    try {
      const sendResult = await sendTrackingWhatsApp(
        service,
        orderId,
        businessId,
        carrier,
        trackingNumber,
      );
      if (sendResult.success) {
        outcome = 'sent';
        providerMessageId = sendResult.messageId ?? null;
      } else {
        outcome = 'failed';
        errorMessage = 'WhatsApp send returned failure';
      }
    } catch (err) {
      // Post-dispatch unknown: record as indeterminate, NOT blind resend
      outcome = 'indeterminate';
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('[TRACKING-NOTIF] Send error (post-dispatch):', err);
    }

    // 4. Record outcome
    await service.rpc('record_tracking_notification_outcome', {
      p_notification_id: notificationId,
      p_claim_token: claimToken,
      p_outcome: outcome,
      p_provider_message_id: providerMessageId,
      p_error_message: errorMessage,
    });

    return outcome;
  } catch (err) {
    logger.error('[TRACKING-NOTIF] Lifecycle error:', err);
    return 'failed';
  }
}

/**
 * Sends the tracking notification via WhatsApp.
 */
async function sendTrackingWhatsApp(
  service: ReturnType<typeof createServiceClient>,
  orderId: string,
  businessId: string,
  carrier: string | null,
  trackingNumber: string | null,
): Promise<{ success: boolean; messageId?: string }> {
  // Fetch order details (reference_code, delivery_phone)
  const { data: order, error: orderError } = await service
    .from('orders')
    .select('reference_code, delivery_phone')
    .eq('id', orderId)
    .single();

  if (orderError || !order?.delivery_phone) {
    return { success: false };
  }

  // Fetch business name
  const { data: biz } = await service
    .from('businesses')
    .select('name')
    .eq('id', businessId)
    .single();
  const bizName = biz?.name || 'your store';

  // Resolve messaging channel
  const resolver = new ChannelResolver(service);
  const resolved = await resolver.resolveByBusinessId(businessId);
  if (!resolved?.sender) {
    logger.warn('[TRACKING-NOTIF] No messaging channel for business', businessId);
    return { success: false };
  }

  const phone = order.delivery_phone.startsWith('+')
    ? order.delivery_phone.slice(1)
    : order.delivery_phone;

  let message = `Your order *${order.reference_code}* from *${bizName}* has updated tracking!`;
  if (carrier) {
    message += `\n\nCarrier: ${carrier}`;
  }
  if (trackingNumber) {
    message += `\nTracking: ${trackingNumber}`;
  }

  // Try template first (works outside 24h window)
  let sent = false;
  let messageId: string | undefined;
  if (resolved.sender.sendTemplate) {
    try {
      const tmplResult = await resolved.sender.sendTemplate({
        to: phone,
        templateName: 'order_status_update',
        templateParams: [order.reference_code, 'shipped'],
      });
      sent = tmplResult.success !== false;
      messageId = tmplResult.messageId;
    } catch {
      /* template failed, fall back to text */
    }
  }
  if (!sent) {
    const textResult = await resolved.sender.sendText({ to: phone, text: message });
    messageId = textResult.messageId;
    sent = true;
  }

  return { success: sent, messageId };
}
