/**
 * POST /api/admin/campaigns/[id] — admin edit of a fundraising campaign (#1108 X2).
 *
 * The admin panel used to update `campaigns` with the browser client, which
 * has no admin UPDATE policy, so the save matched 0 rows and still reported
 * success. This route uses the service client, confirms the row changed and
 * audits the change. Money raised is not touched.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminPreflight, adminRequestIp, adminResponder, readJsonObject, UUID_RE } from '@/lib/admin-route';

// campaigns.status CHECK (M008)
const STATUSES = new Set(['draft', 'active', 'paused', 'completed', 'cancelled']);
const FIELDS = ['title', 'goal_amount', 'start_date', 'end_date', 'status'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLUMNS = 'id, title, goal_amount, start_date, end_date, status';

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const reply = adminResponder(request);
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const { id } = await params;
  if (!UUID_RE.test(id)) return reply({ error: 'Invalid campaign ID' }, 400);

  const body = await readJsonObject(request);
  if (!body || Object.keys(body).some(k => !(FIELDS as readonly string[]).includes(k))) {
    return reply({ error: 'Invalid campaign update' }, 400);
  }
  const { title, goal_amount: goal, start_date: start, end_date: end, status } = body;
  if (typeof title !== 'string' || !title.trim() || title.length > 200) return reply({ error: 'Title is required' }, 400);
  if (typeof goal !== 'number' || !Number.isFinite(goal) || goal < 0 || goal >= 1e10) return reply({ error: 'Invalid goal amount' }, 400);
  for (const d of [start, end]) {
    if (d !== null && (typeof d !== 'string' || !DATE_RE.test(d))) return reply({ error: 'Invalid date' }, 400);
  }
  if (typeof start === 'string' && typeof end === 'string' && end < start) return reply({ error: 'End date is before start date' }, 400);
  if (typeof status !== 'string' || !STATUSES.has(status)) return reply({ error: 'Invalid status' }, 400);

  const service = createServiceClient();
  const { data: before, error: readError } = await service.from('campaigns').select(COLUMNS).eq('id', id).maybeSingle();
  if (readError) return reply({ error: 'Could not read campaign' }, 500);
  if (!before) return reply({ error: 'Campaign not found' }, 404);

  const update = { title: title.trim(), goal_amount: goal, start_date: start, end_date: end, status, updated_at: new Date().toISOString() };
  const { data: saved, error } = await service.from('campaigns').update(update).eq('id', id).select(COLUMNS).maybeSingle();
  if (error) return reply({ error: 'Failed to save campaign' }, 500);
  if (!saved) return reply({ error: 'Campaign was not updated. Refresh and try again.' }, 409);

  const audit = await logAdminAudit({
    actorId: admin.userId, action: 'edit_campaign', entityType: 'campaigns', entityId: id,
    details: { before, after: saved }, ipAddress: adminRequestIp(request),
  });
  return reply({ campaign: saved, auditRecorded: !audit.error });
}
