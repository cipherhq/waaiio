import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const resolver = new ChannelResolver(supabase);
  let expired = 0;

  // Find quotes that are 'quoted' and past their expiry
  // Use expires_at if set, otherwise default to 7 days after created_at
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: expiredQuotes, error } = await supabase
    .from('quote_requests')
    .select(`
      id, customer_phone, customer_name, business_id, expires_at, created_at,
      businesses:business_id (name)
    `)
    .eq('status', 'quoted')
    .limit(500);

  if (error) {
    logger.error('[QUOTE-EXPIRY-CRON] Query error:', error.message);
    return NextResponse.json({ ok: false, error: 'Query failed' }, { status: 500 });
  }

  // Filter to quotes that are actually expired
  const now = new Date();
  const toExpire = (expiredQuotes || []).filter((q) => {
    if (q.expires_at) {
      return new Date(q.expires_at) <= now;
    }
    return new Date(q.created_at) <= new Date(sevenDaysAgo);
  });

  if (toExpire.length === 0) {
    return NextResponse.json({ ok: true, summary: 'No quotes to expire', expired: 0 });
  }

  // Batch update status to expired
  const ids = toExpire.map((q) => q.id);
  const { error: updateError } = await supabase
    .from('quote_requests')
    .update({ status: 'expired' })
    .in('id', ids);

  if (updateError) {
    logger.error('[QUOTE-EXPIRY-CRON] Update error:', updateError.message);
    return NextResponse.json({ ok: false, error: 'Update failed' }, { status: 500 });
  }

  // Send WhatsApp notifications to customers
  for (const quote of toExpire) {
    if (!quote.customer_phone) continue;

    const bizName = (quote.businesses as unknown as { name: string } | null)?.name || 'the business';
    const msg = `Your quote from ${bizName} has expired. If you're still interested, please reach out to get an updated price.`;

    try {
      const resolved = await resolver.resolveByBusinessId(quote.business_id);
      if (resolved) {
        await resolved.sender.sendText({ to: quote.customer_phone, text: msg });
        expired++;
      }
    } catch (err) {
      logger.error(`[QUOTE-EXPIRY-CRON] WhatsApp send failed for quote ${quote.id}:`, err);
    }
  }

  const summary = `Expired ${ids.length} quotes, notified ${expired} customers`;
  logger.debug(`[QUOTE-EXPIRY-CRON] ${summary}`);

  return NextResponse.json({ ok: true, summary, expired: ids.length, notified: expired });
}
