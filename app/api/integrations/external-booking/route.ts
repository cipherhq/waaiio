import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { validateApiKey } from '@/lib/api-keys';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { handlePostCompletion } from '@/lib/bot/flows/shared/post-completion';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * POST /api/integrations/external-booking
 * Creates a booking from an external system via API key auth.
 * Sends WhatsApp confirmation and triggers post-completion hooks.
 */
export async function POST(request: NextRequest) {
  try {
    // Rate limit by IP
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'ext-booking'), 60, 60_000);
    if (rateLimit) return rateLimit;

    // API key auth
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing x-api-key header' }, { status: 401 });
    }

    const auth = await validateApiKey(apiKey);
    if (!auth) {
      return NextResponse.json({ error: 'Invalid or revoked API key' }, { status: 401 });
    }

    const supabase = createServiceClient();

    // Verify business is active and on a paid tier
    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, status, subscription_tier, country_code, address')
      .eq('id', auth.businessId)
      .single();

    if (!business || business.status !== 'active') {
      return NextResponse.json({ error: 'Business not found or inactive' }, { status: 404 });
    }

    if (!business.subscription_tier || business.subscription_tier === 'free') {
      return NextResponse.json({ error: 'API integrations require a paid plan' }, { status: 403 });
    }

    // Parse and validate body
    const body = await request.json();
    const errors: string[] = [];

    const customerName = typeof body.customer_name === 'string' ? body.customer_name.trim() : '';
    const customerPhone = typeof body.customer_phone === 'string' ? body.customer_phone.trim() : '';
    const date = typeof body.date === 'string' ? body.date.trim() : '';
    const time = typeof body.time === 'string' ? body.time.trim() : '';
    const serviceName = typeof body.service_name === 'string' ? body.service_name.trim() : '';
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 1000) : null;
    const externalRef = typeof body.reference === 'string' ? body.reference.trim().slice(0, 200) : null;

    if (!customerName) errors.push('customer_name is required');
    if (customerName.length > 200) errors.push('customer_name must be under 200 characters');
    if (!customerPhone) errors.push('customer_phone is required');
    if (customerPhone && !/^\+[1-9]\d{6,14}$/.test(customerPhone)) {
      errors.push('customer_phone must be E.164 format (e.g. +2348012345678)');
    }
    if (!date) errors.push('date is required');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('date must be YYYY-MM-DD format');
    if (!time) errors.push('time is required');
    if (time && !/^\d{1,2}:\d{2}$/.test(time)) errors.push('time must be HH:MM format');
    if (!serviceName) errors.push('service_name is required');

    if (errors.length > 0) {
      return NextResponse.json({ error: 'Validation failed', details: errors }, { status: 400 });
    }

    // Generate reference code
    const referenceCode = `${business.id.slice(0, 4).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

    // Insert booking
    const { data: booking, error: insertErr } = await supabase
      .from('bookings')
      .insert({
        business_id: business.id,
        guest_name: customerName,
        guest_phone: customerPhone,
        date,
        time: time.padStart(5, '0'), // ensure HH:MM
        reference_code: referenceCode,
        status: 'confirmed',
        flow_type: 'scheduling',
        channel: 'api',
        notes,
        party_size: body.party_size || 1,
        metadata: {
          source: 'external_api',
          external_reference: externalRef,
          api_key_id: auth.keyId,
        },
      })
      .select('id, reference_code')
      .single();

    if (insertErr || !booking) {
      logger.error('[EXT_BOOKING] Insert error:', insertErr);
      return NextResponse.json({ error: 'Failed to create booking' }, { status: 500 });
    }

    // Send WhatsApp confirmation (non-blocking to return fast)
    let whatsappSent = false;
    try {
      const resolver = new ChannelResolver(supabase);
      const resolved = await resolver.resolveByBusinessId(business.id);

      if (resolved) {
        const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
        const dateLabel = new Date(date + 'T00:00').toLocaleDateString('en-GB', {
          weekday: 'long', day: 'numeric', month: 'long',
        });

        await resolved.sender.sendText({
          to: phone,
          text: [
            `✅ *Booking Confirmed!*`,
            '',
            `🏢 ${business.name}`,
            `📋 ${serviceName}`,
            `📅 ${dateLabel}`,
            `🕐 ${time}`,
            `🔑 Ref: *${referenceCode}*`,
            '',
            'Thank you! 🙏',
          ].join('\n'),
        });
        whatsappSent = true;

        // Trigger post-completion hooks (loyalty, feedback, customer profile)
        handlePostCompletion({
          supabase,
          businessId: business.id,
          customerPhone,
          customerName,
          serviceType: 'booking',
          referenceId: booking.id,
          sender: resolved.sender,
        }).catch(err => logger.error('[EXT_BOOKING] Post-completion error:', err));
      }
    } catch (err) {
      logger.error('[EXT_BOOKING] WhatsApp notification error:', err);
    }

    return NextResponse.json({
      success: true,
      booking_id: booking.id,
      reference_code: booking.reference_code,
      status: 'confirmed',
      whatsapp_sent: whatsappSent,
    });
  } catch (error) {
    logger.error('[EXT_BOOKING] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
