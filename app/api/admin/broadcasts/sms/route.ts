import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requirePlatformAdmin, type PlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { isSmsConfigured } from '@/lib/sms/bulksms-ng';
import { BroadcastInputError, MAX_RECIPIENTS } from '@/lib/admin-broadcast/whatsapp';
import { deliverSmsBroadcast, parseSmsBroadcastInput, planSmsBroadcast, type SmsBroadcastInput } from '@/lib/admin-broadcast/sms';

/**
 * Admin SMS broadcasts (#1131). Waaiio's own text message to its users and
 * account owners in Nigeria and Ghana. Waaiio pays: no merchant messaging
 * credit is used.
 *
 * POST mode='preview'  — recipient counts, skips, pages and Waaiio's cost. Sends nothing.
 * POST mode='status'   — the recorded result for a requestId, if any. Sends nothing.
 * POST mode='send'     — admin role, operation-bound step-up ('admin_broadcast',
 *                        target = requestId). One broadcast per requestId:
 *                        a repeated request returns the first result.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const METHODS = 'POST, OPTIONS';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), METHODS) });
}

type BroadcastRow = { id: string; status: string; audience_filter: { recipients?: number } | null };
const BROADCAST_COLUMNS = 'id, status, audience_filter';

async function replay(db: SupabaseClient, broadcast: BroadcastRow) {
  const { data } = await db.from('admin_broadcast_recipients').select('status').eq('broadcast_id', broadcast.id);
  const rows = (data ?? []) as Array<{ status: string }>;
  const n = (s: string) => rows.filter(r => r.status === s).length;
  const total = broadcast.audience_filter?.recipients ?? rows.length;
  return {
    replayed: true,
    broadcastId: broadcast.id,
    status: broadcast.status,
    sent: n('sent'), failed: n('failed'), unknown: n('unknown') + n('sending'),
    notProcessed: Math.max(0, total - rows.length),
    skipped: { optedOut: n('skipped_opted_out'), suspended: n('skipped_suspended'), unverified: n('skipped_unverified') },
  };
}

function requestIdOf(body: Record<string, unknown>) {
  return typeof body.requestId === 'string' && UUID.test(body.requestId) ? body.requestId.toLowerCase() : null;
}

function count(checks: Map<string, string>, value: string) {
  let n = 0;
  for (const v of checks.values()) if (v === value) n++;
  return n;
}

export async function POST(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'), METHODS);
  try {
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const mode = body?.mode;
    if (mode !== 'preview' && mode !== 'send' && mode !== 'status') {
      return NextResponse.json({ error: "mode must be 'preview', 'send' or 'status'" }, { status: 400, headers: cors });
    }
    const db = createServiceClient();

    if (mode === 'status') {
      const requestId = requestIdOf(body!);
      if (!requestId) return NextResponse.json({ error: 'requestId (uuid) is required' }, { status: 400, headers: cors });
      const { data, error } = await db.from('admin_broadcasts').select(BROADCAST_COLUMNS).eq('request_id', requestId).maybeSingle();
      if (error) return NextResponse.json({ error: 'Unable to check this broadcast' }, { status: 500, headers: cors });
      return NextResponse.json(data ? await replay(db, data as BroadcastRow) : { recorded: false }, { headers: cors });
    }

    const input = parseSmsBroadcastInput(body);

    if (mode === 'preview') {
      const p = await planSmsBroadcast(db, input);
      return NextResponse.json({
        configured: isSmsConfigured(),
        sms: { pages: p.segments.pages, unicode: p.segments.unicode, characters: p.segments.characters, perPage: p.segments.perPage },
        counts: {
          matched: p.phones.length,
          withoutNumber: p.withoutNumber,
          notSmsCountry: p.notSmsCountry,
          eligible: p.eligible.length,
          optedOut: count(p.checks, 'opted_out'),
          suspended: count(p.checks, 'suspended'),
          unverified: count(p.checks, 'unverified'),
        },
        quietHoursNow: p.quietHoursNow,
        estimate: p.estimate,
        maxRecipients: MAX_RECIPIENTS,
        descriptor: input,
      }, { headers: cors });
    }

    return await send(request, db, admin, input, body!, cors);
  } catch (err) {
    if (err instanceof BroadcastInputError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: cors });
    }
    logger.error('[ADMIN-SMS-BROADCAST] failed:', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
  }
}

async function send(
  request: NextRequest, db: SupabaseClient, admin: PlatformAdmin, input: SmsBroadcastInput,
  body: Record<string, unknown>, cors: Record<string, string>,
) {
  const requestId = requestIdOf(body);
  if (!requestId) return NextResponse.json({ error: 'requestId (uuid) is required' }, { status: 400, headers: cors });

  // A repeated request (network retry, double click) gets the first result.
  const { data: existing, error: existingError } = await db.from('admin_broadcasts')
    .select(BROADCAST_COLUMNS).eq('request_id', requestId).maybeSingle();
  if (existingError) return NextResponse.json({ error: 'Unable to check this broadcast' }, { status: 500, headers: cors });
  if (existing) return NextResponse.json(await replay(db, existing as BroadcastRow), { headers: cors });

  if (!isSmsConfigured()) {
    return NextResponse.json({ error: 'SMS is not switched on (no registered sender name). Nothing was sent.' }, { status: 422, headers: cors });
  }
  if (await rateLimitResponseAsync(`admin-sms-broadcast:${admin.userId}`, 5, 3600_000)) {
    return NextResponse.json({ error: 'Too many SMS broadcasts. Try again later.' }, { status: 429, headers: cors });
  }

  // Everything checkable is checked before the step-up is used up.
  const p = await planSmsBroadcast(db, input);
  if (!p.eligible.length) {
    return NextResponse.json({ error: 'Nobody in this audience can get an SMS. Preview again for the reasons.' }, { status: 422, headers: cors });
  }
  if (p.quietHoursNow) {
    return NextResponse.json({ error: 'SMS broadcasts are not sent between 8pm and 8am local time. Nothing was sent.' }, { status: 422, headers: cors });
  }

  try {
    await consumeStepUp(admin, typeof body.stepUpId === 'string' ? body.stepUpId : '', 'admin_broadcast', requestId, { ...input });
  } catch (err) {
    const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
    return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403, headers: cors });
  }

  const { data: created, error: createError } = await db.from('admin_broadcasts').insert({
    request_id: requestId,
    sender_id: admin.userId,
    channel: 'sms',
    audience: input.audience,
    audience_filter: { country: input.country, plan: input.plan, pages: p.segments.pages, unicode: p.segments.unicode, recipients: p.smsPhones.length },
    subject: `SMS (${p.segments.pages} page${p.segments.pages === 1 ? '' : 's'})`,
    message: input.message,
    status: 'sending',
    recipient_count: 0,
  }).select('id').single();
  if (createError?.code === '23505') {
    const { data: winner } = await db.from('admin_broadcasts').select(BROADCAST_COLUMNS).eq('request_id', requestId).maybeSingle();
    if (winner) return NextResponse.json(await replay(db, winner as BroadcastRow), { headers: cors });
  }
  if (createError || !created) return NextResponse.json({ error: 'Unable to record the broadcast. Nothing was sent.' }, { status: 500, headers: cors });

  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const auditDetails = {
    audience: input.audience, country: input.country, plan: input.plan,
    pages: p.segments.pages, unicode: p.segments.unicode,
    recipients: p.smsPhones.length, merchant_credit_charged: false,
  };
  await logAdminAudit({
    actorId: admin.userId, action: 'start_sms_broadcast', entityType: 'admin_broadcast', entityId: created.id,
    details: auditDetails, ipAddress,
  });

  const summary = await deliverSmsBroadcast(db, { broadcastId: created.id, phones: p.smsPhones, checks: p.checks, message: input.message });
  const notSent = summary.failed + summary.unknown;
  const status = summary.sent === 0 ? 'failed' : notSent > 0 ? 'partial' : 'sent';
  await db.from('admin_broadcasts').update({ status, recipient_count: summary.sent, sent_at: new Date().toISOString() }).eq('id', created.id);

  await logAdminAudit({
    actorId: admin.userId, action: 'send_sms_broadcast', entityType: 'admin_broadcast', entityId: created.id,
    details: { ...auditDetails, ...summary }, ipAddress,
  });

  return NextResponse.json({
    replayed: false,
    broadcastId: created.id,
    status,
    sent: summary.sent,
    failed: summary.failed,
    unknown: summary.unknown,
    skipped: { optedOut: summary.skippedOptedOut, suspended: summary.skippedSuspended, unverified: summary.skippedUnverified },
  }, { headers: cors });
}
