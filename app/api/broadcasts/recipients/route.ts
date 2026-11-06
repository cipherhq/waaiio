import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { listOptedInContacts } from '@/lib/forms/opted-in-contacts';
import { phoneDigits, type EligibleContact } from '@/lib/broadcasts/audience-filter';

/**
 * GET /api/broadcasts/recipients?businessId= — who the Broadcasts page may offer
 * (owner only): people whose latest WhatsApp consent for this business is granted
 * for marketing, unexpired, and who have not opted out. That is the exact rule
 * /api/broadcasts/send, /api/broadcasts/schedule and the scheduled-broadcasts cron
 * apply (hasRecipientPermission(..., 'marketing')); they still re-check everyone.
 * Broadcasts have no "messaged you in the last 24 hours" route, so neither does this list.
 * Profile details are attached only so the page can narrow the list with its filters.
 */
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponseAsync(getRateLimitKey(request, 'broadcast-recipients'), 30, 60_000);
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
  try {
    const { contacts, truncated } = await listOptedInContacts(service, businessId, Date.now(), 'marketing');
    const profiles = new Map<string, { name: string | null; tags: string[] | null; total_spent: number | string | null; last_seen_at: string | null }>();
    for (let i = 0; i < contacts.length; i += 50) {
      const variants = contacts.slice(i, i + 50).flatMap(c => [phoneDigits(c.phone), c.phone]);
      const { data, error } = await service.from('customer_profiles')
        .select('phone, name, tags, total_spent, last_seen_at')
        .eq('business_id', businessId).in('phone', variants);
      // The page's filters depend on these details, so do not guess without them.
      if (error) throw new Error('Customer profiles could not be loaded.');
      for (const row of data || []) {
        const d = phoneDigits(row.phone);
        if (!profiles.has(d)) profiles.set(d, row);
      }
    }
    const recipients: EligibleContact[] = contacts.map(c => {
      const p = profiles.get(phoneDigits(c.phone));
      return {
        phone: c.phone,
        name: p?.name || c.name || null,
        tags: Array.isArray(p?.tags) ? p.tags : [],
        total_spent: p?.total_spent == null ? null : Number(p.total_spent),
        last_seen_at: p?.last_seen_at ?? null,
      };
    });
    return NextResponse.json({ recipients, truncated }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    logger.warn('[BROADCAST] Opted-in recipients unavailable:', (err as Error).message);
    return NextResponse.json({ error: 'Could not load who has opted in' }, { status: 503 });
  }
}
