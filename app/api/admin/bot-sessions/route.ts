/**
 * POST /api/admin/bot-sessions — the admin Bot Management actions (#1108 X2).
 *
 *   { action: 'end', session_id }            end one active session
 *   { action: 'end_all', business_id }       end every active session of a business
 *   { action: 'block', business_id, phone }  block a phone for that business and end its sessions
 *
 * The browser client can read bot_sessions (admin_select_bot_sessions, M012) but has
 * no UPDATE right, so the page's direct writes matched 0 rows and still said done.
 * Ending a session only sets is_active = false, the same as the page always meant.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminPreflight, adminRequestIp, adminResponder, readJsonObject, UUID_RE } from '@/lib/admin-route';

// blocked_phones.phone is VARCHAR(30) (M194); bot sessions store digits with an optional +.
const PHONE_RE = /^\+?[0-9]{6,20}$/;

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request);
}

export async function POST(request: NextRequest) {
  const reply = adminResponder(request);
  // The page offers these actions to full admins only (canMutate = isFullAdmin).
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const body = await readJsonObject(request);
  if (!body) return reply({ error: 'Invalid request body' }, 400);

  const service = createServiceClient();
  const ip = adminRequestIp(request);

  if (body.action === 'end') {
    const id = body.session_id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return reply({ error: 'Invalid session ID' }, 400);
    const { data: saved, error } = await service.from('bot_sessions').update({ is_active: false })
      .eq('id', id).eq('is_active', true).select('id, business_id, whatsapp_number').maybeSingle();
    if (error) return reply({ error: 'Failed to end session' }, 500);
    if (!saved) {
      const { data: current, error: readError } = await service.from('bot_sessions').select('id, is_active').eq('id', id).maybeSingle();
      if (readError) return reply({ error: 'Could not confirm the session. Refresh and check it.' }, 500);
      if (!current) return reply({ error: 'Session not found' }, 404);
      return reply({ error: 'Session has already ended.' }, 409);
    }
    const audit = await logAdminAudit({
      actorId: admin.userId, action: 'kill_bot_session', entityType: 'bot_session', entityId: id,
      details: { business_id: saved.business_id, phone: saved.whatsapp_number }, ipAddress: ip,
    });
    return reply({ ended: 1, auditRecorded: !audit.error });
  }

  const businessId = body.business_id;
  if (typeof businessId !== 'string' || !UUID_RE.test(businessId)) return reply({ error: 'Invalid business ID' }, 400);
  const { data: business, error: businessError } = await service.from('businesses').select('id, name').eq('id', businessId).maybeSingle();
  if (businessError) return reply({ error: 'Could not read business' }, 500);
  if (!business) return reply({ error: 'Business not found' }, 404);

  if (body.action === 'end_all') {
    const { data: ended, error } = await service.from('bot_sessions').update({ is_active: false })
      .eq('business_id', businessId).eq('is_active', true).select('id');
    if (error) return reply({ error: 'Failed to end sessions' }, 500);
    const count = (ended || []).length;
    const audit = await logAdminAudit({
      actorId: admin.userId, action: 'kill_all_bot_sessions', entityType: 'business', entityId: businessId,
      details: { business_name: business.name, sessions_ended: count }, ipAddress: ip,
    });
    return reply({ ended: count, auditRecorded: !audit.error });
  }

  if (body.action === 'block') {
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!PHONE_RE.test(phone)) return reply({ error: 'Invalid phone number' }, 400);
    const { error: blockError } = await service.from('blocked_phones').upsert({
      business_id: businessId, phone, blocked_by: admin.userId, reason: 'Blocked by admin',
    }, { onConflict: 'business_id,phone' });
    if (blockError) return reply({ error: 'Failed to block phone' }, 500);
    const { data: ended, error } = await service.from('bot_sessions').update({ is_active: false })
      .eq('business_id', businessId).eq('whatsapp_number', phone).eq('is_active', true).select('id');
    // The block is saved; say so even when ending the sessions failed.
    if (error) return reply({ error: 'Phone blocked, but its active sessions could not be ended. Retry End session.', blocked: true }, 500);
    const count = (ended || []).length;
    const audit = await logAdminAudit({
      actorId: admin.userId, action: 'block_phone', entityType: 'business', entityId: businessId,
      details: { business_name: business.name, phone, sessions_ended: count }, ipAddress: ip,
    });
    return reply({ blocked: true, ended: count, auditRecorded: !audit.error });
  }

  return reply({ error: 'Invalid action' }, 400);
}
