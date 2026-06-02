import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'form-send'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { formId, businessId, phone } = await request.json();
    if (!formId || !businessId || !phone) {
      return NextResponse.json({ error: 'formId, businessId, and phone required' }, { status: 400 });
    }

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();
    if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Get form
    const serviceClient = createServiceClient();
    const { data: form } = await serviceClient
      .from('forms')
      .select('id, title, description, token, is_active')
      .eq('id', formId)
      .eq('business_id', businessId)
      .single();

    if (!form || !form.token) {
      return NextResponse.json({ error: 'Form not found' }, { status: 404 });
    }

    if (!form.is_active) {
      return NextResponse.json({ error: 'Form is inactive' }, { status: 400 });
    }

    // Create a pending response record to track the send
    await serviceClient.from('form_responses').insert({
      form_id: form.id,
      business_id: businessId,
      customer_phone: phone.startsWith('+') ? phone : `+${phone}`,
      status: 'sent',
      channel: 'whatsapp',
      answers: {},
    });

    // Send via WhatsApp
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
    const formUrl = `${appUrl}/form/${form.token}`;
    const toPhone = phone.startsWith('+') ? phone.slice(1) : phone;

    const resolver = new ChannelResolver(serviceClient);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (resolved) {
      await resolved.sender.sendText({
        to: toPhone,
        text: [
          `📋 *${form.title}*`,
          form.description ? `${form.description}` : null,
          '',
          `from *${biz.name}*`,
          '',
          `Please fill out this form:`,
          formUrl,
        ].filter(Boolean).join('\n'),
      });
    } else {
      return NextResponse.json({ error: 'No WhatsApp channel configured' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[FORMS] Send error:', error);
    return NextResponse.json({ error: 'Failed to send form' }, { status: 500 });
  }
}
