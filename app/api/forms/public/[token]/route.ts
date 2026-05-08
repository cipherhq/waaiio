import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const rateLimit = rateLimitResponse(getRateLimitKey(req, 'form-public'), 30, 60_000);
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
    .select('name, phone, logo_url')
    .eq('id', form.business_id)
    .single();

  return NextResponse.json({
    title: form.title,
    description: form.description,
    fields: form.fields,
    business_name: biz?.name || '',
    business_phone: biz?.phone || null,
    business_logo: biz?.logo_url || null,
  });
}
