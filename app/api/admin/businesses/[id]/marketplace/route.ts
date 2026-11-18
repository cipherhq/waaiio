/**
 * POST /api/admin/businesses/[id]/marketplace — AI Marketplace verify and
 * discovery toggles (#1108 X2).
 *
 * The admin panel used to update `businesses` with the browser client, which
 * has no admin UPDATE policy, so the toggles matched 0 rows while the page
 * showed them as changed.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminPreflight, adminRequestIp, adminResponder, readJsonObject, UUID_RE } from '@/lib/admin-route';

const FIELDS = ['is_verified', 'discovery_enabled'] as const;

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const reply = adminResponder(request);
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const { id } = await params;
  if (!UUID_RE.test(id)) return reply({ error: 'Invalid business ID' }, 400);

  const body = await readJsonObject(request);
  const keys = body ? Object.keys(body) : [];
  if (!body || keys.length === 0 || keys.some(k => !(FIELDS as readonly string[]).includes(k))
      || keys.some(k => typeof body[k] !== 'boolean')) {
    return reply({ error: 'Invalid marketplace update' }, 400);
  }
  const update = Object.fromEntries(keys.map(k => [k, body[k] as boolean]));

  const service = createServiceClient();
  const { data: before, error: readError } = await service.from('businesses')
    .select('id, name, is_verified, discovery_enabled').eq('id', id).maybeSingle();
  if (readError) return reply({ error: 'Could not read business' }, 500);
  if (!before) return reply({ error: 'Business not found' }, 404);

  const { data: saved, error } = await service.from('businesses').update(update).eq('id', id)
    .select('id, is_verified, discovery_enabled').maybeSingle();
  if (error) return reply({ error: 'Failed to update business' }, 500);
  if (!saved) return reply({ error: 'Business was not updated. Refresh and try again.' }, 409);

  const audit = await logAdminAudit({
    actorId: admin.userId, action: 'update_marketplace_flags', entityType: 'business', entityId: id,
    details: {
      business_name: before.name,
      before: { is_verified: before.is_verified, discovery_enabled: before.discovery_enabled },
      after: { is_verified: saved.is_verified, discovery_enabled: saved.discovery_enabled },
    },
    ipAddress: adminRequestIp(request),
  });
  return reply({ business: saved, auditRecorded: !audit.error });
}
