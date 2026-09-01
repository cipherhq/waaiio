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
    let notificationStatus: 'not_requested' | 'sent' | 'failed' | 'indeterminate' | 'preflight_failed' =
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
 * Preflight data needed before crossing the dispatch barrier.
 * All DB lookups, phone validation, channel resolution, and message
 * construction happen here — before any provider API call.
 */
interface NotificationPreflight {
  phone: string;
  message: string;
  referenceCode: string;
  sender: {
    sendTemplate?: (msg: {
      to: string;
      templateName: string;
      templateParams: string[];
      noRetry?: boolean;
    }) => Promise<{ success?: boolean; messageId?: string }>;
    sendText: (msg: {
      to: string;
      text: string;
      noRetry?: boolean;
    }) => Promise<{ success?: boolean; messageId?: string }>;
  };
}

/**
 * Performs all non-provider preflight work for a tracking notification.
 * Returns null if any preflight step fails (safely retryable).
 */
async function performNotificationPreflight(
  service: ReturnType<typeof createServiceClient>,
  orderId: string,
  businessId: string,
  carrier: string | null,
  trackingNumber: string | null,
): Promise<{ data: NotificationPreflight } | { error: string }> {
  // Fetch order details
  const { data: order, error: orderError } = await service
    .from('orders')
    .select('reference_code, delivery_phone')
    .eq('id', orderId)
    .single();

  if (orderError || !order?.reference_code) {
    return { error: 'Order lookup failed' };
  }
  if (!order.delivery_phone) {
    return { error: 'No delivery phone on order' };
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
    return { error: `No messaging channel for business ${businessId}` };
  }

  const phone = order.delivery_phone.startsWith('+')
    ? order.delivery_phone.slice(1)
    : order.delivery_phone;

  if (!phone || phone.length < 7) {
    return { error: 'Invalid delivery phone number' };
  }

  let message = `Your order *${order.reference_code}* from *${bizName}* has updated tracking!`;
  if (carrier) {
    message += `\n\nCarrier: ${carrier}`;
  }
  if (trackingNumber) {
    message += `\nTracking: ${trackingNumber}`;
  }

  return {
    data: {
      phone,
      message,
      referenceCode: order.reference_code,
      sender: resolved.sender,
    },
  };
}

/**
 * Dispatches a tracking notification through the claim/dispatch/send/outcome
 * lifecycle. Notification failure does NOT roll back the tracking edit.
 *
 * Dispatch barrier contract:
 * - ALL preflight (DB lookups, phone validation, channel resolution, message
 *   construction) completes BEFORE crossing the barrier
 * - After the barrier, exactly ONE provider API call is made (no retry, no fallback)
 * - Ambiguous outcomes (network error, 5xx) -> indeterminate, NOT blind resend
 * - Retrying the same revision after dispatched/indeterminate -> zero additional calls
 */
async function dispatchTrackingNotification(
  service: ReturnType<typeof createServiceClient>,
  orderId: string,
  businessId: string,
  notificationId: string,
  carrier: string | null,
  trackingNumber: string | null,
): Promise<'sent' | 'failed' | 'indeterminate' | 'preflight_failed'> {
  try {
    // ── Step 1: ALL preflight BEFORE any claim/dispatch ──
    const preflight = await performNotificationPreflight(
      service,
      orderId,
      businessId,
      carrier,
      trackingNumber,
    );

    if ('error' in preflight) {
      // Deterministic preflight failure — notification row stays in 'pending' (retryable).
      // Do NOT call record_tracking_notification_outcome here: the RPC requires a matching
      // claim_token + status='dispatched', neither of which exist pre-claim.
      // The pending state is the correct durable representation — a later retry can
      // claim and dispatch successfully once the preflight issue is resolved.
      logger.warn('[TRACKING-NOTIF] Preflight failed, notification remains pending:', preflight.error);
      return 'preflight_failed';
    }

    const { phone, message, referenceCode, sender } = preflight.data;

    // ── Step 2: Claim the notification ──
    const { data: claimResult, error: claimError } = await service.rpc(
      'claim_tracking_notification',
      { p_notification_id: notificationId, p_business_id: businessId },
    );

    if (claimError || !(claimResult as { success: boolean })?.success) {
      logger.warn('[TRACKING-NOTIF] Claim failed:', claimError ?? claimResult);
      return 'failed';
    }

    const claimToken = (claimResult as { claim_token: string }).claim_token;

    // ── Step 3: Mark dispatched — THIS IS THE DURABLE DISPATCH BARRIER ──
    // After this point: at most ONE provider call, no retry, no fallback
    const { data: dispatchResult, error: dispatchError } = await service.rpc(
      'mark_tracking_notification_dispatched',
      { p_notification_id: notificationId, p_claim_token: claimToken },
    );

    if (dispatchError || !(dispatchResult as { success: boolean })?.success) {
      logger.warn('[TRACKING-NOTIF] Dispatch barrier failed:', dispatchError ?? dispatchResult);
      return 'failed';
    }

    // ── Step 4: Exactly ONE provider API call (no retry, no fallback) ──
    let outcome: 'sent' | 'failed' | 'indeterminate' = 'indeterminate';
    let providerMessageId: string | null = null;
    let errorMessage: string | null = null;

    try {
      // Attempt template send if available — with noRetry to prevent duplicate POSTs
      if (sender.sendTemplate) {
        const tmplResult = await sender.sendTemplate({
          to: phone,
          templateName: 'order_status_update',
          templateParams: [referenceCode, 'shipped'],
          noRetry: true,
        });
        if (tmplResult.success !== false) {
          outcome = 'sent';
          providerMessageId = tmplResult.messageId ?? null;
        } else {
          // Template returned definitive failure (no messageId, success=false)
          // Do NOT fall back to text — the template outcome is known
          outcome = 'failed';
          errorMessage = 'Template send returned failure';
        }
      } else {
        // No template support — single-attempt text send
        const textResult = await sender.sendText({
          to: phone,
          text: message,
          noRetry: true,
        });
        if (textResult.success !== false) {
          outcome = 'sent';
          providerMessageId = textResult.messageId ?? null;
        } else {
          outcome = 'failed';
          errorMessage = 'Text send returned failure';
        }
      }
    } catch (err) {
      // Post-dispatch unknown (network error, 5xx, timeout):
      // Record as indeterminate — NO automatic retry, NO text fallback
      outcome = 'indeterminate';
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('[TRACKING-NOTIF] Send error (post-dispatch, single attempt):', err);
    }

    // ── Step 5: Record outcome — persistence must succeed for truthful reporting ──
    const { error: outcomeError } = await service.rpc('record_tracking_notification_outcome', {
      p_notification_id: notificationId,
      p_claim_token: claimToken,
      p_outcome: outcome,
      p_provider_message_id: providerMessageId,
      p_error_message: errorMessage,
    });

    if (outcomeError) {
      // Outcome persistence failed — durable row remains dispatched/unknown.
      // Cannot truthfully report 'sent' or 'failed'; surface indeterminate.
      logger.error('[TRACKING-NOTIF] Outcome persistence failed, returning indeterminate:', outcomeError);
      return 'indeterminate';
    }

    return outcome;
  } catch (err) {
    logger.error('[TRACKING-NOTIF] Lifecycle error:', err);
    return 'failed';
  }
}
