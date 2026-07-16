import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'quote-reject'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body, businessIdKey: 'business_id' });
    if (auth instanceof NextResponse) return auth;

    const { quote_id, business_id, quote_notes } = body;

    if (!quote_id || !business_id) {
      return NextResponse.json({ error: 'quote_id and business_id required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Validate quote exists and belongs to business
    const { data: quote, error: quoteError } = await supabase
      .from('quote_requests')
      .select('id, customer_phone, customer_name, status, business_id')
      .eq('id', quote_id)
      .eq('business_id', business_id)
      .single();

    if (quoteError || !quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
    }

    if (quote.status !== 'pending') {
      return NextResponse.json({ error: `Quote is already ${quote.status}` }, { status: 400 });
    }

    // Update quote status to rejected
    await supabase
      .from('quote_requests')
      .update({
        status: 'rejected',
        quote_notes: quote_notes || null,
      })
      .eq('id', quote_id);

    // Get business info for notification
    const { data: biz } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', business_id)
      .single();

    // Notify customer via WhatsApp
    if (quote.customer_phone) {
      try {
        const resolver = new ChannelResolver(supabase);
        const resolved = await resolver.resolveByBusinessId(business_id);
        if (!resolved?.sender) {
          logger.warn('[QUOTE-REJECT] No messaging channel configured for business', business_id);
          return NextResponse.json({ success: true });
        }
        const sender = resolved.sender;

        const phone = quote.customer_phone.startsWith('+')
          ? quote.customer_phone.slice(1)
          : quote.customer_phone;

        const lines = [
          `Hi ${quote.customer_name || 'there'},`,
          '',
          `We're sorry, but *${biz?.name || 'the business'}* is unable to fulfill your price request at this time.`,
        ];

        if (quote_notes) {
          lines.push('', `_${quote_notes}_`);
        }

        lines.push('', 'Feel free to reach out again if you need anything else.');

        await sender.sendText({ to: phone, text: lines.join('\n') });
      } catch (err) {
        logger.error('[QUOTE-REJECT] WhatsApp notification error:', err);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[QUOTE-REJECT] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
