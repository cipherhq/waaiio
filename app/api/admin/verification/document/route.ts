import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { createServiceClient } from '@/lib/supabase/service';
import { signVerificationDocument } from '@/lib/verification/documents';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: adminCorsHeaders(request.headers.get('origin'), 'GET, OPTIONS') });
}
export async function GET(request: NextRequest) {
  const headers = { ...adminCorsHeaders(request.headers.get('origin'), 'GET, OPTIONS'), 'Cache-Control': 'private, no-store' };
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers });
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Document required' }, { status: 400, headers });
  const service = createServiceClient();
  const { data: doc } = await service.from('business_documents').select('business_id, file_url').eq('id', id).maybeSingle();
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404, headers });
  try { return NextResponse.json({ url: await signVerificationDocument(service, doc) }, { headers }); }
  catch { return NextResponse.json({ error: 'Document unavailable' }, { status: 404, headers }); }
}
