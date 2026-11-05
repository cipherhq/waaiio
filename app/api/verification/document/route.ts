import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { signVerificationDocument } from '@/lib/verification/documents';

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Document required' }, { status: 400 });
  const { data: doc } = await supabase.from('business_documents').select('business_id, file_url').eq('id', id).maybeSingle();
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  const { data: business } = await supabase.from('businesses').select('id').eq('id', doc.business_id).eq('owner_id', user.id).maybeSingle();
  if (!business) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const url = await signVerificationDocument(createServiceClient(), doc);
    return NextResponse.redirect(url, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch { return NextResponse.json({ error: 'Document unavailable' }, { status: 404 }); }
}
