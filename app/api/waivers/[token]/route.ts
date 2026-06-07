import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

// Public endpoint — fetch waiver template by token for signing
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    // Rate limit: 30 requests per minute per IP
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'waiver-get'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const { token } = await params;

    if (!token || token.length < 10) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data: template, error } = await supabase
      .from('waiver_templates')
      .select('id, title, body, fields, business_id, is_active, pdf_url')
      .eq('token', token)
      .single();

    if (error || !template) {
      return NextResponse.json({ error: 'Waiver not found' }, { status: 404 });
    }

    if (!template.is_active) {
      return NextResponse.json({ error: 'This waiver is no longer active' }, { status: 410 });
    }

    // Get business name and logo
    const { data: biz } = await supabase
      .from('businesses')
      .select('name, logo_url')
      .eq('id', template.business_id)
      .single();

    return NextResponse.json({
      id: template.id,
      title: template.title,
      body: template.body,
      fields: template.fields,
      pdf_url: template.pdf_url || null,
      business_name: biz?.name || 'Business',
      logo_url: biz?.logo_url || null,
    });
  } catch (err) {
    logger.error('Waiver token GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
