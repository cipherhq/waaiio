import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'form-submit'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const { token, answers, customer_name, customer_phone, customer_email } = await request.json();

    if (!token || !answers) {
      return NextResponse.json({ error: 'Token and answers required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Load form
    const { data: form } = await supabase
      .from('forms')
      .select('id, business_id, fields, is_active')
      .eq('token', token)
      .single();

    if (!form) {
      return NextResponse.json({ error: 'Form not found' }, { status: 404 });
    }

    if (!form.is_active) {
      return NextResponse.json({ error: 'This form is no longer accepting responses' }, { status: 410 });
    }

    // Validate required fields
    const fields = form.fields as Array<{ id: string; label: string; required: boolean }>;
    for (const field of fields) {
      if (field.required) {
        const val = answers[field.id];
        if (val === undefined || val === null || val === '') {
          return NextResponse.json({ error: `"${field.label}" is required` }, { status: 400 });
        }
      }
    }

    // Insert response
    const { error: insertError } = await supabase
      .from('form_responses')
      .insert({
        form_id: form.id,
        business_id: form.business_id,
        customer_name: customer_name || null,
        customer_phone: customer_phone || null,
        customer_email: customer_email || null,
        answers,
      });

    if (insertError) {
      logger.error('[FORMS] Insert error:', insertError);
      return NextResponse.json({ error: 'Failed to submit response' }, { status: 500 });
    }

    // Increment response count
    const { data: currentForm } = await supabase
      .from('forms')
      .select('response_count')
      .eq('id', form.id)
      .single();

    if (currentForm) {
      await supabase
        .from('forms')
        .update({ response_count: (currentForm.response_count || 0) + 1 })
        .eq('id', form.id);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[FORMS] Submit error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
