import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { generatePickupOtp, hashPickupToken } from '@/lib/promotions/crypto';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { stripPlus } from '@/lib/utils/phone';
import { MetaApiError } from '@/lib/channels/meta-api-error';

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

  // Read redemption phone + prize info server-side (never accept from browser)
  const { data: redemption } = await service
    .from('promo_redemptions')
    .select('phone_e164, promo_code_id')
    .eq('id', redemptionId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (!redemption) {
    return NextResponse.json({ error: 'Redemption not found' }, { status: 404 });
  }
  const authoritativePhone = redemption.phone_e164;

  // Fetch prize name via code -> prize_id chain
  let prizeName = 'Prize';
  if (redemption.promo_code_id) {
    const { data: codeRow } = await service
      .from('promo_campaign_codes')
      .select('prize_id')
      .eq('id', redemption.promo_code_id)
      .maybeSingle();
    if (codeRow?.prize_id) {
      const { data: prize } = await service
        .from('promo_prizes')
        .select('name')
        .eq('id', codeRow.prize_id)
        .maybeSingle();
      if (prize?.name) prizeName = prize.name;
    }
  }

  // Fetch business name for template personalization
  const { data: bizRecord } = await service
    .from('businesses')
    .select('name')
    .eq('id', businessId)
    .maybeSingle();
  const businessName = bizRecord?.name || 'Business';

  // Resolve channel + check template readiness BEFORE issuing verification
  // If readiness fails, no verification is created and no cooldown is consumed.
  const resolver = new ChannelResolver(service);
  const resolved = await resolver.resolveByBusinessId(businessId);

  if (!resolved?.sender || !resolved.sender.sendTemplate) {
    logger.error('[PROMO-PICKUP] No template-capable WhatsApp channel for business', businessId);
    return NextResponse.json({ error: 'WhatsApp template delivery unavailable for this business' }, { status: 503 });
  }

  if (!resolved.cloud) {
    return NextResponse.json({ error: 'Template management not available on this channel' }, { status: 503 });
  }

  const templates = await resolved.cloud.getTemplates();
  const v2Template = (templates.data || []).find(
    (t: { name: string; language: string; status?: string }) => t.name === 'promo_pickup_verification_v2' && t.language === 'en_US'
  );

  if (!v2Template || v2Template.status !== 'APPROVED') {
    return NextResponse.json({
      error: 'template_not_ready',
      detail: `promo_pickup_verification_v2 is ${v2Template?.status || 'missing'} on this WABA`,
    }, { status: 503 });
  }

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

  // Send via WhatsApp using the SAME resolved channel from the readiness check above.
  // No sendText fallback: if template is not provisioned, delivery fails safely.
  let deliveryStatus: 'sent' | 'failed' = 'failed';
  let messageId: string | undefined;

  try {
    const phone = stripPlus(authoritativePhone);
    // noRetry: delivery-critical promo send — ambiguous outcomes must not produce duplicate provider POSTs
    const result = await resolved.sender.sendTemplate({
      to: phone,
      templateName: 'promo_pickup_verification_v2',
      templateParams: [businessName, prizeName, otp, String(OTP_EXPIRY_MINUTES)],
      noRetry: true,
    });
    messageId = result?.messageId;
    deliveryStatus = 'sent';
  } catch (err) {
    // Classify: 4xx MetaApiError = definite rejection, everything else = ambiguous
    const isDefiniteRejection = err instanceof MetaApiError && err.httpStatus >= 400 && err.httpStatus < 500;
    if (isDefiniteRejection) {
      logger.error('[PROMO-PICKUP] WhatsApp template rejected (4xx):', err);
      deliveryStatus = 'failed';
    } else {
      // Ambiguous: network/timeout/5xx — Meta may have accepted the message
      // Leave verification as pending (non-verifiable but cooldown-protected)
      logger.error('[PROMO-PICKUP] Ambiguous provider error — not finalizing as failed:', err);
      return NextResponse.json({ error: 'Verification code delivery uncertain. Please wait and try again.' }, { status: 502 });
    }
  }

  if (deliveryStatus === 'failed') {
    // Definite 4xx rejection — finalize as failed + invalidate
    await service.rpc('finalize_promo_pickup_delivery', {
      p_verification_id: verificationId, p_status: 'failed', p_provider_message_id: null,
    });
    return NextResponse.json({ error: 'Failed to send verification code. Please try again.' }, { status: 503 });
  }

  if (!messageId) {
    // sendTemplate resolved but no WAMID — ambiguous outcome, leave pending
    return NextResponse.json({ error: 'Send succeeded but no provider message ID received' }, { status: 502 });
  }

  // Finalize delivery state atomically with WAMID
  const { data: finResult, error: finError } = await service.rpc('finalize_promo_pickup_delivery', {
    p_verification_id: verificationId,
    p_status: 'sent',
    p_provider_message_id: messageId,
  });
  if (finError || !finResult?.success) {
    logger.error('[PROMO-PICKUP] delivery finalization failed:', finError || finResult?.reason);
    return NextResponse.json({ error: 'Verification code delivery could not be confirmed. Please try again.' }, { status: 503 });
  }

  return NextResponse.json({ sent: true, expires_in_minutes: OTP_EXPIRY_MINUTES });
}
