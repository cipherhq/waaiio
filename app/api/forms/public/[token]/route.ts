import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const rateLimit = await rateLimitResponseAsync(getRateLimitKey(req, 'form-public'), 30, 60_000);
  if (rateLimit) return rateLimit;

  const { token } = await params;
  const supabase = createServiceClient();

  const { data: form } = await supabase
    .from('forms')
    .select('id, title, description, fields, is_active, business_id')
    .eq('token', token)
    .single();

  if (!form) {
    return NextResponse.json({ error: 'Form not found' }, { status: 404 });
  }

  if (!form.is_active) {
    return NextResponse.json({ error: 'This form is no longer accepting responses' }, { status: 410 });
  }

  // Get business name + logo
  const { data: biz } = await supabase
    .from('businesses')
    .select('name, phone, logo_url, assigned_channel_id, whatsapp_channel_id')
    .eq('id', form.business_id)
    .single();

  // Resolve WhatsApp channel phone (not business owner's personal phone)
  let whatsappPhone: string | null = null;
  const channelId = biz?.assigned_channel_id || biz?.whatsapp_channel_id;
  if (channelId) {
    const { data: ch } = await supabase.from('whatsapp_channels').select('phone_number').eq('id', channelId).eq('is_active', true).maybeSingle();
    if (ch?.phone_number) whatsappPhone = ch.phone_number;
  }
  if (!whatsappPhone) {
    const { data: dedicated } = await supabase.from('whatsapp_channels').select('phone_number')
      .eq('business_id', form.business_id).eq('channel_type', 'dedicated').eq('is_active', true).maybeSingle();
    if (dedicated?.phone_number) whatsappPhone = dedicated.phone_number;
  }
  if (!whatsappPhone) {
    const { data: shared } = await supabase.from('whatsapp_channels').select('phone_number')
      .eq('channel_type', 'shared').eq('is_active', true).limit(1).maybeSingle();
    if (shared?.phone_number) whatsappPhone = shared.phone_number;
  }

  return NextResponse.json({
    title: form.title,
    description: form.description,
    fields: form.fields,
    business_name: biz?.name || '',
    business_phone: whatsappPhone || biz?.phone || null,
    business_logo: biz?.logo_url || null,
  });
}
