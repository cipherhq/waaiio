import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'form-submit'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const { token, answers, customer_name, customer_phone, customer_email } = await request.json();

    if (!token || !answers || typeof answers !== 'object') {
      return NextResponse.json({ error: 'Token and answers required' }, { status: 400 });
    }

    // Validate input lengths and formats
    if (customer_email && (typeof customer_email !== 'string' || customer_email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email))) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }
    if (customer_phone && (typeof customer_phone !== 'string' || customer_phone.length > 20 || !/^[+\d\s()-]+$/.test(customer_phone))) {
      return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 });
    }
    if (customer_name && (typeof customer_name !== 'string' || customer_name.length > 200)) {
      return NextResponse.json({ error: 'Name is too long (max 200 characters)' }, { status: 400 });
    }

    // Validate individual answer lengths
    for (const [key, value] of Object.entries(answers)) {
      if (typeof value === 'string' && value.length > 5000) {
        return NextResponse.json({ error: `Answer for "${key}" is too long (max 5000 characters)` }, { status: 400 });
      }
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

    // Check if there's a pending "sent" record for this phone + form (update instead of insert)
    let insertError: { message: string; code?: string } | null = null;
    const normalizedPhone = customer_phone?.startsWith('+') ? customer_phone : customer_phone ? `+${customer_phone}` : null;

    if (normalizedPhone) {
      const { data: existing } = await supabase
        .from('form_responses')
        .select('id')
        .eq('form_id', form.id)
        .eq('customer_phone', normalizedPhone)
        .eq('status', 'sent')
        .maybeSingle();

      if (existing) {
        // Update the existing sent record
        const { error } = await supabase
          .from('form_responses')
          .update({
            customer_name: customer_name || null,
            customer_email: customer_email || null,
            answers,
            status: 'submitted',
            submitted_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
        insertError = error;
      } else {
        const { error } = await supabase
          .from('form_responses')
          .insert({
            form_id: form.id,
            business_id: form.business_id,
            customer_name: customer_name || null,
            customer_phone: normalizedPhone,
            customer_email: customer_email || null,
            answers,
            status: 'submitted',
            channel: 'web',
          });
        insertError = error;
      }
    } else {
      const { error } = await supabase
        .from('form_responses')
        .insert({
          form_id: form.id,
          business_id: form.business_id,
          customer_name: customer_name || null,
          customer_phone: null,
          customer_email: customer_email || null,
          answers,
          status: 'submitted',
          channel: 'web',
        });
      insertError = error;
    }

    if (insertError) {
      logger.error('[FORMS] Insert error:', insertError);
      return NextResponse.json({ error: 'Failed to submit response' }, { status: 500 });
    }

    // Atomic increment — prevents race condition with concurrent submissions
    await supabase.rpc('increment_form_response_count', { p_form_id: form.id });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[FORMS] Submit error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
