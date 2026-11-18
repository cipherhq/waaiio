/**
 * /api/admin/bot-keywords — admin Bot Keywords page (#1108 X2/X3).
 *
 * GET lists every keyword (system, category and business) for review.
 * Creating, editing and deleting are limited to system and category keywords:
 * business keywords belong to the business and are edited on its dashboard.
 * Switching any keyword on or off stays available, as the page already offered.
 * The browser client could read none of these rows and its writes matched 0 rows.
 *
 *   GET                         → { keywords }
 *   POST   { ...fields }        → create
 *   PATCH  { id, ...fields }    → update (a toggle sends only is_active)
 *   DELETE { id }               → delete
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminPreflight, adminRequestIp, adminResponder, readJsonObject, UUID_RE } from '@/lib/admin-route';

const METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
// Same roles that can open the Bot Keywords page (admin/src/lib/permissions.ts).
const ROLES = ['admin', 'operations'] as const;
const COLUMNS = 'id, keyword, match_type, action_type, payload, is_active, priority, scope, category, description, business_id, created_at';
// CHECK constraints from M041.
const MATCH_TYPES = new Set(['exact', 'contains', 'starts_with', 'regex']);
const ACTION_TYPES = new Set(['reply', 'start_flow', 'start_capability', 'url', 'navigate_step', 'acknowledge', 'show_menu']);
const ADMIN_SCOPES = new Set(['system', 'category']);
const FIELDS = ['keyword', 'match_type', 'scope', 'category', 'action_type', 'payload', 'description', 'is_active', 'priority'];

type Fields = Record<string, unknown>;

/** Validate a full keyword (create or edit). Returns an error message or the row to write. */
function validateKeyword(body: Fields): string | Fields {
  if (Object.keys(body).some(k => k !== 'id' && !FIELDS.includes(k))) return 'Invalid keyword fields';
  const { keyword, match_type, scope, category, action_type, payload, description, is_active, priority } = body;
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 200) return 'Keyword is required';
  if (typeof match_type !== 'string' || !MATCH_TYPES.has(match_type)) return 'Invalid match type';
  if (typeof scope !== 'string' || !ADMIN_SCOPES.has(scope)) return 'Only system and category keywords can be managed here';
  if (scope === 'category' && (typeof category !== 'string' || !category.trim() || category.length > 40)) {
    return 'Category is required for category-scoped keywords';
  }
  if (typeof action_type !== 'string' || !ACTION_TYPES.has(action_type)) return 'Invalid action type';
  if (typeof payload !== 'string' || !payload.trim()) return 'Payload is required';
  if (match_type === 'regex') {
    try { new RegExp(keyword.trim()); } catch { return 'Keyword is not a valid regular expression'; }
  }
  if (description !== undefined && description !== null && typeof description !== 'string') return 'Invalid description';
  if (typeof is_active !== 'boolean') return 'Invalid active flag';
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < -1000 || priority > 10000) return 'Invalid priority';
  return {
    keyword: keyword.trim(), match_type, scope,
    category: scope === 'category' ? (category as string).trim() : null,
    action_type, payload: payload.trim(),
    description: typeof description === 'string' && description.trim() ? description.trim() : null,
    is_active, priority, business_id: null,
  };
}

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request, METHODS);
}

export async function GET(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  const admin = await requirePlatformAdmin(request, { requiredRole: [...ROLES] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const { data, error } = await createServiceClient().from('bot_keywords').select(COLUMNS)
    .order('scope', { ascending: true }).order('priority', { ascending: false });
  if (error) return reply({ error: 'Could not load keywords' }, 500);
  return reply({ keywords: data || [] });
}

export async function POST(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  const admin = await requirePlatformAdmin(request, { requiredRole: [...ROLES] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const body = await readJsonObject(request);
  if (!body || 'id' in body) return reply({ error: 'Invalid request body' }, 400);
  const row = validateKeyword(body);
  if (typeof row === 'string') return reply({ error: row }, 400);

  const { data, error } = await createServiceClient().from('bot_keywords').insert(row).select(COLUMNS).single();
  if (error || !data) return reply({ error: 'Failed to create keyword' }, 500);
  const audit = await logAdminAudit({
    actorId: admin.userId, action: 'create_bot_keyword', entityType: 'bot_keyword', entityId: data.id,
    details: { keyword: data.keyword, scope: data.scope, category: data.category }, ipAddress: adminRequestIp(request),
  });
  return reply({ keyword: data, auditRecorded: !audit.error }, 201);
}

export async function PATCH(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  const admin = await requirePlatformAdmin(request, { requiredRole: [...ROLES] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const body = await readJsonObject(request);
  const id = body?.id;
  if (!body || typeof id !== 'string' || !UUID_RE.test(id)) return reply({ error: 'Invalid keyword ID' }, 400);

  const service = createServiceClient();
  const { data: before, error: readError } = await service.from('bot_keywords').select(COLUMNS).eq('id', id).maybeSingle();
  if (readError) return reply({ error: 'Could not read keyword' }, 500);
  if (!before) return reply({ error: 'Keyword not found' }, 404);

  const toggleOnly = Object.keys(body).length === 2 && typeof body.is_active === 'boolean';
  let update: Fields;
  if (toggleOnly) {
    update = { is_active: body.is_active };
  } else {
    if (!ADMIN_SCOPES.has(before.scope)) return reply({ error: 'Business keywords are managed by the business' }, 403);
    const row = validateKeyword(body);
    if (typeof row === 'string') return reply({ error: row }, 400);
    update = row;
  }

  // A full edit re-checks the scope in the write itself, so a row cannot switch scope underneath it.
  const scopes = toggleOnly ? ['system', 'category', 'business'] : [...ADMIN_SCOPES];
  const { data: saved, error } = await service.from('bot_keywords').update(update)
    .eq('id', id).in('scope', scopes).select(COLUMNS).maybeSingle();
  if (error) return reply({ error: 'Failed to save keyword' }, 500);
  if (!saved) return reply({ error: 'Keyword was not updated. Refresh and try again.' }, 409);

  const action = toggleOnly ? (saved.is_active ? 'activate_bot_keyword' : 'deactivate_bot_keyword') : 'update_bot_keyword';
  const audit = await logAdminAudit({
    actorId: admin.userId, action, entityType: 'bot_keyword', entityId: id,
    details: { keyword: saved.keyword, scope: saved.scope, before: toggleOnly ? { is_active: before.is_active } : before },
    ipAddress: adminRequestIp(request),
  });
  return reply({ keyword: saved, auditRecorded: !audit.error });
}

export async function DELETE(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  const admin = await requirePlatformAdmin(request, { requiredRole: [...ROLES] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const body = await readJsonObject(request);
  const id = body?.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return reply({ error: 'Invalid keyword ID' }, 400);

  const service = createServiceClient();
  const { data: deleted, error } = await service.from('bot_keywords').delete()
    .eq('id', id).in('scope', [...ADMIN_SCOPES]).select(COLUMNS).maybeSingle();
  if (error) return reply({ error: 'Failed to delete keyword' }, 500);
  if (!deleted) {
    const { data: current } = await service.from('bot_keywords').select('id, scope').eq('id', id).maybeSingle();
    if (current) return reply({ error: 'Business keywords are managed by the business' }, 403);
    return reply({ error: 'Keyword not found' }, 404);
  }
  const audit = await logAdminAudit({
    actorId: admin.userId, action: 'delete_bot_keyword', entityType: 'bot_keyword', entityId: id,
    details: { deleted }, ipAddress: adminRequestIp(request),
  });
  return reply({ deleted: 1, auditRecorded: !audit.error });
}
