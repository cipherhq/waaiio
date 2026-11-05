import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveBusinessChannel } from '@/app/m/resolve';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/whatsapp/direct-link?business_id=...
 *
 * The business's direct wa.me link, for display on the dashboard only. Uses
 * the same server-side readiness check as the public /m/ links, so it is only
 * returned when that link would actually open the business's chat. The link
 * merchants are asked to share stays the Waaiio /m/ link.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });

  const businessId = request.nextUrl.searchParams.get('business_id');
  if (!businessId) return NextResponse.json({ error: 'Missing business_id' }, { status: 400, headers: NO_STORE });

  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .maybeSingle();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404, headers: NO_STORE });

  const resolved = await resolveBusinessChannel(biz.id);
  const link = resolved instanceof NextResponse ? null : resolved.verifiedLink ?? null;
  return NextResponse.json({ link }, { headers: NO_STORE });
}
