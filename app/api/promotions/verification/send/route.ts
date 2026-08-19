import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { generatePickupOtp, hashPickupToken } from '@/lib/promotions/crypto';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { stripPlus } from '@/lib/utils/phone';

const OTP_EXPIRY_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_SENDS_PER_WINDOW = 5;
const SEND_WINDOW_MINUTES = 10;

/**
 * POST /api/promotions/verification/send
 *
 * Issue a secure pickup verification OTP to the winning WhatsApp number.
 * Does NOT accept a destination phone — derived from the redemption record.
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

  // Fetch redemption — phone is server-authoritative
  const { data: redemption, error: fetchErr } = await service
    .from('promo_redemptions')
    .select('id, business_id, phone_e164, outcome, verification_mode, verification_status, fulfillment_status')
    .eq('id', redemptionId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (fetchErr || !redemption) {
    return NextResponse.json({ error: 'Redemption not found' }, { status: 404 });
  }
  if (redemption.outcome !== 'winner') {
    return NextResponse.json({ error: 'Only winner redemptions require verification' }, { status: 422 });
  }
  if (redemption.verification_mode !== 'secure_pickup') {
    return NextResponse.json({ error: 'This redemption uses standard verification' }, { status: 422 });
  }
  if (redemption.verification_status === 'verified') {
    return NextResponse.json({ error: 'Already verified', already_verified: true }, { status: 200 });
  }
  if (['fulfilled', 'rejected', 'cancelled'].includes(redemption.fulfillment_status)) {
    return NextResponse.json({ error: 'Redemption is in terminal fulfillment state' }, { status: 422 });
  }

  const phone = redemption.phone_e164;

  // Check existing verification — resend cooldown + window limits
  const { data: existing } = await service
    .from('promo_pickup_verifications')
    .select('*')
    .eq('redemption_id', redemptionId)
    .is('used_at', null)
    .maybeSingle();

  if (existing) {
    // Resend cooldown
    const lastSent = new Date(existing.last_sent_at);
    const cooldownEnd = new Date(lastSent.getTime() + RESEND_COOLDOWN_SECONDS * 1000);
    if (new Date() < cooldownEnd) {
      const remaining = Math.ceil((cooldownEnd.getTime() - Date.now()) / 1000);
      return NextResponse.json({ error: `Please wait ${remaining} seconds before requesting a new code` }, { status: 429 });
    }

    // Send window limit
    const windowStart = new Date(existing.send_window_start);
    const windowEnd = new Date(windowStart.getTime() + SEND_WINDOW_MINUTES * 60 * 1000);
    if (new Date() < windowEnd && existing.send_count >= MAX_SENDS_PER_WINDOW) {
      return NextResponse.json({ error: 'Too many verification codes sent. Please try again later.' }, { status: 429 });
    }

    // Reset window if expired
    const resetWindow = new Date() >= windowEnd;

    // Invalidate old token by marking used
    await service.from('promo_pickup_verifications')
      .update({ used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', existing.id);

    // Create new verification with incremented send count
    const otp = generatePickupOtp();
    const tokenHmac = hashPickupToken(businessId, redemptionId, phone, otp);

    await service.from('promo_pickup_verifications').insert({
      business_id: businessId,
      redemption_id: redemptionId,
      phone_e164: phone,
      token_hmac: tokenHmac,
      expires_at: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString(),
      send_count: resetWindow ? 1 : existing.send_count + 1,
      send_window_start: resetWindow ? new Date().toISOString() : existing.send_window_start,
      last_sent_at: new Date().toISOString(),
    });

    // Send via WhatsApp — OTP only in memory, never in API response
    try {
      const resolver = new ChannelResolver(service);
      const resolved = await resolver.resolveByBusinessId(businessId);
      if (resolved?.sender) {
        await resolved.sender.sendText({
          to: stripPlus(phone),
          text: `Your pickup verification code is: *${otp}*\n\nIt expires in ${OTP_EXPIRY_MINUTES} minutes.\nOnly share this code with staff when collecting your prize.`,
        });
      } else {
        logger.error('[PROMO-PICKUP] No WhatsApp channel for business', businessId);
        return NextResponse.json({ error: 'WhatsApp delivery unavailable for this business' }, { status: 503 });
      }
    } catch (err) {
      logger.error('[PROMO-PICKUP] WhatsApp delivery failed:', err);
      return NextResponse.json({ error: 'Failed to send verification code. Please try again.' }, { status: 503 });
    }

    return NextResponse.json({ sent: true, expires_in_minutes: OTP_EXPIRY_MINUTES });
  }

  // No existing verification — create first one
  const otp = generatePickupOtp();
  const tokenHmac = hashPickupToken(businessId, redemptionId, phone, otp);

  await service.from('promo_pickup_verifications').insert({
    business_id: businessId,
    redemption_id: redemptionId,
    phone_e164: phone,
    token_hmac: tokenHmac,
    expires_at: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString(),
  });

  // Send via WhatsApp
  try {
    const resolver = new ChannelResolver(service);
    const resolved = await resolver.resolveByBusinessId(businessId);
    if (resolved?.sender) {
      await resolved.sender.sendText({
        to: stripPlus(phone),
        text: `Your pickup verification code is: *${otp}*\n\nIt expires in ${OTP_EXPIRY_MINUTES} minutes.\nOnly share this code with staff when collecting your prize.`,
      });
    } else {
      logger.error('[PROMO-PICKUP] No WhatsApp channel for business', businessId);
      return NextResponse.json({ error: 'WhatsApp delivery unavailable for this business' }, { status: 503 });
    }
  } catch (err) {
    logger.error('[PROMO-PICKUP] WhatsApp delivery failed:', err);
    return NextResponse.json({ error: 'Failed to send verification code. Please try again.' }, { status: 503 });
  }

  return NextResponse.json({ sent: true, expires_in_minutes: OTP_EXPIRY_MINUTES });
}
