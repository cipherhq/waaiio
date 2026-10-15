import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { generateOtpChallenge, verifyOtpChallenge } from '@/lib/otp-challenge';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'recurring-verify'), 5, 60_000);
    if (rateLimit) return rateLimit;

    const { phone, otp, action, challengeId } = await request.json();

    if (!phone) {
      return NextResponse.json({ error: 'Phone number required' }, { status: 400 });
    }

    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;
    const supabase = createServiceClient();

    if (action === 'request') {
      // Generate challenge — hashed storage, atomic consume, failed-attempt tracking
      const { code, challengeId } = await generateOtpChallenge('recurring', normalizedPhone);

      // Send via WhatsApp
      const whatsappToken = process.env.WHATSAPP_TOKEN;
      const whatsappPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

      if (whatsappToken && whatsappPhoneId) {
        // #257: unified direct-route attempt recording
        const { withDirectRouteAttempt } = await import('@/lib/channels/direct-route-attempt');
        await withDirectRouteAttempt(supabase, {
          businessId: null, attemptScope: 'platform', recipientPhone: normalizedPhone,
          flowType: 'recurring-verify-otp',
        }, () => fetch(`https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v22.0'}/${whatsappPhoneId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${whatsappToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: normalizedPhone.replace('+', ''),
            type: 'text',
            text: { body: `Your verification code is: ${code}\n\nThis code expires in 5 minutes.` },
          }),
        }));
      } else {
        logger.debug(`[mock OTP] ${normalizedPhone}: ${code}`);
      }

      return NextResponse.json({ success: true, challengeId });
    }

    if (action === 'verify') {
      if (!otp || !challengeId) {
        return NextResponse.json({ error: 'Code and challengeId required' }, { status: 400 });
      }

      // Verify via challenge table — hashed comparison, atomic consume, failed-attempt tracking
      const otpStr = String(otp).trim();
      const result = await verifyOtpChallenge('recurring', normalizedPhone, otpStr, challengeId);

      if (!result.valid) {
        const errorMap: Record<string, string> = {
          invalid_challenge: 'Code expired. Please request a new one.',
          expired: 'Code expired. Please request a new one.',
          consumed: 'Code already used. Please request a new one.',
          wrong_identifier: 'Invalid verification code.',
          wrong_otp: 'Invalid verification code.',
          max_attempts: 'Too many failed attempts. Please request a new code.',
          concurrent: 'Verification failed. Please try again.',
        };
        return NextResponse.json(
          { error: errorMap[result.reason || ''] || 'Invalid verification code.' },
          { status: 400 },
        );
      }

      // Fetch all subscriptions for this phone
      const { data: subs } = await supabase
        .from('customer_subscriptions')
        .select(`
          id, amount, currency, frequency, status, card_last_four, card_brand,
          next_charge_at, last_charged_at, charge_count, total_charged,
          service_id, business_id
        `)
        .eq('customer_phone', normalizedPhone)
        .in('status', ['active', 'paused', 'past_due'])
        .order('created_at', { ascending: false });

      if (!subs || subs.length === 0) {
        return NextResponse.json({ subscriptions: [] });
      }

      // Enrich with business and service names
      const bizIds = [...new Set(subs.map(s => s.business_id))];
      const svcIds = [...new Set(subs.map(s => s.service_id).filter(Boolean))];

      const { data: businesses } = await supabase.from('businesses').select('id, name').in('id', bizIds);
      const { data: services } = svcIds.length > 0
        ? await supabase.from('services').select('id, name').in('id', svcIds)
        : { data: [] };

      const bizMap = new Map((businesses || []).map(b => [b.id, b.name]));
      const svcMap = new Map((services || []).map(s => [s.id, s.name]));

      const enriched = subs.map(s => ({
        ...s,
        business_name: bizMap.get(s.business_id) || 'Unknown',
        service_name: svcMap.get(s.service_id) || 'Payment',
      }));

      return NextResponse.json({ subscriptions: enriched });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    logger.error('Recurring verify error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
