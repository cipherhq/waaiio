import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import {
  SEND_TIME_BUDGET_MS, TemplateLookupUnavailableError, loadInviteTemplate, sendFormInvites, summarize, type RecipientOutcome,
} from '@/lib/forms/form-send';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Due = { id: string; business_id: string; form_id: string; template_name: string | null; recipients: string[]; results: RecipientOutcome[] | null; skipped_count: number };

/**
 * Sends scheduled form invitations (#591). Each due send is claimed with a
 * status-guarded update that must return its row, so two overlapping runs send
 * it once. Consent and opt-outs are checked again for every recipient now,
 * because they may have changed since the send was scheduled.
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const db = createServiceClient();
  const { data: due, error } = await db.from('form_sends')
    .select('id, business_id, form_id, template_name, recipients, results, skipped_count')
    .eq('status', 'scheduled').lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true }).limit(3);
  if (error) {
    logger.error('[FORM SENDS] Due lookup failed:', error.message);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }

  // One budget for the whole tick: later sends wait for the next run rather than risk the 60s limit.
  const deadline = Date.now() + SEND_TIME_BUDGET_MS;
  let processed = 0;
  for (const send of (due || []) as Due[]) {
    if (Date.now() >= deadline) break;
    const { data: claimed, error: claimErr } = await db.from('form_sends')
      .update({ status: 'sending', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', send.id).eq('status', 'scheduled').select('id');
    if (claimErr || !claimed || claimed.length === 0) continue; // another run has it

    const finish = (fields: Record<string, unknown>) => db.from('form_sends')
      .update({ ...fields, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', send.id).eq('status', 'sending');
    try {
      const { data: form } = await db.from('forms').select('id, title, description, token, is_active')
        .eq('id', send.form_id).eq('business_id', send.business_id).maybeSingle();
      if (!form || !form.token || !form.is_active) {
        // A switched-off form would show "no longer accepting responses": never send a dead link.
        await finish({ status: 'cancelled', error_message: 'The form was switched off or removed before the send time' });
        processed++; continue;
      }
      const { data: biz } = await db.from('businesses').select('id, name').eq('id', send.business_id).maybeSingle();
      const resolved = biz ? await new ChannelResolver(db).resolveByBusinessId(send.business_id) : null;
      if (!biz || !resolved) {
        await finish({ status: 'failed', error_message: 'No active WhatsApp channel for this business' });
        processed++; continue;
      }
      const { checkConversationLimit } = await import('@/lib/bot/conversation-guard');
      const conv = await checkConversationLimit(db, send.business_id);
      if (!conv.allowed) {
        await finish({ status: 'failed', error_message: 'Monthly conversation limit reached' });
        processed++; continue;
      }
      // Re-checked on the sending account: approval can be withdrawn after scheduling.
      let template = null;
      if (send.template_name) {
        try {
          template = await loadInviteTemplate(resolved, send.template_name);
        } catch (err) {
          if (!(err instanceof TemplateLookupUnavailableError)) throw err;
          // WhatsApp could not be asked: nothing was sent, so put it back for the next run.
          await db.from('form_sends')
            .update({ status: 'scheduled', started_at: null, updated_at: new Date().toISOString(), error_message: 'Waiting: templates could not be checked, will retry' })
            .eq('id', send.id).eq('status', 'sending');
          continue;
        }
      }
      const outcomes = await sendFormInvites({
        db, resolved, businessId: send.business_id, businessName: biz.name,
        form: { id: form.id, title: form.title, description: form.description, token: form.token },
        template, phones: send.recipients, deadline,
      });
      const earlier = Array.isArray(send.results) ? send.results : [];
      const now = summarize(outcomes);
      const notes = [
        now.sent === 0 ? 'No messages were accepted' : null,
        outcomes.some(o => o.status === 'skipped' && o.reason === 'not_attempted') ? 'Some people were not attempted (ran out of time); send again to them' : null,
        send.template_name && !template ? 'The chosen template is no longer approved for form links' : null,
      ].filter(Boolean).join('. ');
      await finish({
        status: now.sent > 0 ? 'sent' : 'failed',
        sent_count: now.sent, failed_count: now.failed, skipped_count: (send.skipped_count || 0) + now.skipped,
        results: [...earlier, ...outcomes], error_message: notes || null,
      });
      processed++;
    } catch (err) {
      logger.error('[FORM SENDS] Send failed:', err);
      Sentry.captureException(err);
      await finish({ status: 'failed', error_message: 'Sending stopped unexpectedly' });
    }
  }
  return NextResponse.json({ processed });
}
