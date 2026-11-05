import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { listOptedInContacts } from '@/lib/forms/opted-in-contacts';

/** GET /api/forms/recipients?businessId= — opted-in contacts for the Forms send picker (owner only). */
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponseAsync(getRateLimitKey(request, 'form-recipients'), 30, 60_000);
  if (limited) return limited;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const businessId = request.nextUrl.searchParams.get('businessId');
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  const { data: biz } = await supabase.from('businesses').select('id')
    .eq('id', businessId).eq('owner_id', user.id).maybeSingle();
  if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const result = await listOptedInContacts(createServiceClient(), businessId);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    logger.warn('[FORMS] Opted-in contacts unavailable:', (err as Error).message);
    return NextResponse.json({ error: 'Could not load opted-in contacts' }, { status: 503 });
  }
}
