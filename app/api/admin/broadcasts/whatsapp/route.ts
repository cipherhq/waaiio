import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CountryCode } from 'libphonenumber-js';
import { requirePlatformAdmin, type PlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { logger } from '@/lib/logger';
import {
  assertTemplateOnSenders, BroadcastInputError, checkRecipients, deliverBroadcast, estimateCost,
  listBroadcastTemplates, MAX_RECIPIENTS, parseBroadcastInput, renderTemplate, resolveRecipients,
  senderForPhone, type BroadcastInput, type SenderChoice,
} from '@/lib/admin-broadcast/whatsapp';

/**
 * Admin WhatsApp broadcasts (#1104). Waaiio's own template messages to its
 * users and account owners, from the shared Waaiio number. Platform sends:
 * no merchant messaging credit is used.
 *
 * GET                  — sendable templates on the Waaiio WhatsApp account.
 * POST mode='preview'  — recipient counts, skips and cost estimate. Sends nothing.
 * POST mode='status'   — the recorded result for a requestId, if any. Sends nothing.
 * POST mode='send'     — admin role, operation-bound step-up ('admin_broadcast',
 *                        target = requestId). One broadcast per requestId:
 *                        a repeated request returns the first result.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const METHODS = 'GET, POST, OPTIONS';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), METHODS) });
}

export async function GET(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'), METHODS);
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });
  try {
    const templates = await listBroadcastTemplates(new MetaCloudService());
    return NextResponse.json({ templates }, { headers: cors });
  } catch {
    return NextResponse.json({ error: 'Unable to load templates from WhatsApp' }, { status: 502, headers: cors });
  }
}

/** Shared Waaiio numbers by country, read once per request. */
function sharedSenders(db: SupabaseClient) {
  const resolver = new ChannelResolver(db);
  const memo = new Map<string, Promise<SenderChoice | null>>();
  return senderForPhone(country => {
    if (!memo.has(country)) {
      memo.set(country, resolver.getSharedChannelForCountry(country as CountryCode, true).then(r => (r?.cloud ? {
        accountKey: r.channel.waba_id || 'default',
        sender: r.sender,
        cloud: r.cloud,
      } : null)));
    }
    return memo.get(country)!;
  });
}

async function plan(db: SupabaseClient, input: BroadcastInput) {
  const { phones, withoutNumber } = await resolveRecipients(db, input);
  if (phones.length > MAX_RECIPIENTS) {
    throw new BroadcastInputError(`This audience has ${phones.length} numbers. One broadcast can reach at most ${MAX_RECIPIENTS}; narrow it with the filters.`);
  }
  const checks = await checkRecipients(db, phones);
  const eligible = phones.filter(p => checks.get(p) === 'ok');
  const senderFor = sharedSenders(db);
  const choices = await Promise.all(eligible.map(p => senderFor(p).catch(() => null)));
  const reachable = eligible.filter((_, i) => choices[i]);
  const noSender = eligible.length - reachable.length;
  const template = await assertTemplateOnSenders(choices, input, new MetaCloudService());
  return { phones, withoutNumber, checks, eligible, reachable, noSender, senderFor, template };
}

function count(checks: Map<string, string>, value: string) {
  let n = 0;
  for (const v of checks.values()) if (v === value) n++;
  return n;
}

type BroadcastRow = { id: string; status: string; audience_filter: { recipients?: number } | null };
const BROADCAST_COLUMNS = 'id, status, audience_filter';

/** The recorded result. While status is 'sending' the send is running or was cut off. */
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

    const input = parseBroadcastInput(body);

    if (mode === 'preview') {
      const p = await plan(db, input);
      return NextResponse.json({
        template: { ...p.template, rendered: renderTemplate(p.template.bodyText, input.params) },
        counts: {
          matched: p.phones.length,
          withoutNumber: p.withoutNumber,
          eligible: p.reachable.length,
          noSender: p.noSender,
          optedOut: count(p.checks, 'opted_out'),
          suspended: count(p.checks, 'suspended'),
          unverified: count(p.checks, 'unverified'),
        },
        estimate: await estimateCost(db, p.reachable, p.template.category),
        maxRecipients: MAX_RECIPIENTS,
        descriptor: input,
      }, { headers: cors });
    }

    return await send(request, db, admin, input, body!, cors);
  } catch (err) {
    if (err instanceof BroadcastInputError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: cors });
    }
    logger.error('[ADMIN-WA-BROADCAST] failed:', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
  }
}

async function send(
  request: NextRequest, db: SupabaseClient, admin: PlatformAdmin, input: BroadcastInput,
  body: Record<string, unknown>, cors: Record<string, string>,
) {
  const requestId = requestIdOf(body);
  if (!requestId) return NextResponse.json({ error: 'requestId (uuid) is required' }, { status: 400, headers: cors });

  // A repeated request (network retry, double click) gets the first result.
  const { data: existing, error: existingError } = await db.from('admin_broadcasts')
    .select(BROADCAST_COLUMNS).eq('request_id', requestId).maybeSingle();
  if (existingError) return NextResponse.json({ error: 'Unable to check this broadcast' }, { status: 500, headers: cors });
  if (existing) return NextResponse.json(await replay(db, existing as BroadcastRow), { headers: cors });

  if (await rateLimitResponseAsync(`admin-wa-broadcast:${admin.userId}`, 5, 3600_000)) {
    return NextResponse.json({ error: 'Too many WhatsApp broadcasts. Try again later.' }, { status: 429, headers: cors });
  }

  // Everything checkable is checked before the step-up is used up.
  const p = await plan(db, input);
  if (!p.reachable.length) {
    return NextResponse.json({ error: 'Nobody in this audience can be sent to. Preview again for the reasons.' }, { status: 422, headers: cors });
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
    channel: 'whatsapp',
    audience: input.audience,
    audience_filter: {
      country: input.country, plan: input.plan, template: input.templateName, language: input.language,
      category: p.template.category, recipients: p.phones.length,
    },
    subject: `${input.templateName} (${input.language})`.slice(0, 200),
    message: renderTemplate(p.template.bodyText, input.params),
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
    template: input.templateName, language: input.language, category: p.template.category,
    audience: input.audience, country: input.country, plan: input.plan,
    recipients: p.phones.length, merchant_credit_charged: false,
  };
  // Audited before the first send, so a run that is cut off still has a record.
  await logAdminAudit({
    actorId: admin.userId, action: 'start_whatsapp_broadcast', entityType: 'admin_broadcast', entityId: created.id,
    details: auditDetails, ipAddress,
  });

  const summary = await deliverBroadcast(db, {
    broadcastId: created.id,
    phones: p.phones,
    checks: p.checks,
    senderFor: p.senderFor,
    template: p.template,
    params: input.params,
  });
  const notSent = summary.failed + summary.noSender + summary.unknown;
  const status = summary.sent === 0 ? 'failed' : notSent > 0 ? 'partial' : 'sent';
  await db.from('admin_broadcasts').update({
    status,
    recipient_count: summary.sent,
    sent_at: new Date().toISOString(),
  }).eq('id', created.id);

  await logAdminAudit({
    actorId: admin.userId,
    action: 'send_whatsapp_broadcast',
    entityType: 'admin_broadcast',
    entityId: created.id,
    details: { ...auditDetails, ...summary },
    ipAddress,
  });

  return NextResponse.json({
    replayed: false,
    broadcastId: created.id,
    status,
    sent: summary.sent,
    failed: summary.failed + summary.noSender,
    unknown: summary.unknown,
    skipped: { optedOut: summary.skippedOptedOut, suspended: summary.skippedSuspended, unverified: summary.skippedUnverified },
  }, { headers: cors });
}
