import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { RECIPIENT_POLICY } from '@/lib/merchants/recipient-permission';
import { validateAudienceExpression, type AudienceExpression } from '@/lib/engage/audience-dsl';
import { resolveAudienceExpression, AudienceTooLargeError, AudienceCountUnavailableError, AudienceIncompleteError } from '@/lib/engage/audience-resolver';
import {
  MAX_RECIPIENTS_PER_SEND, MAX_TYPED_ENTRIES, SEND_TIME_BUDGET_MS, TemplateLookupUnavailableError, classifyRecipient, loadInviteTemplate, normalizeRecipients, sendFormInvites, summarize,
  type RecipientOutcome,
} from '@/lib/forms/form-send';

/** Most scheduled sends one business may have waiting at once (interim; Owner decision pending on limits). */
const MAX_WAITING_SENDS = 20;

/** Scheduled sends: at least a minute ahead (the cron runs every 5 minutes), at most 90 days. */
function parseSchedule(value: unknown): Date | 'invalid' | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'invalid';
  const at = new Date(value);
  const t = at.getTime();
  if (Number.isNaN(t) || t < Date.now() + 60_000 || t > Date.now() + 90 * 24 * 60 * 60_000) return 'invalid';
  return at;
}

export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Send a web form invitation on WhatsApp to typed numbers, picked contacts and/or
 * an existing Audience segment. Only recipients with recorded consent, or who messaged
 * this business in the last 24 hours (text only), are messaged; everyone gets an
 * honest per-recipient result. Sending never writes form_responses.
 */
export async function POST(request: NextRequest) {
  // The time budget runs from the start of the request, so Audience and template
  // lookups count against it too.
  const deadline = Date.now() + SEND_TIME_BUDGET_MS;
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'form-send'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const formId = body?.formId;
    const businessId = body?.businessId;
    const segmentId = body?.segmentId;
    const templateName = body?.templateName;
    if (typeof formId !== 'string' || typeof businessId !== 'string') {
      return NextResponse.json({ error: 'formId and businessId required' }, { status: 400 });
    }
    // `phone` is the original single-number field; `phones` adds groups.
    const typed: unknown[] = [
      ...(body?.phone !== undefined ? [body.phone] : []),
      ...(body?.phones !== undefined ? (Array.isArray(body.phones) ? body.phones : [null]) : []),
    ];
    if (typed.some(p => typeof p !== 'string')) {
      return NextResponse.json({ error: 'phones must be a list of phone numbers' }, { status: 400 });
    }
    if (typed.length > MAX_TYPED_ENTRIES) {
      return NextResponse.json({ error: `That list is too long. Paste at most ${MAX_TYPED_ENTRIES} numbers, and send to at most ${MAX_RECIPIENTS_PER_SEND} people at a time.` }, { status: 400 });
    }
    if (segmentId !== undefined && (typeof segmentId !== 'string' || !UUID_RE.test(segmentId))) {
      return NextResponse.json({ error: 'Invalid audience' }, { status: 400 });
    }
    if (templateName !== undefined && templateName !== null && typeof templateName !== 'string') {
      return NextResponse.json({ error: 'Invalid template' }, { status: 400 });
    }
    const scheduledAt = parseSchedule(body?.scheduledAt);
    if (scheduledAt === 'invalid') {
      return NextResponse.json({ error: 'Choose a time at least 1 minute from now and within 90 days.' }, { status: 400 });
    }
    if (typed.length === 0 && !segmentId) {
      return NextResponse.json({ error: 'Choose at least one recipient' }, { status: 400 });
    }

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, country_code')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();
    if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const perBusiness = await rateLimitResponseAsync(`form-send:${businessId}`, 5, 60_000);
    if (perBusiness) return perBusiness;

    const service = createServiceClient();
    const { data: form } = await service
      .from('forms')
      .select('id, title, description, token, is_active')
      .eq('id', formId)
      .eq('business_id', businessId)
      .single();
    if (!form || !form.token) return NextResponse.json({ error: 'Form not found' }, { status: 404 });
    if (!form.is_active) return NextResponse.json({ error: 'Form is inactive' }, { status: 400 });

    const country = biz.country_code || 'NG';
    const raw = typed as string[];
    if (segmentId) {
      const { data: segment, error: segErr } = await service
        .from('engage_segments').select('id, expression')
        .eq('id', segmentId).eq('business_id', businessId).maybeSingle();
      if (segErr) return NextResponse.json({ error: 'Could not load the audience' }, { status: 503 });
      if (!segment) return NextResponse.json({ error: 'Audience not found' }, { status: 404 });
      if (!validateAudienceExpression(segment.expression).valid) {
        return NextResponse.json({ error: 'This audience can no longer be used. Edit it in Audiences.' }, { status: 422 });
      }
      try {
        const audience = await resolveAudienceExpression(service, businessId, country, segment.expression as AudienceExpression);
        for (const identity of audience.values()) if (identity.phone) raw.push(identity.phone);
      } catch (err) {
        if (err instanceof AudienceTooLargeError || err instanceof AudienceCountUnavailableError || err instanceof AudienceIncompleteError) {
          return NextResponse.json({ error: err.message }, { status: 422 });
        }
        throw err;
      }
    }

    const { phones, invalid } = normalizeRecipients(raw, country);
    if (phones.length + invalid.length === 0) {
      return NextResponse.json({ error: 'This audience has no phone numbers' }, { status: 400 });
    }
    if (phones.length > MAX_RECIPIENTS_PER_SEND) {
      return NextResponse.json({ error: `You can send to at most ${MAX_RECIPIENTS_PER_SEND} people at a time.` }, { status: 400 });
    }

    const resolver = new ChannelResolver(service);
    const resolved = await resolver.resolveByBusinessId(businessId);
    if (!resolved) return NextResponse.json({ error: 'No WhatsApp channel configured' }, { status: 400 });

    let template = null;
    if (templateName) {
      try {
        template = await loadInviteTemplate(resolved, templateName, deadline);
      } catch (err) {
        if (err instanceof TemplateLookupUnavailableError) {
          return NextResponse.json({ error: 'Could not check templates with WhatsApp right now. Nothing was sent. Please try again shortly.' }, { status: 503 });
        }
        throw err;
      }
      if (!template) {
        return NextResponse.json({
          error: 'That template cannot carry a form link. Choose an approved template that takes the business name and one message line.',
        }, { status: 400 });
      }
    }

    const invalidSkips: RecipientOutcome[] = invalid.map(phone => ({ phone, status: 'skipped' as const, reason: 'invalid_phone' as const }));

    if (scheduledAt) {
      // Interim cap on waiting sends per business, so one merchant cannot crowd the queue.
      const { count: waiting, error: waitingErr } = await service.from('form_sends')
        .select('id', { count: 'exact', head: true }).eq('business_id', businessId).eq('status', 'scheduled');
      if (waitingErr) return NextResponse.json({ error: 'Could not schedule this send' }, { status: 503 });
      if ((waiting ?? 0) >= MAX_WAITING_SENDS) {
        return NextResponse.json({ error: `You already have ${MAX_WAITING_SENDS} sends waiting. Cancel one or wait for them to go out.` }, { status: 429 });
      }
      // Store only people who may be messaged now (opted in, or messaged this business in
      // the last 24 hours); the cron classifies each one again when it sends, so a
      // window-only person whose window has closed by then is skipped, never templated.
      const skips: RecipientOutcome[] = [...invalidSkips];
      const eligible: string[] = [];
      for (let i = 0; i < phones.length; i += 5) {
        const batch = phones.slice(i, i + 5);
        const checks = await Promise.all(batch.map(p => classifyRecipient(service, businessId, p, resolved.channel)));
        batch.forEach((phone, k) => {
          const check = checks[k];
          if (!check.eligible) skips.push({ phone, status: 'skipped', reason: check.reason }); else eligible.push(phone);
        });
      }
      if (eligible.length === 0) {
        return NextResponse.json({ error: 'No one on this list has opted in or messaged you in the last 24 hours, so nothing was scheduled.', results: skips, policy: RECIPIENT_POLICY }, { status: 400 });
      }
      const { data: row, error: insertErr } = await service.from('form_sends').insert({
        business_id: businessId, form_id: form.id, created_by: user.id,
        template_name: template?.name ?? null, recipients: eligible, status: 'scheduled',
        scheduled_at: scheduledAt.toISOString(), skipped_count: skips.length, results: skips,
      }).select('id, scheduled_at').single();
      if (insertErr || !row) {
        logger.error('[FORMS] Schedule insert failed:', insertErr?.message);
        return NextResponse.json({ error: 'Could not schedule this send' }, { status: 500 });
      }
      return NextResponse.json({
        scheduled: true, id: row.id, scheduledAt: row.scheduled_at, recipients: eligible.length,
        skipped: skips.length, results: skips, ...(skips.length > 0 ? { policy: RECIPIENT_POLICY } : {}),
      });
    }

    if (phones.length > 0) {
      const { checkConversationLimit } = await import('@/lib/bot/conversation-guard');
      const conv = await checkConversationLimit(service, businessId);
      if (!conv.allowed) {
        return NextResponse.json({ error: `Monthly conversation limit reached (${conv.used}/${conv.limit}).` }, { status: 403 });
      }
    }

    const startedAt = new Date().toISOString();
    const outcomes: RecipientOutcome[] = [
      ...invalidSkips,
      ...await sendFormInvites({
        db: service, resolved, businessId, businessName: biz.name,
        form: { id: form.id, title: form.title, description: form.description, token: form.token },
        template, phones, deadline,
      }),
    ];
    const summary = summarize(outcomes);
    if (phones.length > 0) {
      // Send history for the Forms page. Best effort: the messages already went out.
      const { error: historyErr } = await service.from('form_sends').insert({
        business_id: businessId, form_id: form.id, created_by: user.id, template_name: template?.name ?? null,
        recipients: phones, status: summary.sent > 0 ? 'sent' : 'failed', scheduled_at: startedAt,
        started_at: startedAt, completed_at: new Date().toISOString(),
        sent_count: summary.sent, failed_count: summary.failed, skipped_count: summary.skipped, results: outcomes,
        error_message: summary.sent > 0 ? null : 'No messages were accepted',
      });
      if (historyErr) logger.warn('[FORMS] Send history not saved:', historyErr.message);
    }
    return NextResponse.json({
      success: summary.sent > 0,
      ...summary,
      results: outcomes,
      ...(summary.skipped > 0 ? { policy: RECIPIENT_POLICY } : {}),
    });
  } catch (error) {
    logger.error('[FORMS] Send error:', error);
    return NextResponse.json({ error: 'Failed to send form' }, { status: 500 });
  }
}
