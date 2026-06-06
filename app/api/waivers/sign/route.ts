import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  // Rate limit: 10/min per IP
  const rateLimit = rateLimitResponse(getRateLimitKey(request, 'waiver-sign'), 10, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const body = await request.json();
    const { token, customer_name, customer_phone, customer_email, signature, metadata } = body;

    if (!token || !customer_name) {
      return NextResponse.json({ error: 'token and customer_name are required' }, { status: 400 });
    }

    if (!signature) {
      return NextResponse.json({ error: 'Signature is required' }, { status: 400 });
    }

    if (signature.length > 500_000) {
      return NextResponse.json({ error: 'Signature data too large' }, { status: 400 });
    }

    if (customer_name.length > 200) {
      return NextResponse.json({ error: 'Name too long' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Fetch template by token
    const { data: template, error: tplErr } = await supabase
      .from('waiver_templates')
      .select('id, business_id, title, is_active')
      .eq('token', token)
      .single();

    if (tplErr || !template) {
      return NextResponse.json({ error: 'Waiver not found' }, { status: 404 });
    }

    if (!template.is_active) {
      return NextResponse.json({ error: 'This waiver is no longer active' }, { status: 410 });
    }

    // Upload signature to storage
    const signatureBuffer = Buffer.from(
      signature.replace(/^data:image\/\w+;base64,/, ''),
      'base64'
    );
    const sigPath = `waivers/${template.business_id}/${template.id}/${Date.now()}.png`;

    const { error: uploadErr } = await supabase.storage
      .from('contracts')
      .upload(sigPath, signatureBuffer, {
        contentType: 'image/png',
        upsert: false,
      });

    if (uploadErr) {
      logger.error('Failed to upload waiver signature:', uploadErr);
    }

    const signatureUrl = uploadErr ? null : sigPath;

    // Capture audit trail
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || request.headers.get('x-real-ip')
      || 'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';
    const deviceType = /mobile|android|iphone|ipad/i.test(userAgent) ? 'mobile' : 'desktop';

    const auditTrail = {
      ip,
      user_agent: userAgent,
      device_type: deviceType,
      signed_at: new Date().toISOString(),
    };

    // Insert signed waiver
    const { data: signed, error: insertErr } = await supabase
      .from('signed_waivers')
      .insert({
        template_id: template.id,
        business_id: template.business_id,
        customer_name,
        customer_phone: customer_phone || null,
        customer_email: customer_email || null,
        signature_url: signatureUrl,
        signed_at: new Date().toISOString(),
        metadata: metadata || {},
        audit_trail: auditTrail,
      })
      .select('id')
      .single();

    if (insertErr || !signed) {
      logger.error('Failed to insert signed waiver:', insertErr);
      return NextResponse.json({ error: 'Failed to save waiver' }, { status: 500 });
    }

    // Get business info for notifications
    const { data: biz } = await supabase
      .from('businesses')
      .select('name, country_code, phone')
      .eq('id', template.business_id)
      .single();

    // Send WhatsApp confirmation to customer (if phone provided)
    if (customer_phone) {
      try {
        const cleanPhone = customer_phone.replace(/\D/g, '');
        const resolver = new ChannelResolver(supabase);
        const resolved =
          (await resolver.resolveByBusinessId(template.business_id)) ||
          (await resolver.getSharedChannelForCountry(biz?.country_code || 'NG'));

        if (resolved) {
          const confirmMsg = [
            `Waiver Signed`,
            '',
            `Hi ${customer_name}, you have signed the "${template.title}" waiver from ${biz?.name || 'the business'}.`,
            '',
            `This confirmation serves as your record.`,
          ].join('\n');
          await resolved.sender.sendText({ to: cleanPhone, text: confirmMsg });
        }
      } catch (msgErr) {
        logger.warn('Failed to send waiver WhatsApp confirmation:', msgErr);
      }
    }

    // Send email confirmation (if email provided)
    if (customer_email) {
      try {
        const { sendEmail } = await import('@/lib/email/client');
        const { businessFrom } = await import('@/lib/email/templates');

        await sendEmail({
          to: customer_email,
          from: businessFrom(biz?.name || 'Business'),
          subject: `Waiver Signed - ${template.title}`,
          html: `<p>Hi ${customer_name},</p><p>You have signed the "${template.title}" waiver from ${biz?.name || 'the business'}.</p><p>This email serves as your confirmation.</p><p style="color:#999;font-size:12px">Powered by Waaiio</p>`,
        });
      } catch (emailErr) {
        logger.warn('Failed to send waiver email confirmation:', emailErr);
      }
    }

    // Notify business owner
    if (biz?.phone) {
      try {
        const cleanPhone = biz.phone.replace(/\D/g, '');
        const resolver = new ChannelResolver(supabase);
        const resolved =
          (await resolver.resolveByBusinessId(template.business_id)) ||
          (await resolver.getSharedChannelForCountry(biz.country_code || 'NG'));

        if (resolved) {
          const ownerMsg = `New waiver signed: ${customer_name} signed "${template.title}".`;
          await resolved.sender.sendText({ to: cleanPhone, text: ownerMsg });
        }
      } catch (ownerErr) {
        logger.warn('Failed to send waiver owner notification:', ownerErr);
      }
    }

    return NextResponse.json({
      success: true,
      waiver_id: signed.id,
    });
  } catch (err) {
    logger.error('Waiver sign error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
