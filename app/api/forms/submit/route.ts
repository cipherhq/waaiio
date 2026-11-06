import { NextResponse, after, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { normalizeEngagePhone } from '@/lib/engage/phone-normalize';
import { OPTIN_POLICY_VERSION, newOptInNonce, pendingEvidence, sendOptInConfirmationRequest } from '@/lib/consent/optin-confirmation';

/**
 * Append a 'pending' WhatsApp marketing consent row for a ticked web opt-in. Never
 * written over a newer 'granted' record: an unverified web tick must not be able
 * to replace (and so withdraw) a real permission. Never blocks the saved response.
 * A NEW row carries sha256 of a one-time nonce; the nonce itself goes only to the
 * typed number (WhatsApp confirmation, #591 part B1) and is never stored.
 */
async function recordPendingOptIn(
  db: ReturnType<typeof createServiceClient>, businessId: string, formId: string, e164: string,
): Promise<{ pending: boolean; request: { id: string; nonce: string } | null }> {
  try {
    const digits = e164.replace(/\D/g, '');
    const { data: latest, error } = await db.from('customer_consents').select('status')
      .eq('business_id', businessId).in('phone', [digits, `+${digits}`])
      .eq('channel', 'whatsapp').eq('purpose', 'marketing')
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(1).maybeSingle();
    if (error) return { pending: false, request: null };
    if (latest?.status === 'granted' || latest?.status === 'pending') return { pending: true, request: null };
    const nonce = newOptInNonce();
    const { data: inserted, error: insertError } = await db.from('customer_consents').insert({
      business_id: businessId, phone: e164, channel: 'whatsapp', purpose: 'marketing',
      status: 'pending', source: 'website', evidence_reference: pendingEvidence(formId, nonce),
      policy_version: OPTIN_POLICY_VERSION,
    }).select('id').single();
    if (insertError || !inserted?.id) {
      logger.warn('[FORMS] Opt-in not recorded:', insertError?.message);
      return { pending: false, request: null };
    }
    return { pending: true, request: { id: inserted.id as string, nonce } };
  } catch { return { pending: false, request: null }; }
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'form-submit'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const { token, answers, customer_name, customer_phone, customer_email, marketing_opt_in } = await request.json();

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
      .select('id, business_id, fields, is_active, settings')
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

    // Optional "Yes, send me updates" box (#591). Only offered when the merchant turned it
    // on, unticked by default, and only for a valid phone. Nobody has proved they own the
    // typed number, so the tick is recorded as *pending*, which is never sendable
    // (hasRecipientPermission needs 'granted') until confirmed on WhatsApp (Owner Q2).
    const offersOptIn = (form.settings as Record<string, unknown> | null)?.marketing_opt_in === true;
    const optIn = offersOptIn && marketing_opt_in === true;
    let optInPhone: string | null = null;
    if (optIn) {
      const { data: biz } = await supabase.from('businesses').select('country_code').eq('id', form.business_id).maybeSingle();
      optInPhone = typeof customer_phone === 'string' ? normalizeEngagePhone(customer_phone, biz?.country_code || 'NG') : null;
      if (!optInPhone) {
        return NextResponse.json({ error: 'Enter a valid WhatsApp number to get updates' }, { status: 400 });
      }
    }
    const consentColumn = offersOptIn ? { consent_given: optIn } : {};

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
            ...consentColumn,
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
            ...consentColumn,
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
          ...consentColumn,
        });
      insertError = error;
    }

    if (insertError) {
      logger.error('[FORMS] Insert error:', insertError);
      return NextResponse.json({ error: 'Failed to submit response' }, { status: 500 });
    }

    let optInPending: boolean | undefined;
    if (optIn && optInPhone) {
      const recorded = await recordPendingOptIn(supabase, form.business_id, form.id, optInPhone);
      optInPending = recorded.pending;
      if (recorded.request) {
        // Ask the typed number to confirm on WhatsApp after the response is sent. It
        // never blocks or fails the submit (the sender never throws).
        const request = { businessId: form.business_id as string, phone: optInPhone, requestId: recorded.request.id, nonce: recorded.request.nonce };
        try {
          after(() => sendOptInConfirmationRequest(supabase, request).then(() => undefined));
        } catch (err) {
          logger.warn('[FORMS] Opt-in confirmation not scheduled:', (err as Error).message);
        }
      }
    }

    // Atomic increment — prevents race condition with concurrent submissions
    await supabase.rpc('increment_form_response_count', { p_form_id: form.id });

    return NextResponse.json({ success: true, ...(optInPending !== undefined ? { optInPending } : {}) });
  } catch (error) {
    logger.error('[FORMS] Submit error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
