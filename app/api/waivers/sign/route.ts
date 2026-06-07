import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { logger } from '@/lib/logger';

/** Escape user-supplied strings for safe HTML interpolation */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function POST(request: NextRequest) {
  // Rate limit: 10/min per IP
  const rateLimit = rateLimitResponse(getRateLimitKey(request, 'waiver-sign'), 10, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const body = await request.json();
    const { token, first_name, last_name, customer_name: legacyName, customer_phone, customer_email, send_via, signature, metadata } = body;

    const customerName = legacyName || `${(first_name || '').trim()} ${(last_name || '').trim()}`.trim();
    if (!token || !customerName) {
      return NextResponse.json({ error: 'token and name are required' }, { status: 400 });
    }

    const sendVia: string = send_via || 'email';

    if (!signature) {
      return NextResponse.json({ error: 'Signature is required' }, { status: 400 });
    }

    if (signature.length > 500_000) {
      return NextResponse.json({ error: 'Signature data too large' }, { status: 400 });
    }

    if (customerName.length > 200) {
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
        customer_name: customerName,
        customer_phone: customer_phone || null,
        customer_email: customer_email || null,
        signature_url: signatureUrl,
        signed_at: new Date().toISOString(),
        metadata: { ...(metadata || {}), first_name: first_name || '', last_name: last_name || '', send_via: sendVia },
        audit_trail: auditTrail,
      })
      .select('id, access_token')
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

    // Send WhatsApp confirmation to customer (if phone provided and customer chose whatsapp/both)
    if (customer_phone && (sendVia === 'whatsapp' || sendVia === 'both')) {
      try {
        const cleanPhone = customer_phone.replace(/\D/g, '');
        const resolver = new ChannelResolver(supabase);
        const resolved =
          (await resolver.resolveByBusinessId(template.business_id)) ||
          (await resolver.getSharedChannelForCountry(biz?.country_code || 'NG'));

        if (resolved) {
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
          const viewUrl = `${appUrl}/w/view/${signed.id}?token=${signed.access_token}`;
          const confirmMsg = [
            `✅ *Waiver Signed*`,
            '',
            `Hi ${first_name || customerName}, you have signed the "${template.title}" waiver for *${biz?.name || 'the business'}*.`,
            '',
            `View your signed copy anytime:`,
            viewUrl,
            '',
            `📎 Ref: WAI-${signed.id.slice(0, 6).toUpperCase()}`,
          ].join('\n');
          await resolved.sender.sendText({ to: cleanPhone, text: confirmMsg });
        }
      } catch (msgErr) {
        logger.warn('Failed to send waiver WhatsApp confirmation:', msgErr);
      }
    }

    // Send email confirmation (if email provided and customer chose email/both)
    if (customer_email && (sendVia === 'email' || sendVia === 'both')) {
      try {
        const { sendEmail } = await import('@/lib/email/client');
        const { businessFrom } = await import('@/lib/email/templates');

        await sendEmail({
          to: customer_email,
          from: businessFrom(biz?.name || 'Business'),
          subject: `Waiver Signed - ${template.title}`,
          html: `<p>Hi ${esc(first_name || customerName)},</p><p>You have signed the <strong>"${esc(template.title)}"</strong> waiver for <strong>${esc(biz?.name || 'the business')}</strong>.</p><p><strong>Reference:</strong> WAI-${signed.id.slice(0, 6).toUpperCase()}</p><p><strong>Signed:</strong> ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p><p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/w/view/${signed.id}?token=${signed.access_token}" style="display:inline-block;background:#6C2BD9;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">View Signed Copy</a></p><p style="color:#999;font-size:12px">Powered by Waaiio</p>`,
        });
      } catch (emailErr) {
        logger.warn('Failed to send waiver email confirmation:', emailErr);
      }
    }

    // Notify business owner — WhatsApp
    if (biz?.phone) {
      try {
        const cleanPhone = biz.phone.replace(/\D/g, '');
        const resolver = new ChannelResolver(supabase);
        const resolved =
          (await resolver.resolveByBusinessId(template.business_id)) ||
          (await resolver.getSharedChannelForCountry(biz.country_code || 'NG'));

        if (resolved) {
          const ownerMsg = `📋 New waiver signed: *${customerName}* signed "${template.title}".`;
          await resolved.sender.sendText({ to: cleanPhone, text: ownerMsg });
        }
      } catch (ownerErr) {
        logger.warn('Failed to send waiver owner notification:', ownerErr);
      }
    }

    // Notify business owner — Email
    try {
      const { data: owner } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', (await supabase.from('businesses').select('owner_id').eq('id', template.business_id).single()).data?.owner_id || '')
        .single();

      if (owner?.email) {
        const { sendEmail: sendOwnerEmail } = await import('@/lib/email/client');
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
        const viewUrl = `${appUrl}/w/view/${signed.id}?token=${signed.access_token}`;
        const refCode = `WAI-${signed.id.slice(0, 6).toUpperCase()}`;

        await sendOwnerEmail({
          to: owner.email,
          subject: `New Waiver Signed — ${esc(customerName)} signed "${esc(template.title)}"`,
          html: `<p>A new waiver has been signed for <strong>${esc(biz?.name || 'your business')}</strong>.</p><p><strong>Customer:</strong> ${esc(customerName)}</p>${customer_phone ? `<p><strong>Phone:</strong> ${esc(customer_phone)}</p>` : ''}${customer_email ? `<p><strong>Email:</strong> ${esc(customer_email)}</p>` : ''}<p><strong>Waiver:</strong> ${esc(template.title)}</p><p><strong>Reference:</strong> ${refCode}</p><p><strong>Signed:</strong> ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p><p><a href="${viewUrl}" style="display:inline-block;background:#6C2BD9;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">View Signed Waiver</a></p><p style="color:#999;font-size:12px">Powered by Waaiio</p>`,
        });
      }
    } catch (ownerEmailErr) {
      logger.warn('Failed to send waiver owner email:', ownerEmailErr);
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
