import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { generatePickupOtp, hashPickupToken } from '@/lib/promotions/crypto';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { stripPlus } from '@/lib/utils/phone';

const OTP_EXPIRY_MINUTES = 10;

/**
 * POST /api/promotions/verification/send
 *
 * Issue a secure pickup verification OTP to the winning WhatsApp number.
 * Uses atomic issue_promo_pickup RPC for concurrency safety.
 * Does NOT accept a destination phone — derived from the redemption record.
 * Raw OTP never returned in API response, never logged, never stored.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const service = createServiceClient();
  const { businessId, redemptionId } = body as { businessId?: string; redemptionId?: string };

  if (!businessId) return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
  if (!redemptionId) return NextResponse.json({ error: 'redemptionId is required' }, { status: 400 });

  const guard = await requireCapability(supabase, service, {
    businessId, userId: user.id, capability: 'promo_verification', action: 'manage_existing',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  // Read redemption phone server-side (never accept from browser)
  const { data: redemption } = await service
    .from('promo_redemptions')
    .select('phone_e164')
    .eq('id', redemptionId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (!redemption) {
    return NextResponse.json({ error: 'Redemption not found' }, { status: 404 });
  }
  const authoritativePhone = redemption.phone_e164;

  // Generate OTP in memory — never persisted as plaintext
  const otp = generatePickupOtp();
  const tokenHmac = hashPickupToken(businessId, redemptionId, authoritativePhone, otp);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  // Atomic issue — handles locking, cooldown, window limits, lock recovery
  const { data: issueResult, error: issueError } = await service.rpc('issue_promo_pickup', {
    p_business_id: businessId,
    p_redemption_id: redemptionId,
    p_token_hmac: tokenHmac,
    p_expires_at: expiresAt,
  });

  if (issueError) {
    logger.error('[PROMO-PICKUP] issue RPC error:', issueError);
    return NextResponse.json({ error: 'Failed to issue verification code' }, { status: 500 });
  }

  if (!issueResult?.success) {
    const reason = issueResult?.reason || 'unknown';
    if (reason === 'cooldown') {
      return NextResponse.json({ error: `Please wait ${issueResult.retry_after_seconds} seconds before requesting a new code` }, { status: 429 });
    }
    if (reason === 'send_window_exhausted') {
      return NextResponse.json({ error: 'Too many verification codes sent. Please try again later.' }, { status: 429 });
    }
    if (reason === 'already_verified') {
      return NextResponse.json({ verified: true, already_verified: true });
    }
    return NextResponse.json({ error: `Cannot issue verification code: ${reason}` }, { status: 422 });
  }

  const verificationId = issueResult.verification_id as string;

  // Send via WhatsApp — prefer template for proactive delivery
  let deliveryStatus: 'sent' | 'failed' = 'failed';
  let messageId: string | undefined;

  try {
    const resolver = new ChannelResolver(service);
    const resolved = await resolver.resolveByBusinessId(businessId);
    if (!resolved?.sender) {
      logger.error('[PROMO-PICKUP] No WhatsApp channel for business', businessId);
      // Mark delivery failed
      await service.rpc('finalize_promo_pickup_delivery', {
        p_verification_id: verificationId, p_status: 'failed',
      });
      return NextResponse.json({ error: 'WhatsApp delivery unavailable for this business' }, { status: 503 });
    }

    // Try template first (works outside 24h window), fall back to sendText
    const phone = stripPlus(authoritativePhone);
    const text = `Your pickup verification code is: *${otp}*\n\nIt expires in ${OTP_EXPIRY_MINUTES} minutes.\nOnly share this code with staff when collecting your prize.`;

    if (resolved.sender.sendTemplate) {
      try {
        const result = await resolved.sender.sendTemplate({
          to: phone,
          templateName: 'promo_pickup_verification',
          templateParams: ['Prize', otp, String(OTP_EXPIRY_MINUTES)],
        });
        messageId = result?.messageId;
        deliveryStatus = 'sent';
      } catch {
        // Template not provisioned — fall back to sendText
        const result = await resolved.sender.sendText({ to: phone, text });
        messageId = result?.messageId;
        deliveryStatus = 'sent';
      }
    } else {
      const result = await resolved.sender.sendText({ to: phone, text });
      messageId = result?.messageId;
      deliveryStatus = 'sent';
    }
  } catch (err) {
    logger.error('[PROMO-PICKUP] WhatsApp delivery failed:', err);
    deliveryStatus = 'failed';
  }

  // Finalize delivery state atomically
  await service.rpc('finalize_promo_pickup_delivery', {
    p_verification_id: verificationId,
    p_status: deliveryStatus,
    p_provider_message_id: messageId || null,
  });

  if (deliveryStatus === 'failed') {
    return NextResponse.json({ error: 'Failed to send verification code. Please try again.' }, { status: 503 });
  }

  return NextResponse.json({ sent: true, expires_in_minutes: OTP_EXPIRY_MINUTES });
}
