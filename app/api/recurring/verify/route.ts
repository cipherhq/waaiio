import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'recurring-verify'), 5, 60_000);
    if (rateLimit) return rateLimit;

    const { phone, otp, action } = await request.json();

    if (!phone) {
      return NextResponse.json({ error: 'Phone number required' }, { status: 400 });
    }

    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;
    const supabase = createServiceClient();

    if (action === 'request') {
      // Generate 6-digit OTP using crypto-safe random
      const { randomInt } = await import('crypto');
      const code = String(randomInt(100000, 999999));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

      // Store OTP in DB (upsert by phone key)
      await supabase
        .from('platform_settings')
        .upsert(
          { key: `recurring-otp:${normalizedPhone}`, value: { code, expires_at: expiresAt }, description: 'Recurring verify OTP' },
          { onConflict: 'key' },
        );

      // Send via WhatsApp
      const whatsappToken = process.env.WHATSAPP_TOKEN;
      const whatsappPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

      if (whatsappToken && whatsappPhoneId) {
        await fetch(`https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v22.0'}/${whatsappPhoneId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${whatsappToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: normalizedPhone.replace('+', ''),
            type: 'text',
            text: { body: `Your verification code is: ${code}\n\nThis code expires in 10 minutes.` },
          }),
        });
      } else {
        logger.debug(`[mock OTP] ${normalizedPhone}: ${code}`);
      }

      return NextResponse.json({ success: true });
    }

    if (action === 'verify') {
      // Fetch OTP from DB
      const { data } = await supabase
        .from('platform_settings')
        .select('value')
        .eq('key', `recurring-otp:${normalizedPhone}`)
        .maybeSingle();

      if (!data?.value) {
        return NextResponse.json({ error: 'Code expired. Please request a new one.' }, { status: 400 });
      }

      const stored = data.value as { code: string; expires_at: string };

      if (new Date() > new Date(stored.expires_at)) {
        // Cleanup expired
        await supabase.from('platform_settings').delete().eq('key', `recurring-otp:${normalizedPhone}`);
        return NextResponse.json({ error: 'Code expired. Please request a new one.' }, { status: 400 });
      }

      const { timingSafeEqual } = await import('crypto');
      const otpStr = String(otp).trim();
      if (otpStr.length !== stored.code.length || !timingSafeEqual(Buffer.from(stored.code), Buffer.from(otpStr))) {
        return NextResponse.json({ error: 'Invalid verification code.' }, { status: 400 });
      }

      // Verified — delete from DB
      await supabase.from('platform_settings').delete().eq('key', `recurring-otp:${normalizedPhone}`);

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
