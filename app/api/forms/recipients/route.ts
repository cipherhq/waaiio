import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { listOptedInContacts, listRecentChats } from '@/lib/forms/opted-in-contacts';

/**
 * GET /api/forms/recipients?businessId= — people for the Forms send picker (owner only):
 * `contacts` (opted in) and, separately, `recentChats` (messaged this business's
 * sending channel in the last 24 hours, so they can get a form as text now).
 */
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

  const service = createServiceClient();
  let result: Awaited<ReturnType<typeof listOptedInContacts>>;
  try {
    result = await listOptedInContacts(service, businessId);
  } catch (err) {
    logger.warn('[FORMS] Opted-in contacts unavailable:', (err as Error).message);
    return NextResponse.json({ error: 'Could not load opted-in contacts' }, { status: 503 });
  }
  // Same channel the send route uses, so the list matches who can be sent to.
  let recent;
  try {
    const resolved = await new ChannelResolver(service).resolveByBusinessId(businessId);
    const list = await listRecentChats(service, businessId, resolved?.channel);
    recent = { recentChats: list.recentChats, recentChatsTruncated: list.truncated };
  } catch (err) {
    // The opted-in list is still useful; say the other list could not be loaded.
    logger.warn('[FORMS] Recent chats unavailable:', (err as Error).message);
    recent = { recentChats: [], recentChatsTruncated: false, recentChatsUnavailable: true };
  }
  return NextResponse.json({ ...result, ...recent }, { headers: { 'Cache-Control': 'no-store' } });
}
