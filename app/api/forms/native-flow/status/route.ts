import { NextRequest, NextResponse } from 'next/server';
import { ownedNativeForm } from '@/lib/whatsapp-forms/owner-access';
import { nativeFormsEnabled } from '@/lib/whatsapp-forms/release-gate';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { loadCurrentPublication } from '@/lib/whatsapp-forms/runtime';
export async function GET(request: NextRequest) {
  const access = await ownedNativeForm(request.nextUrl.searchParams.get('businessId'), request.nextUrl.searchParams.get('formId'));
  if (access.response) return access.response;
  if (!nativeFormsEnabled()) return NextResponse.json({ enabled: false, published: false });
  try {
    const db = createServiceClient({ noStore: true });
    const resolved = await new ChannelResolver(db).resolveByBusinessId(access.businessId);
    const publication = resolved && await loadCurrentPublication(db, access.formId, access.businessId, resolved);
    return NextResponse.json({ enabled: true, published: !!publication, token: publication ? access.form.token : null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: 'Status unavailable.' }, { status: 503 }); }
}
