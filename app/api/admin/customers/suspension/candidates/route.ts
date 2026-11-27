import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { canonicalCustomerPhone } from '@/lib/customer-suspension';
import { customerEmailCandidates } from '@/lib/customer-email-candidates';

/**
 * GET ?phone=<canonical>&userId=<uuid> — the emails an admin may tick when
 * blocking this customer (#1166 F2). Admin only: it serves the block and
 * unblock dialogs, which only admins open. Reads only.
 */

export const dynamic = 'force-dynamic';

const METHODS = 'GET, OPTIONS';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), METHODS) });
}

export async function GET(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'), METHODS);
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const params = request.nextUrl.searchParams;
  const phone = params.get('phone') || null;
  const userId = params.get('userId') || null;
  if (phone !== null && canonicalCustomerPhone(phone) !== phone) {
    return NextResponse.json({ error: 'phone must be the canonical number' }, { status: 400, headers: cors });
  }
  if (userId !== null && !UUID.test(userId)) {
    return NextResponse.json({ error: 'userId must be a uuid' }, { status: 400, headers: cors });
  }
  if (!phone && !userId) {
    return NextResponse.json({ error: 'phone or userId is required' }, { status: 400, headers: cors });
  }

  try {
    const candidates = await customerEmailCandidates(createServiceClient(), { phone, userId });
    return NextResponse.json({ candidates }, { headers: cors });
  } catch {
    return NextResponse.json({ error: 'Unable to load this customer’s emails' }, { status: 500, headers: cors });
  }
}
