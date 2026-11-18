/**
 * POST /api/admin/audit — record an admin-panel action in admin_audit_logs.
 *
 * #1108 X1: the panel used to insert with the browser client, which has no
 * INSERT right (M439), so every client-side audit entry was silently dropped.
 * The actor is always the verified admin, never a value from the body, and
 * entries are marked `source: 'admin_panel'` so they can be told apart from
 * entries written by the routes that performed the change.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminPreflight, adminRequestIp, adminResponder, readJsonObject, UUID_RE } from '@/lib/admin-route';

// admin_audit_logs.action and entity_type are VARCHAR(50).
const NAME_RE = /^[a-z][a-z0-9_]{0,49}$/;
const MAX_DETAILS_BYTES = 8_000;

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request);
}

export async function POST(request: NextRequest) {
  const reply = adminResponder(request);
  const admin = await requirePlatformAdmin(request);
  if (!admin) return reply({ error: 'Unauthorized' }, 403);

  const body = await readJsonObject(request);
  if (!body) return reply({ error: 'Invalid request body' }, 400);
  const { action, entity_type: entityType, entity_id: entityId, details } = body;
  if (typeof action !== 'string' || !NAME_RE.test(action)) return reply({ error: 'Invalid action' }, 400);
  if (entityType !== undefined && entityType !== null && (typeof entityType !== 'string' || !NAME_RE.test(entityType))) {
    return reply({ error: 'Invalid entity type' }, 400);
  }
  if (entityId !== undefined && entityId !== null && (typeof entityId !== 'string' || entityId.length > 100)) {
    return reply({ error: 'Invalid entity id' }, 400);
  }
  if (details !== undefined && details !== null && (typeof details !== 'object' || Array.isArray(details))) {
    return reply({ error: 'Invalid details' }, 400);
  }
  if (JSON.stringify(details ?? {}).length > MAX_DETAILS_BYTES) return reply({ error: 'Details too large' }, 400);

  // entity_id is a UUID column; keep other identifiers (country codes, 'new') in details.
  const isUuid = typeof entityId === 'string' && UUID_RE.test(entityId);
  const result = await logAdminAudit({
    actorId: admin.userId,
    action,
    entityType: (entityType as string | null | undefined) ?? undefined,
    entityId: isUuid ? entityId : null,
    details: {
      ...(details as Record<string, unknown> | undefined),
      ...(typeof entityId === 'string' && !isUuid ? { entity_ref: entityId } : {}),
      source: 'admin_panel',
    },
    ipAddress: adminRequestIp(request),
  });
  if (result.error) return reply({ error: 'Audit entry was not recorded' }, 500);
  return reply({ recorded: true });
}
