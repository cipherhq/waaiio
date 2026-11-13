import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { logAdminAudit } from '@/lib/admin-audit';
import { publishPartyRsvpFlow, partyRsvpFlowPublicationStatus } from '@/lib/parties/rsvp-flow-publisher';

export const dynamic = 'force-dynamic';
// Up to five sequential Meta calls with 15 s timeouts each.
export const maxDuration = 60;
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * #1005 PR 3c: publish the reusable party RSVP WhatsApp form on the platform WhatsApp account.
 * Platform admins or the server cron secret only. Unlike verifyCronAuth there is no local
 * development bypass, because this changes provider state. Publishing also needs
 * WHATSAPP_PARTY_RSVP_FORMS_ENABLED=true on the deployment, and the Owner's approval per account.
 * Returns who is calling: an admin (by ID) or the cron secret (no person), or null for neither.
 */
async function authorized(request: NextRequest): Promise<{ actorId: string | null; via: 'admin' | 'cron_secret' } | null> {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get('authorization') || '';
  if (secret) {
    const expected = `Bearer ${secret}`;
    if (header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected))) return { actorId: null, via: 'cron_secret' };
  }
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  return admin ? { actorId: admin.userId, via: 'admin' } : null;
}

function account() {
  const wabaId = (process.env.META_CLOUD_WABA_ID || '').trim();
  return /^[0-9]{1,64}$/.test(wabaId) && (process.env.META_CLOUD_ACCESS_TOKEN || '').trim() ? wabaId : null;
}

/** Read-only status of the current form version on this account. No provider call. */
export async function GET(request: NextRequest) {
  if (!await authorized(request)) return NextResponse.json({ error: 'Admin access required' }, { status: 403, headers: NO_STORE });
  const wabaId = account();
  if (!wabaId) return NextResponse.json({ error: 'The platform WhatsApp account is not configured.' }, { status: 503, headers: NO_STORE });
  try {
    return NextResponse.json(await partyRsvpFlowPublicationStatus(createServiceClient({ noStore: true }), wabaId), { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: 'Publication lookup unavailable.' }, { status: 503, headers: NO_STORE });
  }
}

/** Publish, or with {"resume": true} finish an attempt whose Meta asset is known. */
export async function POST(request: NextRequest) {
  const caller = await authorized(request);
  if (!caller) return NextResponse.json({ error: 'Admin access required' }, { status: 403, headers: NO_STORE });
  let body: unknown = {};
  try { body = await request.json(); } catch { /* An empty body means a fresh publish. */ }
  const resume = !!body && typeof body === 'object' && (body as { resume?: unknown }).resume === true;
  const wabaId = account();
  if (!wabaId) return NextResponse.json({ error: 'The platform WhatsApp account is not configured.' }, { status: 503, headers: NO_STORE });
  const limited = await rateLimitResponseAsync(`party-rsvp-flow-publish:${wabaId}`, 3, 60_000);
  if (limited) { limited.headers.set('Cache-Control', 'no-store'); return limited; }
  const outcome = await publishPartyRsvpFlow(createServiceClient({ noStore: true }), wabaId,
    new MetaCloudService().partyRsvpFlowAssets(wabaId), { resume });
  // Every attempt that reached the publisher is audited, whatever its outcome. Never blocks the reply.
  await logAdminAudit({
    actorId: caller.actorId, action: 'publish_party_rsvp_flow', entityType: 'party_rsvp_flow_publication',
    entityId: 'publicationId' in outcome ? outcome.publicationId : null,
    details: { via: caller.via, resume, outcome: outcome.status, waba_id: wabaId },
    ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
  });
  const status = outcome.status === 'published' ? 200 : outcome.status === 'not_enabled' || outcome.status === 'unavailable' ? 503 : 409;
  return NextResponse.json(outcome, { status, headers: NO_STORE });
}
