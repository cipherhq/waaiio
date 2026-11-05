import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import {
  SEND_TIME_BUDGET_MS, TemplateLookupUnavailableError, loadInviteTemplate, sendFormInvites, summarize,
  type InviteTemplate, type RecipientOutcome,
} from '@/lib/forms/form-send';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Most sends started by one run (more only while time remains). At most one per
 * business per run, so no merchant can hold up the others.
 */
const MAX_SENDS_PER_RUN = 10;
/** Do not start a send with less time than this left in the run. */
const MIN_BUDGET_TO_START_MS = 20_000;
/** A send still "sending" after this long was interrupted (the function limit is 60s). */
const STALE_SENDING_MS = 10 * 60_000;
/** Keep retrying a template check that WhatsApp can't answer for this long after the send time. */
const TEMPLATE_RETRY_WINDOW_MS = 2 * 60 * 60_000;

/** Due sends read per run, before taking turns between businesses. */
const MAX_CANDIDATES = 200;

/**
 * Round-robin between businesses: every business's oldest due send comes before
 * any business's second, so a business with many waiting sends never pushes
 * another business's send back by more than one turn per business.
 */
function takeTurns(rows: Due[]): Due[] {
  const position = new Map<string, number>();
  const ranked = rows.map((row, index) => {
    const turn = position.get(row.business_id) ?? 0;
    position.set(row.business_id, turn + 1);
    return { row, turn, index };
  });
  ranked.sort((a, b) => a.turn - b.turn || a.index - b.index);
  // Only a business's first turn runs now; later turns wait for later runs.
  return ranked.filter(r => r.turn === 0).map(r => r.row);
}

/**
 * Close a send that stops before everyone was reached. If some people already got
 * it in an earlier run, say so instead of claiming nothing was sent, and list the
 * people it never reached so the merchant can see exactly who they are.
 */
function endedEarly(send: Due, status: 'failed' | 'cancelled', reason: string): Record<string, unknown> {
  const already = send.sent_count || 0;
  const notReached: RecipientOutcome[] = send.recipients.map(phone => ({ phone, status: 'skipped', reason: 'stopped' }));
  return {
    status: already > 0 ? 'sent' : status,
    error_message: already > 0
      ? `Sent to ${already}; the other ${send.recipients.length} were not sent because ${reason}.`
      : `Nothing was sent because ${reason}.`,
    results: [...(Array.isArray(send.results) ? send.results : []), ...notReached],
    skipped_count: (send.skipped_count || 0) + notReached.length,
  };
}

const INTERRUPTED_MESSAGE = 'Interrupted while sending. Some messages may have gone out, so check before sending again.';

type Due = {
  id: string; business_id: string; form_id: string; template_name: string | null; recipients: string[];
  results: RecipientOutcome[] | null; sent_count: number; failed_count: number; skipped_count: number; scheduled_at: string;
};

/**
 * Sends scheduled form invitations (#591).
 * - Each due send is claimed with a status-guarded update that must return its row,
 *   so overlapping runs send it once.
 * - Consent and opt-outs are checked again for every recipient now.
 * - People not reached before the run's time budget are put back in the queue,
 *   never dropped; a send left in "sending" by a killed run is marked interrupted
 *   and never re-sent.
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const db = createServiceClient();
  const deadline = Date.now() + SEND_TIME_BUDGET_MS;
  const nowIso = () => new Date().toISOString();

  // A run that was killed mid-send leaves its row in "sending". Say so honestly; never re-send.
  const { error: sweepErr } = await db.from('form_sends')
    .update({ status: 'failed', error_message: INTERRUPTED_MESSAGE, completed_at: nowIso(), updated_at: nowIso() })
    .eq('status', 'sending').lt('started_at', new Date(Date.now() - STALE_SENDING_MS).toISOString());
  if (sweepErr) logger.warn('[FORM SENDS] Stale sweep failed:', sweepErr.message);

  // Least recently touched first, so a send that was put back waits behind the others.
  const { data: candidates, error } = await db.from('form_sends')
    .select('id, business_id, form_id, template_name, recipients, results, sent_count, failed_count, skipped_count, scheduled_at')
    .eq('status', 'scheduled').lte('scheduled_at', nowIso())
    .order('updated_at', { ascending: true }).order('id', { ascending: true }).limit(MAX_CANDIDATES);
  if (error) {
    logger.error('[FORM SENDS] Due lookup failed:', error.message);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }
  const picked = takeTurns((candidates || []) as Due[]).slice(0, MAX_SENDS_PER_RUN);

  let processed = 0;
  for (const send of picked) {
    if (deadline - Date.now() < MIN_BUDGET_TO_START_MS) break; // the rest wait for the next run
    const { data: claimed, error: claimErr } = await db.from('form_sends')
      .update({ status: 'sending', started_at: nowIso(), updated_at: nowIso() })
      .eq('id', send.id).eq('status', 'scheduled').select('id');
    if (claimErr || !claimed || claimed.length === 0) continue; // another run has it
    // This business has had its turn: its other waiting sends go to the back of the queue.
    await db.from('form_sends').update({ updated_at: nowIso() })
      .eq('business_id', send.business_id).eq('status', 'scheduled');

    const finish = (fields: Record<string, unknown>) => db.from('form_sends')
      .update({ ...fields, completed_at: nowIso(), updated_at: nowIso() })
      .eq('id', send.id).eq('status', 'sending');
    const putBack = (fields: Record<string, unknown>) => db.from('form_sends')
      .update({ ...fields, status: 'scheduled', started_at: null, updated_at: nowIso() })
      .eq('id', send.id).eq('status', 'sending');
    processed++;
    try {
      const { data: form } = await db.from('forms').select('id, title, description, token, is_active')
        .eq('id', send.form_id).eq('business_id', send.business_id).maybeSingle();
      if (!form || !form.token || !form.is_active) {
        // A switched-off form would show "no longer accepting responses": never send a dead link.
        await finish(endedEarly(send, 'cancelled', 'the form was switched off or removed'));
        continue;
      }
      const { data: biz } = await db.from('businesses').select('id, name').eq('id', send.business_id).maybeSingle();
      const resolved = biz ? await new ChannelResolver(db).resolveByBusinessId(send.business_id) : null;
      if (!biz || !resolved) {
        await finish(endedEarly(send, 'failed', 'this business has no active WhatsApp channel'));
        continue;
      }
      const { checkConversationLimit } = await import('@/lib/bot/conversation-guard');
      const conv = await checkConversationLimit(db, send.business_id);
      if (!conv.allowed) {
        await finish(endedEarly(send, 'failed', 'the monthly conversation limit was reached'));
        continue;
      }

      // Re-checked on the sending account: approval can be withdrawn after scheduling.
      let template: InviteTemplate | null = null;
      if (send.template_name) {
        try {
          template = await loadInviteTemplate(resolved, send.template_name, deadline);
        } catch (err) {
          if (!(err instanceof TemplateLookupUnavailableError)) throw err;
          if (Date.now() - Date.parse(send.scheduled_at) > TEMPLATE_RETRY_WINDOW_MS) {
            await finish(endedEarly(send, 'failed', 'WhatsApp templates could not be checked for 2 hours (check the WhatsApp connection and schedule again)'));
          } else {
            await putBack({ error_message: 'Waiting: templates could not be checked, will retry' });
          }
          continue;
        }
        if (!template) {
          // Same rule as an immediate send: an unusable template means nothing goes out.
          await finish(endedEarly(send, 'failed', 'the chosen template is no longer approved for form links'));
          continue;
        }
      }

      const outcomes = await sendFormInvites({
        db, resolved, businessId: send.business_id, businessName: biz.name,
        form: { id: form.id, title: form.title, description: form.description, token: form.token },
        template, phones: send.recipients, deadline,
      });
      const isLeftOver = (o: RecipientOutcome) => o.status === 'skipped' && o.reason === 'not_attempted';
      const done = outcomes.filter(o => !isLeftOver(o));
      const remaining = outcomes.filter(isLeftOver).map(o => o.phone);
      const now = summarize(done);
      const totals = {
        sent_count: (send.sent_count || 0) + now.sent,
        failed_count: (send.failed_count || 0) + now.failed,
        skipped_count: (send.skipped_count || 0) + now.skipped,
        results: [...(Array.isArray(send.results) ? send.results : []), ...done],
      };
      if (remaining.length > 0) {
        const progressed = done.length > 0;
        if (!progressed && Date.now() - Date.parse(send.scheduled_at) > TEMPLATE_RETRY_WINDOW_MS) {
          // Never got going for 2 hours: close it honestly rather than retrying for ever.
          await finish({ ...totals, ...endedEarly({ ...send, ...totals, recipients: remaining }, 'failed', 'it could not be started within 2 hours of the send time') });
          continue;
        }
        // Out of time: the rest go back in the queue for the next run, with results so far kept.
        await putBack({
          ...totals, recipients: remaining,
          error_message: totals.sent_count + totals.failed_count + totals.skipped_count > 0
            ? `Partly sent; ${remaining.length} still to send` : 'Waiting: not started yet, will retry',
        });
        continue;
      }
      await finish({
        ...totals,
        status: totals.sent_count > 0 ? 'sent' : 'failed',
        error_message: totals.sent_count > 0 ? null
          : totals.failed_count > 0 ? 'No messages were accepted' : 'Nobody was eligible to receive it at send time',
      });
    } catch (err) {
      logger.error('[FORM SENDS] Send failed:', err);
      Sentry.captureException(err);
      await finish({ status: 'failed', error_message: INTERRUPTED_MESSAGE });
    }
  }
  return NextResponse.json({ processed });
}
