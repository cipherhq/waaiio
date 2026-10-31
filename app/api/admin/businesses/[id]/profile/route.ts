import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminCorsHeaders } from '@/lib/admin-cors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = ['name', 'category', 'city'] as const;
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin')) });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const headers = { ...adminCorsHeaders(request.headers.get('origin')), 'Cache-Control': 'private, no-store' };
  const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
  try {
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) return reply({ error: 'Unauthorized' }, 403);
    const { id } = await params;
    if (!UUID.test(id)) return reply({ error: 'Invalid business ID' }, 400);
    let body;
    try { body = await request.json(); } catch { return reply({ error: 'Invalid request body' }, 400); }
    if (!body || Array.isArray(body) || typeof body !== 'object' ||
        Object.keys(body).some(key => !['field', 'value'].includes(key)) ||
        !FIELDS.includes(body.field) || typeof body.value !== 'string') {
      return reply({ error: 'Invalid profile update' }, 400);
    }
    const field = body.field as typeof FIELDS[number];
    const value = body.value.trim();
    if ((field === 'name' && (!value || [...value].length > 200)) ||
        (field === 'city' && [...value].length > 50)) {
      return reply({ error: 'Invalid profile value' }, 400);
    }
    const service = createServiceClient();
    if (field === 'category') {
      // The live catalog includes active legacy categories absent from UI constants.
      const { data: category, error: categoryError } = await service.from('category_templates')
        .select('key').eq('key', value).eq('is_active', true).maybeSingle();
      if (categoryError) return reply({ error: 'Category configuration unavailable' }, 503);
      if (!category) return reply({ error: 'Invalid profile value' }, 400);
    }
    const { data: before, error: readError } = await service.from('businesses')
      .select('id, name, category, city').eq('id', id).maybeSingle();
    if (readError) return reply({ error: 'Could not read business' }, 500);
    if (!before) return reply({ error: 'Business not found' }, 404);
    let update = service.from('businesses').update({ [field]: value }).eq('id', id);
    // Do not overwrite a concurrent edit made after the authoritative read.
    update = before[field] === null ? update.is(field, null) : update.eq(field, before[field]);
    const { data: saved, error } = await update.select('id, name, category, city').maybeSingle();
    if (error) return reply({ error: 'Failed to update business' }, 500);
    if (!saved || saved.id !== id) return reply({ error: 'Business changed. Refresh and try again.' }, 409);
    const audit = await logAdminAudit({
      actorId: admin.userId, action: 'edit_business_field', entityType: 'business', entityId: id,
      details: { field, previous_value: before[field], new_value: saved[field], business_name: saved.name },
      ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    });
    return reply({ business: { id: saved.id, [field]: saved[field] }, auditRecorded: !audit.error });
  } catch {
    return reply({ error: 'Unable to confirm update. Refresh before retrying.' }, 500);
  }
}
